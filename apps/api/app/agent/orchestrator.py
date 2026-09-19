from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime

from pydantic import ValidationError

from app.agent.executor import Executor, invalid_task, reachable
from app.agent.llm import LLMReviewer
from app.agent.planner import Proposal, propose, replan_needed
from app.domain.intake import prepare_intake_tasks
from app.domain.models import (
    ActionKind,
    ActionStatus,
    AgentMode,
    Decision,
    Event,
    Observation,
    Receipt,
    TaskStatus,
    now,
)
from app.domain.observations import apply_observation
from app.domain.state import WorldState
from app.store.persistence import Store, StoreError, VersionConflict

log = logging.getLogger(__name__)


class Orchestrator:
    def __init__(
        self,
        state: WorldState,
        executor: Executor,
        store: Store,
        reviewer: LLMReviewer,
        tick_seconds: float = 10,
        poll_seconds: float = 2,
        batch_size: int = 100,
    ) -> None:
        self.state, self.executor, self.store, self.reviewer = state, executor, store, reviewer
        self.tick_seconds, self.poll_seconds, self.batch_size = (
            tick_seconds,
            poll_seconds,
            batch_size,
        )
        self._task: asyncio.Task[None] | None = None
        self._tick_lock = asyncio.Lock()
        self._autoplan = False

    @property
    def incident_id(self) -> str:
        if self.state.incident is None:
            raise StoreError("inicializa un incidente antes de operar")
        return self.state.incident.id

    def start(self, autoplan: bool = True) -> None:
        self._autoplan = autoplan
        if self._task is None:
            self._task = asyncio.create_task(self._loop(), name="store-sync")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _loop(self) -> None:
        last_tick = 0.0
        while True:
            try:
                if self.state.incident:
                    await self.synchronize()
                if (
                    self.state.incident
                    and self._autoplan
                    and (time.monotonic() - last_tick >= self.tick_seconds)
                ):
                    await self.tick("timer")
                    last_tick = time.monotonic()
                elif self.state.incident and self._autoplan:
                    await self.dispatch_pending()
            except Exception:  # noqa: BLE001
                log.exception("sincronización/orquestación falló; no se despacha")
            await asyncio.sleep(self.poll_seconds)

    async def _commit(
        self,
        candidate: WorldState,
        receipts: list[Receipt] | None = None,
        *,
        require_synced: bool = False,
    ) -> None:
        expected = candidate.version
        owners: dict[str, str] = {}
        for task in candidate.tasks.values():
            if task.status in (
                TaskStatus.cancelled,
                TaskStatus.done,
                TaskStatus.failed,
                TaskStatus.rejected,
            ):
                continue
            for rid in task.resource_ids:
                if rid in owners and owners[rid] != task.id:
                    raise ValueError("dos tareas reservan la misma unidad")
                owners[rid] = task.id
                if candidate.resources[rid].assigned_task_id != task.id:
                    raise ValueError("reserva inconsistente")
        candidate.version = expected + 1
        candidate.integrations["storage"] = True
        try:
            await self.store.save(
                candidate.snapshot(full=True),
                expected,
                receipts or [],
                require_synced=require_synced,
            )
        except VersionConflict:
            raise
        except StoreError:
            self.state.set_integration("storage", False)
            raise
        self.state.restore(candidate.snapshot(full=True), emit=True)

    async def synchronize(self) -> None:
        async with self._tick_lock:
            await self._synchronize()

    async def _synchronize(self) -> None:
        try:
            latest = await self.store.load(self.incident_id)
            if latest is None:
                raise StoreError("el snapshot del incidente no existe")
            if latest.version != self.state.version:
                self.state.restore(latest, emit=True)
                self.tick_seconds = latest.agent.tick_seconds
            for _ in range(20):
                rows = await self.store.pending(self.incident_id, self.batch_size)
                if not rows:
                    self.state.last_synced_at = now()
                    self.state.integrations["storage"] = True
                    return
                candidate = self.state.copy()
                receipts = []
                for row in rows:
                    working = candidate.copy()
                    try:
                        obs = Observation.model_validate(row.body)
                        if obs.observation_id != row.observation_id:
                            raise ValueError("observation_id no coincide con la fila")
                        receipt = apply_observation(working, obs)
                        candidate = working
                    except (ValidationError, ValueError, TypeError, KeyError) as exc:
                        reason = (
                            "payload/esquema inválido"
                            if isinstance(exc, ValidationError)
                            else str(exc)[:200]
                        )
                        receipt = Receipt(
                            observation_id=row.observation_id, status="invalid", reason=reason
                        )
                    receipts.append(receipt)
                candidate.last_synced_at = now()
                await self._commit(candidate, receipts)
            raise StoreError(
                "entrada pendiente: se aplaza el despacho hasta completar sincronización"
            )
        except VersionConflict:
            raise
        except StoreError:
            self.state.set_integration("storage", False)
            raise

    @asynccontextmanager
    async def edit(self) -> AsyncIterator[WorldState]:
        async with self._tick_lock:
            await self._synchronize()
            candidate = self.state.copy()
            yield candidate
            await self._commit(candidate)

    async def ingest(self, observation: Observation) -> None:
        if observation.incident_id != self.incident_id:
            raise ValueError("incident_id no coincide con el incidente activo")
        await self.store.observe(observation)

    async def ingest_event(self, event: Event) -> Event:
        await self.ingest(
            Observation(
                observation_id=event.id,
                incident_id=self.incident_id,
                observed_at=event.ts,
                source=event.source,
                kind=event.kind,
                title=event.title,
                severity=event.severity,
                zone_id=event.zone_id,
                payload=event.payload,
            )
        )
        await self.synchronize()
        return next((e for e in self.state.events if e.id == event.id), event)

    async def recover(self) -> None:
        async with self._tick_lock:
            candidate = self.state.copy()
            changed = False
            for report in candidate.incoming_calls.values():
                changed = prepare_intake_tasks(candidate, report) or changed
            for action in candidate.actions.values():
                if action.status == ActionStatus.sending:
                    action.status = ActionStatus.unknown
                    action.error = "reinicio durante el envío; verificar resultado con el proveedor"
                    changed = True
            if changed:
                await self._commit(candidate)

    async def tick(self, trigger: str = "manual") -> Decision:
        async with self._tick_lock:
            decision = await self._tick(trigger)
            await self._dispatch_pending()
            return decision

    async def _tick(self, trigger: str, attempt: int = 0) -> Decision:
        await self._synchronize()
        s = self.state.copy()
        if s.agent.mode == AgentMode.paused:
            return Decision(
                trigger=trigger, situation_summary="Agente pausado", priorities=[], actions_taken=[]
            )
        executor = self.executor.bind(s)
        new_events = s.unprocessed_events()
        facts = [fact for e in new_events for fact in s.event_facts.get(e.id, [])]
        replan_reason = replan_needed(s, facts)
        cancelled = []
        for task in s.open_tasks():
            reason = invalid_task(s, task)
            if reason:
                await executor.cancel_task(task, reason)
                cancelled.append(f"{task.title}: {reason}")
        if any("Viento" in f or "cortada" in f for f in facts):
            await executor.broadcast_signal(
                "crisis.update", {"facts": facts, "world_state_version": s.version + 1}
            )
        proposals = propose(s)
        waiting = [
            Proposal(t, t.resource_types, t.contact_roles)
            for t in s.tasks.values()
            if t.status == TaskStatus.proposed
        ]
        can_retry = any(
            executor._pick_resource(p, {})
            if p.wants_resource_types
            else any(c.role in p.contact_roles for c in s.contacts.values())
            for p in waiting
        )
        if not new_events and not proposals and not cancelled and s.decisions and not can_retry:
            return s.decisions[-1]
        review = await self.reviewer.review(
            s.snapshot(), new_events, proposals, await self.store.lessons_summary()
        )
        if await self.store.pending(self.incident_id, 1):
            if attempt >= 2:
                raise VersionConflict("nuevas observaciones durante la planificación; reintenta")
            return await self._tick("revalidated", attempt + 1)
        if review:
            adjustments = {a.index: a for a in review.tasks}
            kept = []
            for index, proposal in enumerate(proposals):
                adjustment = adjustments.get(index)
                if adjustment and adjustment.drop:
                    continue
                if adjustment:
                    proposal.task.priority = adjustment.priority
                    proposal.task.priority_reason = adjustment.reason
                    proposal.task.preferred_resource_id = adjustment.resource_id
                kept.append(proposal)
            proposals = sorted(kept, key=lambda p: -p.task.priority)
        decision = Decision(
            trigger=trigger,
            situation_summary=review.situation_summary
            if review
            else ("; ".join(facts[:4]) or "Plan de respuesta según amenazas y medios disponibles"),
            priorities=[],
            actions_taken=[],
            replan=bool(replan_reason),
            replan_reason=replan_reason,
            model=self.reviewer.model if review else "heuristic",
            raw={
                "based_on_version": s.version,
                "facts": facts,
                "next_action": review.next_action if review else "",
            },
        )
        judged = {j.event_id: j for j in review.events} if review else {}
        for event in new_events:
            judgement = judged.get(event.id)
            relevant = judgement.relevant if judgement else bool(s.event_facts.get(event.id))
            s.mark_event(
                event.id,
                relevant,
                judgement.reason
                if judgement
                else "cambia el estado"
                if relevant
                else "sin cambios",
            )
            s.event_facts.pop(event.id, None)
            if not relevant:
                decision.discarded_events.append(event.title)
        reliability = {c.id: c.reliability for c in s.contacts.values()}
        for proposal in sorted(proposals + waiting, key=lambda p: -p.task.priority):
            proposal.task.decision_id = decision.id
            await executor.execute(proposal, reliability)
            decision.actions_taken.append(f"{proposal.task.title} -> {proposal.task.status}")
        decision.actions_taken.extend(f"cancelada: {title}" for title in cancelled)
        decision.priorities = [f"{t.priority} {t.title}" for t in s.open_tasks()[:5]]
        s.add_decision(decision)
        await self._commit(s, require_synced=True)
        return decision

    async def approve(
        self,
        task_id: str,
        approved: bool,
        note: str = "",
        *,
        confirm_location: bool = False,
        expected_updated_at: datetime | None = None,
    ) -> None:
        async with self.edit() as s:
            task = s.tasks[task_id]
            if task.status != TaskStatus.awaiting_approval:
                raise ValueError("la tarea no está pendiente de aprobación")
            if task.incoming_call_id:
                if expected_updated_at != task.updated_at:
                    raise ValueError("la propuesta ha cambiado; revisa el estado actualizado")
                if approved and (not confirm_location or invalid_task(s, task)):
                    raise ValueError("confirma una ubicación válida antes de aprobar recursos")
            if not approved:
                task.status, task.outcome = TaskStatus.rejected, note or "Rechazada por operador"
            else:
                task.approved_at = now()
                task.status = TaskStatus.proposed
                task.outcome = note
                await self.executor.bind(s).execute(
                    Proposal(task, task.resource_types, task.contact_roles),
                    {c.id: c.reliability for c in s.contacts.values()},
                )
        await self.dispatch_pending()

    async def dispatch_pending(self) -> None:
        async with self._tick_lock:
            await self._dispatch_pending()

    async def _dispatch_pending(self) -> None:
        await self._synchronize()
        pending = sorted(
            (a for a in self.state.actions.values() if a.status == ActionStatus.pending),
            key=lambda a: (
                -self.state.tasks[a.task_id].priority if a.task_id in self.state.tasks else -100,
                a.ts,
            ),
        )
        ids = [a.id for a in pending]
        for aid in ids:
            await self._synchronize()
            if self.state.agent.mode != AgentMode.running:
                return
            s = self.state.copy()
            action = s.actions[aid]
            if not s.integrations.get("happyrobot", True):
                continue
            if action.status != ActionStatus.pending:
                continue
            if action.next_attempt_at and action.next_attempt_at > now():
                continue
            task = s.tasks.get(action.task_id or "")
            reason = ""
            if action.expires_at and action.expires_at <= now():
                if task:
                    await self.executor.bind(s).cancel_task(task, "orden expirada sin enviar")
                else:
                    action.status = ActionStatus.skipped
                    action.error = "orden expirada sin enviar"
                await self._commit(s)
                continue
            if task:
                reason = invalid_task(s, task)
                if task.status in (TaskStatus.cancelled, TaskStatus.done, TaskStatus.rejected):
                    reason = "tarea cerrada"
                if (
                    task.requires_approval or task.kind in s.agent.approval_required_for
                ) and not task.approved_at:
                    reason = "requiere aprobación"
                for rid in task.resource_ids:
                    resource = s.resources[rid]
                    if resource.assigned_task_id != task.id or not reachable(s, task, resource):
                        reason = "reserva/ruta no válida"
                if reason:
                    await self.executor.bind(s).cancel_task(task, reason)
                    await self._commit(s)
                    continue
                contact = s.contacts.get(action.contact_id or "")
                if contact and action.kind == ActionKind.call:
                    action.request.update(self.executor.bind(s)._briefing(task, contact))
            action.state_version = s.version + 1
            action.status = ActionStatus.sending
            action.attempts += 1
            await self._commit(s, require_synced=True)
            result_state = self.state.copy()
            await self.executor.bind(result_state).send(result_state.actions[aid])
            await self._commit(result_state)

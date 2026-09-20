from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import datetime, timedelta

from pydantic import ValidationError

from app.agent.executor import (
    NO_RESOURCE,
    Executor,
    invalid_task,
    location_pending,
    reachable,
)
from app.agent.llm import LLMReviewer, Review
from app.agent.planner import Proposal, propose, replan_needed
from app.domain.intake import prepare_intake_tasks
from app.domain.models import (
    ActionKind,
    ActionStatus,
    AgentMode,
    CoordinationAction,
    CoordinationAnswer,
    CoordinationQuestion,
    CoordinationQuestionIn,
    CoordinationResolution,
    Decision,
    Event,
    EventKind,
    EventSource,
    Location,
    Observation,
    Receipt,
    Resource,
    ResourceStatus,
    Severity,
    TaskStatus,
    now,
)
from app.domain.movement import advance
from app.domain.observations import apply_observation
from app.domain.state import WorldState
from app.store.persistence import Store, StoreError, VersionConflict

log = logging.getLogger(__name__)


def _review_signature(events: list[Event], proposals: list[Proposal]) -> tuple[str, ...]:
    """Identifica el contexto que juzgó el LLM: eventos y propuestas por posición."""
    return tuple(
        [f"e:{e.id}" for e in events]
        + [f"p:{i}:{p.task.kind}:{p.task.title}" for i, p in enumerate(proposals)]
    )


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
        # Localización de avisos sin GPS; la inyecta el runtime, que es quien tiene el
        # proveedor y sus guardas de concurrencia.
        self.locate: Callable[[str, datetime], Awaitable[object]] | None = None

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
                    await self.resolve_due_questions()
                    await self.locate_pending_reports()
                    await self.reconcile_intake()
                    await self.escalate_stale_approvals()
                    await self.advance_missions()
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

    async def _tick(
        self,
        trigger: str,
        attempt: int = 0,
        cached: tuple[tuple[str, ...], Review] | None = None,
    ) -> Decision:
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
            if location_pending(s, task):
                continue
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
        # El review es la parte lenta del tick (decenas de segundos). Si al revalidar el
        # contexto que juzgó el LLM no ha cambiado, se reutiliza en vez de volver a pagarlo.
        signature = _review_signature(new_events, proposals)
        review = (
            cached[1]
            if cached and cached[0] == signature
            else await self.reviewer.review(
                s.snapshot(), new_events, proposals, await self.store.lessons_summary()
            )
        )
        if await self.store.pending(self.incident_id, 1):
            # Un solo reintento: cada uno puede costar otro review completo.
            if attempt >= 1:
                raise VersionConflict("nuevas observaciones durante la planificación; reintenta")
            return await self._tick(
                "revalidated", attempt + 1, (signature, review) if review else None
            )
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

    def _stale_intake_tasks(self, state: WorldState) -> list[str]:
        return [
            task.id
            for task in state.open_tasks()
            if task.incoming_call_id
            and not location_pending(state, task)
            and invalid_task(state, task)
        ]

    async def reconcile_intake(self) -> None:
        """Pone al día las misiones de un aviso: cancela lo inválido y prepara lo nuevo.

        Solo construye la orden; enviarla es cosa de `dispatch_pending`, que respeta la
        ventana para anular y la parada de emergencia.
        """
        stale = self._stale_intake_tasks(self.state)
        # Solo se abre una transacción por lo que cambia. Una misión sin medio libre seguiría
        # entrando aquí en cada ciclo y, al commitear sin cambios, escribiría en la base y
        # refrescaría el dashboard cada dos segundos para siempre. La espera se explica una
        # vez y después se calla hasta que algo se mueva.
        idle = self.executor.bind(self.state)
        ready: list[str] = []
        stalled: list[str] = []
        for waiting in self.state.tasks.values():
            if not (
                waiting.autonomous
                and waiting.status == TaskStatus.proposed
                and not waiting.action_ids
            ):
                continue
            if idle.can_progress(waiting):
                ready.append(waiting.id)
            elif not location_pending(self.state, waiting) and waiting.outcome != NO_RESOURCE:
                stalled.append(waiting.id)
        if not stale and not ready and not stalled:
            return
        async with self.edit() as s:
            executor = self.executor.bind(s)
            for task_id in self._stale_intake_tasks(s):
                await executor.cancel_task(s.tasks[task_id], invalid_task(s, s.tasks[task_id]))
            reliability = {c.id: c.reliability for c in s.contacts.values()}
            for task_id in stalled + sorted(ready, key=lambda i: -s.tasks[i].priority):
                task = s.tasks.get(task_id)
                if not task or task.status != TaskStatus.proposed or task.action_ids:
                    continue
                if task_id in stalled:
                    task.outcome = NO_RESOURCE
                    s.upsert_task(task)
                    continue
                await executor.execute(
                    Proposal(task, task.resource_types, task.contact_roles), reliability
                )

    def _mission_target(self, state: WorldState, resource: Resource) -> Location | None:
        task = state.tasks.get(resource.assigned_task_id or "")
        if not task or task.status in (TaskStatus.done, TaskStatus.cancelled, TaskStatus.failed):
            return None
        destination = state.zones.get(task.zone_id or "") or state.fronts.get(task.zone_id or "")
        return task.target_location or (destination.location if destination else None)

    async def advance_missions(self) -> None:
        """Acerca a su destino las unidades que aceptaron la llamada.

        La posición es una estimación por tiempo transcurrido, nunca GPS, y solo se mueve lo
        que está `en_route`: una orden enviada no significa que nadie se haya puesto en marcha.
        """
        moving = [
            resource.id
            for resource in self.state.resources.values()
            if resource.status == ResourceStatus.en_route
            and self._mission_target(self.state, resource) is not None
        ]
        if not moving:
            return
        at = now()
        candidate = self.state.copy()
        changed = False
        for resource_id in moving:
            resource = candidate.resources[resource_id]
            target = self._mission_target(candidate, resource)
            if target and advance(resource, target, at):
                candidate.upsert_resource(resource)
                changed = True
        if changed:
            await self._commit(candidate)

    async def locate_pending_reports(self) -> None:
        """Resuelve la ubicación de los avisos sin GPS que aún no se han intentado.

        Fuera de la petición del webhook: el workflow que atiende al ciudadano no debe
        esperar a un proveedor externo. Un fallo del proveedor no descarta el aviso.
        """
        if not self.locate:
            return
        for report in list(self.state.incoming_calls.values()):
            if report.location.lat is not None or report.resolution.status != "not_requested":
                continue
            try:
                await self.locate(report.run_id, report.timestamp)
            except (ValueError, KeyError) as exc:
                log.info("no se pudo localizar el aviso %s: %s", report.run_id, exc)

    async def escalate_stale_approvals(self) -> None:
        """Una decisión crítica sin confirmar no se despacha sola, pero tampoco se calla.

        Avisa una sola vez por tarea. El aviso queda `dispatched` hasta que llegue la
        observación `message_outcome`: no se da por entregado antes.
        """
        limit = self.state.agent.escalate_after_seconds
        if limit <= 0:
            return
        deadline = now() - timedelta(seconds=limit)
        stale = [
            task.id
            for task in self.state.tasks.values()
            if task.status == TaskStatus.awaiting_approval
            and not task.escalated_at
            and task.updated_at <= deadline
        ]
        if not stale:
            return
        async with self.edit() as s:
            for task_id in stale:
                task = s.tasks.get(task_id)
                if not task or task.status != TaskStatus.awaiting_approval or task.escalated_at:
                    continue
                task.escalated_at = now()
                s.upsert_task(task)
                await self.executor.bind(s).message(
                    None,
                    f"Decisión crítica sin confirmar tras {limit:.0f} s: {task.title}. "
                    f"{task.priority_reason} Revísala en el panel de coordinación.",
                    task_id=task.id,
                )
                s.add_event(
                    Event(
                        source=EventSource.system,
                        kind=EventKind.note,
                        severity=Severity.high,
                        title=f"Escalado: decisión crítica sin confirmar ({task.title})",
                        payload={"task_id": task.id},
                    )
                )
        await self.dispatch_pending()

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
            if expected_updated_at is not None and expected_updated_at != task.updated_at:
                raise ValueError("la propuesta ha cambiado; revisa el estado actualizado")
            # Confirmar una ubicación solo tiene sentido sobre un aviso ciudadano; una
            # evacuación no tiene parte que revisar.
            if task.incoming_call_id:
                if expected_updated_at != task.updated_at:
                    raise ValueError("la propuesta ha cambiado; revisa el estado actualizado")
                if approved and (
                    not confirm_location or location_pending(s, task) or invalid_task(s, task)
                ):
                    raise ValueError("confirma una ubicación válida antes de aprobar recursos")
            if not approved:
                task.status, task.outcome = TaskStatus.rejected, note or "Rechazada por operador"
            else:
                task.approved_at = now()
                task.hold_until = None  # ya hay una decisión humana: no hay nada que retener
                task.status = TaskStatus.proposed
                task.outcome = note
                await self.executor.bind(s).execute(
                    Proposal(task, task.resource_types, task.contact_roles),
                    {c.id: c.reliability for c in s.contacts.values()},
                )
            s.upsert_task(task)
            s.add_event(
                Event(
                    source=EventSource.operator,
                    kind=EventKind.note,
                    title=f"{'Confirmada' if approved else 'Rechazada'}: {task.title}",
                    payload={"task_id": task.id, "summary": task.outcome or task.title},
                )
            )
        await self.dispatch_pending()

    async def create_question(self, body: CoordinationQuestionIn) -> CoordinationQuestion:
        fingerprint = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
        async with self.edit() as state:
            existing = state.coordination_questions.get(body.id)
            if existing:
                if existing.request_hash != fingerprint:
                    raise ValueError("identificador de pregunta reutilizado con otro contenido")
                return existing
            report = (
                state.incoming_calls.get(body.incident_id.removeprefix("call:"))
                if body.incident_id.startswith("call:")
                else None
            )
            target = state.zones.get(body.incident_id) or state.fronts.get(body.incident_id)
            if (
                not report
                and not target
                and body.incident_id not in state.roads
                and body.incident_id != self.incident_id
            ):
                raise ValueError("incidencia desconocida")
            rank = {"critical": 0, "high": 1, "moderate": 2}
            severity = (
                "critical"
                if report and report.severity == "vital"
                else "high"
                if report and report.severity == "grave"
                else str(getattr(target, "threat", getattr(target, "intensity", "moderate")))
            )
            urgency = min(
                (body.urgency, severity if severity in rank else "moderate"), key=rank.__getitem__
            )
            seconds = (
                body.timeout_seconds or {"critical": 60, "high": 120, "moderate": 300}[urgency]
            )
            received = now()
            question = CoordinationQuestion(
                **body.model_dump(by_alias=False, exclude={"expires_at", "urgency"}),
                urgency=urgency,
                received_at=received,
                expires_at=body.expires_at or received + timedelta(seconds=seconds),
                sequence=max((q.sequence for q in state.coordination_questions.values()), default=0)
                + 1,
                request_hash=fingerprint,
            )
            state.coordination_questions[question.id] = question
            state.add_event(
                Event(
                    source=EventSource.operator,
                    kind=EventKind.note,
                    title="Pregunta de coordinación",
                    severity=Severity.high,
                    payload={
                        "incident_id": question.incident_id,
                        "question_id": question.id,
                        "summary": question.prompt,
                        "log_kind": "question",
                    },
                )
            )
        return self.state.coordination_questions[body.id]

    def _question_action_problem(
        self, state: WorldState, question: CoordinationQuestion, action: CoordinationAction
    ) -> str:
        if action.type in ("none", "note"):
            return ""
        task = state.tasks.get(action.task_id or "")
        if (
            not task
            or task.status != action.expected_status
            or task.updated_at != action.expected_updated_at
        ):
            return "la tarea ha cambiado; revisa su estado actual"
        incident_id = (
            f"call:{task.incoming_call_id}"
            if task.incoming_call_id
            else task.zone_id or self.incident_id
        )
        if incident_id != question.incident_id:
            return "la tarea no pertenece a esta incidencia"
        if task.status in (
            TaskStatus.done,
            TaskStatus.cancelled,
            TaskStatus.failed,
            TaskStatus.rejected,
        ):
            return "la misión ya está cerrada"
        if action.type == "set-status":
            if action.status == "done" and task.status not in (
                TaskStatus.accepted,
                TaskStatus.in_progress,
            ):
                return "solo puede finalizarse una misión aceptada o en curso"
            return ""
        resource = state.resources.get(action.resource_id or "")
        current_task = state.tasks.get(resource.assigned_task_id or "") if resource else None
        current_incident = (
            f"call:{current_task.incoming_call_id}"
            if current_task and current_task.incoming_call_id
            else resource.assigned_zone_id
            if resource
            else None
        )
        if not resource or current_incident != action.expected_incident_id:
            return "la asignación del recurso ha cambiado"
        if resource.assigned_task_id or resource.status != "available":
            return "el recurso no está disponible; no se reasignan misiones activas"
        if task.resource_ids or task.status not in (
            TaskStatus.proposed,
            TaskStatus.awaiting_approval,
        ):
            return "la tarea ya tiene una orden o reserva"
        if (
            resource.type not in task.resource_types
            or not state.contact_for_resource(resource.id)
            or not reachable(state, task, resource)
        ):
            return "el recurso no es compatible o accesible"
        return invalid_task(state, task)

    async def answer_question(
        self, question_id: str, answer: CoordinationAnswer, *, timed_out: bool = False
    ) -> CoordinationQuestion:
        async with self.edit() as state:
            question = state.coordination_questions.get(question_id)
            if question is None:
                raise ValueError("pregunta desconocida")
            if question.status == "resolved":
                return question
            expired = now() >= question.expires_at
            if timed_out and not expired:
                return question
            chosen = question.default_answer if expired else answer
            if not question.accepts(chosen):
                raise ValueError("respuesta inválida para esta pregunta")
            actions = question.actions_for(chosen)
            targets = [f"task:{a.task_id}" for a in actions if a.type not in ("none", "note")]
            targets += [f"resource:{a.resource_id}" for a in actions if a.type == "assign-resource"]
            problem = (
                "acciones incompatibles sobre la misma tarea o recurso"
                if len(set(targets)) != len(targets)
                else next(
                    (
                        reason
                        for action in actions
                        if (reason := self._question_action_problem(state, question, action))
                    ),
                    "",
                )
            )
            label = (
                chosen.text
                if chosen.custom
                else ", ".join(
                    option.label for option in question.options if option.id in chosen.option_ids
                )
            )
            results = []
            if not problem:
                executor = self.executor.bind(state)
                for action in actions:
                    if action.type == "set-status":
                        task = state.tasks[action.task_id or ""]
                        if action.status == "cancelled":
                            await executor.cancel_task(task, label)
                        else:
                            executor.complete_task(task, label)
                        results.append(f"{task.title}: {task.status}")
                    elif action.type == "assign-resource":
                        task = state.tasks[action.task_id or ""]
                        resource = state.resources[action.resource_id or ""]
                        contact = state.contact_for_resource(resource.id)
                        task.preferred_resource_id = resource.id
                        task.assignee_contact_id = contact.id if contact else None
                        await executor.execute(
                            Proposal(task, task.resource_types, task.contact_roles), {}
                        )
                        state.upsert_task(task)
                        results.append(
                            f"{task.title}: {task.status}; recurso solicitado {resource.name}"
                        )
                    elif action.type == "note":
                        results.append(
                            "Instrucción registrada; no implica una comunicación enviada."
                        )
                    else:
                        results.append("Se mantiene la actuación actual.")
            outcome = f"No aplicada: {problem}" if problem else " ".join(results)
            question.status = "resolved"
            question.resolution = CoordinationResolution(
                question_id=question.id,
                incident_id=question.incident_id,
                idempotency_key=question.id,
                answer=chosen,
                answer_label=label,
                source="timeout" if expired else "human",
                outcome=outcome,
                applied=not bool(problem),
            )
            state.add_event(
                Event(
                    source=EventSource.system if expired else EventSource.operator,
                    kind=EventKind.note,
                    title="Respuesta automática por vencimiento"
                    if expired
                    else "Respuesta del coordinador",
                    payload={
                        "incident_id": question.incident_id,
                        "question_id": question.id,
                        "summary": f"{label}. {outcome}",
                        "log_kind": "answer",
                    },
                )
            )
        return self.state.coordination_questions[question_id]

    async def resolve_due_questions(self) -> None:
        due = [
            q
            for q in self.state.coordination_questions.values()
            if q.status == "pending" and q.expires_at <= now()
        ]
        for question in due:
            await self.answer_question(question.id, question.default_answer, timed_out=True)

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
                if location_pending(s, task):
                    # No hay destino todavía: se espera, no se descarta el aviso.
                    continue
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
            # Ventana para anular una decisión automática. Se comprueba después de validar:
            # una orden retenida que ya no vale se cancela, no se queda esperando.
            if action.hold_until and action.hold_until > now():
                continue
            action.state_version = s.version + 1
            action.status = ActionStatus.sending
            action.attempts += 1
            await self._commit(s, require_synced=True)
            result_state = self.state.copy()
            await self.executor.bind(result_state).send(result_state.actions[aid])
            await self._commit(result_state)

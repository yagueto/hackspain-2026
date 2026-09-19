"""Bucle del agente: percibir -> filtrar -> priorizar -> actuar -> explicar."""

from __future__ import annotations

import asyncio
import contextlib
import logging

from app.agent.executor import Executor
from app.agent.llm import LLMReviewer
from app.agent.planner import Proposal, propose, replan_needed
from app.domain.apply import apply_event
from app.domain.models import AgentMode, Decision, Event, EventKind, TaskStatus
from app.domain.state import WorldState
from app.store.persistence import Store

log = logging.getLogger(__name__)


class Orchestrator:
    def __init__(
        self,
        state: WorldState,
        executor: Executor,
        store: Store,
        reviewer: LLMReviewer,
        tick_seconds: float = 10.0,
    ) -> None:
        self.state = state
        self.executor = executor
        self.store = store
        self.reviewer = reviewer
        self.tick_seconds = tick_seconds
        self._task: asyncio.Task[None] | None = None
        self._running = False
        self._tick_lock = asyncio.Lock()

    # ------------------------------------------------------------ lifecycle

    def start(self) -> None:
        if self._task is None:
            self._running = True
            self._task = asyncio.create_task(self._loop(), name="orchestrator")

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _loop(self) -> None:
        while self._running:
            try:
                await asyncio.wait_for(self.state.dirty.wait(), timeout=self.tick_seconds)
            except TimeoutError:
                pass
            self.state.dirty.clear()
            if self.state.agent.mode != AgentMode.running or self.state.incident is None:
                continue
            try:
                await self.tick("timer" if not self.state.unprocessed_events() else "event")
            except Exception:  # noqa: BLE001
                log.exception("tick falló")

    # ------------------------------------------------------------ core

    async def tick(self, trigger: str = "manual") -> Decision:
        async with self._tick_lock:
            return await self._tick(trigger)

    async def _tick(self, trigger: str) -> Decision:
        s = self.state

        # 1. Percibir: aplicar eventos nuevos al mundo y ver qué cambió de verdad.
        new_events = s.unprocessed_events()
        facts: list[str] = []
        facts_by_event: dict[str, list[str]] = {}
        for e in new_events:
            f = apply_event(s, e)
            facts_by_event[e.id] = f
            facts.extend(f)

        # 2. Replanificar si hace falta: cancelar tareas que ya no valen.
        replan_reason = replan_needed(s, facts)
        cancelled: list[str] = []
        if replan_reason:
            for t in s.open_tasks():
                stale = (
                    t.kind == "dispatch_resource"
                    and t.zone_id in s.fronts
                    and s.fronts[t.zone_id].contained_pct >= 100
                ) or any(
                    s.resources[r].status == "out_of_service"
                    for r in t.resource_ids
                    if r in s.resources
                )
                if stale:
                    await self.executor.cancel_task(t, f"Replan: {replan_reason}")
                    cancelled.append(t.title)
            if any("Viento" in f or "cortada" in f for f in facts):
                await self.executor.broadcast_signal(
                    "crisis.update",
                    {"facts": facts, "weather": s.weather.model_dump() if s.weather else {}},
                )

        # 3. Proponer con el plan determinista.
        proposals = propose(s)

        # 4. Revisar con el LLM (si hay) usando lecciones de ejecuciones anteriores.
        lessons = await self.store.lessons_summary()
        reliability = await self.store.contact_reliability()
        review = await self.reviewer.review(s.snapshot(), new_events, proposals, lessons)
        model = "heuristic"
        discarded: list[str] = []
        if review:
            model = self.reviewer.model
            judged = {j.event_id: j for j in review.events}
            for e in new_events:
                j = judged.get(e.id)
                relevant = j.relevant if j else bool(facts_by_event.get(e.id))
                reason = j.reason if j else ("cambia el estado" if relevant else "sin cambios")
                s.mark_event(e.id, relevant, reason)
                if not relevant:
                    discarded.append(e.title)
            adjustments = {a.index: a for a in review.tasks}
            kept: list[Proposal] = []
            for i, p in enumerate(proposals):
                a = adjustments.get(i)
                if a and a.drop:
                    continue
                if a:
                    p.task.priority = a.priority
                    if a.reason:
                        p.task.priority_reason = a.reason
                kept.append(p)
            proposals = sorted(kept, key=lambda p: -p.task.priority)
            if review.replan and not replan_reason:
                replan_reason = review.replan_reason
        else:
            for e in new_events:
                relevant = bool(facts_by_event.get(e.id)) or e.kind in (
                    EventKind.call_outcome,
                    EventKind.message_outcome,
                )
                s.mark_event(e.id, relevant, "cambia el estado" if relevant else "sin cambios")
                if not relevant:
                    discarded.append(e.title)

        # 5. Actuar: registrar tareas y ejecutar las que no requieren aprobación humana.
        acted: list[str] = []
        for p in proposals:
            t = p.task
            needs_ok = t.requires_approval or t.kind in s.agent.approval_required_for
            if needs_ok:
                t.requires_approval = True
                t.status = TaskStatus.awaiting_approval
                s.upsert_task(t)
                acted.append(f"[pendiente de aprobación] {t.title}")
                continue
            s.upsert_task(t)
            await self.executor.execute(p, reliability)
            acted.append(f"{t.title} -> {t.status}")

        # Reintentar tareas propuestas antes que quedaron sin medios.
        for t in list(s.tasks.values()):
            if t.status == TaskStatus.proposed and t.outcome.startswith("Sin medios"):
                prop = next(
                    (
                        p
                        for p in propose(s)
                        if p.task.kind == t.kind and p.task.zone_id == t.zone_id
                    ),
                    None,
                )
                if prop:
                    prop.task = t
                    await self.executor.execute(prop, reliability)
                    if t.status != TaskStatus.proposed:
                        acted.append(f"(reintento) {t.title} -> {t.status}")

        # 6. Explicar.
        top = s.open_tasks()[:5]
        summary = (
            review.situation_summary if review else self._heuristic_summary(facts, replan_reason)
        )
        decision = Decision(
            trigger=trigger,
            situation_summary=summary,
            priorities=[f"{t.priority:>3} {t.title} — {t.priority_reason}" for t in top],
            actions_taken=acted + [f"cancelada: {c}" for c in cancelled],
            discarded_events=discarded,
            replan=bool(replan_reason),
            replan_reason=replan_reason,
            model=model,
            raw={
                "facts": facts,
                "next_action": review.next_action if review else (top[0].title if top else ""),
                "lessons_applied": review.lessons_applied if review else [],
            },
        )
        s.add_decision(decision)
        await self.store.journal("decision", decision, decision.ts.isoformat())
        for e in new_events:
            await self.store.journal("event", e, e.ts.isoformat())
        return decision

    def _heuristic_summary(self, facts: list[str], replan: str) -> str:
        s = self.state
        critical = [z.name for z in s.zones.values() if z.threat == "critical"]
        avail = len(s.available_resources())
        parts = []
        if facts:
            parts.append("Novedades: " + "; ".join(facts[:4]) + ".")
        if critical:
            parts.append("Zonas críticas: " + ", ".join(critical) + ".")
        parts.append(f"{avail} medios disponibles, {len(s.open_tasks())} tareas abiertas.")
        if replan:
            parts.append(f"Replanificación: {replan}.")
        return " ".join(parts)

    # ------------------------------------------------------------ human in the loop

    async def approve(self, task_id: str, approved: bool, note: str = "") -> None:
        t = self.state.tasks[task_id]
        if not approved:
            self.state.set_task_status(
                task_id, TaskStatus.rejected, note or "Rechazada por operador"
            )
            return
        t.requires_approval = False
        t.status = TaskStatus.proposed
        self.state.upsert_task(t)
        prop = next(
            (
                p
                for p in propose(self.state)
                if p.task.kind == t.kind and p.task.zone_id == t.zone_id
            ),
            Proposal(t),
        )
        prop.task = t
        await self.executor.execute(prop, await self.store.contact_reliability())
        self.state.add_event(
            Event(
                source="operator",
                kind=EventKind.note,
                title=f"Operador aprobó: {t.title}",
                payload={"task_id": t.id, "note": note},
            )
        )

"""Ejecuta tareas: asigna recursos y dispara interacciones reales vía HappyRobot."""

from __future__ import annotations

import logging

from app.agent.planner import Proposal
from app.domain.models import (
    Action,
    ActionKind,
    ActionStatus,
    Contact,
    ContactRole,
    Resource,
    ResourceStatus,
    Task,
    TaskKind,
    TaskStatus,
    now,
)
from app.domain.state import WorldState
from app.integrations.happyrobot import HappyRobotClient, HappyRobotError, WorkflowKind
from app.store.persistence import Store

log = logging.getLogger(__name__)

ROLE_TO_WORKFLOW: dict[ContactRole, WorkflowKind] = {
    ContactRole.firefighter: "call_responder",
    ContactRole.ambulance: "call_responder",
    ContactRole.police: "call_responder",
    ContactRole.civil_protection: "call_responder",
    ContactRole.shelter: "call_responder",
    ContactRole.mayor: "notify_authority",
    ContactRole.civilian: "call_civilian",
}


class Executor:
    def __init__(
        self, state: WorldState, hr: HappyRobotClient, store: Store, public_base_url: str = ""
    ) -> None:
        self.state = state
        self.hr = hr
        self.store = store
        self.public_base_url = public_base_url

    # ------------------------------------------------------------ helpers

    def _pick_resource(self, prop: Proposal, reliability: dict[str, float]) -> Resource | None:
        candidates = self.state.available_resources([t.value for t in prop.wants_resource_types])
        if not candidates:
            return None

        def score(r: Resource) -> float:
            c = self.state.contact_for_resource(r.id)
            rel = reliability.get(c.id, c.reliability) if c else 0.5
            return rel  # TODO distancia cuando tengamos geodesia

        return max(candidates, key=score)

    def _pick_contact(self, prop: Proposal, resource: Resource | None) -> Contact | None:
        if resource:
            c = self.state.contact_for_resource(resource.id)
            if c:
                return c
        zone_id = prop.task.zone_id
        for role in prop.contact_roles:
            for c in self.state.contacts.values():
                if c.role == role and (c.zone_id == zone_id or c.zone_id is None):
                    return c
        return None

    def _briefing(self, task: Task, contact: Contact) -> dict[str, object]:
        """Contexto que recibe el agente de voz de HappyRobot para la conversación."""
        s = self.state
        zone = s.zones.get(task.zone_id or "")
        front = s.fronts.get(task.zone_id or "")
        threats = []
        for f in s.fronts.values():
            for zid, eta in f.eta_minutes_to_zone.items():
                z = s.zones.get(zid)
                if z:
                    threats.append(f"{f.name} llega a {z.name} en {eta:.0f} min")
        closed = [r.name for r in s.roads.values() if not r.open]
        return {
            "task_id": task.id,
            "task_kind": task.kind.value,
            "task_title": task.title,
            "instructions": task.description,
            "priority": task.priority,
            "contact_id": contact.id,
            "contact_name": contact.name,
            "contact_role": contact.role.value,
            "phone": contact.phone,
            "language": contact.language,
            "incident": s.incident.name if s.incident else "",
            "zone": zone.name if zone else (front.name if front else ""),
            "zone_status": zone.model_dump(mode="json") if zone else {},
            "weather": s.weather.model_dump(mode="json") if s.weather else {},
            "threats": threats,
            "roads_closed": closed,
            "callback_url": f"{self.public_base_url}/api/v1/webhooks/happyrobot",
        }

    # ------------------------------------------------------------ actions

    async def execute(self, prop: Proposal, reliability: dict[str, float]) -> Task:
        task = prop.task
        resource = self._pick_resource(prop, reliability) if prop.wants_resource_types else None
        contact = self._pick_contact(prop, resource)

        if prop.wants_resource_types and resource is None:
            task.status = TaskStatus.proposed
            task.outcome = "Sin medios disponibles del tipo requerido; en espera."
            self.state.upsert_task(task)
            return task

        if resource:
            resource.status = ResourceStatus.dispatched
            resource.assigned_task_id = task.id
            resource.assigned_zone_id = task.zone_id
            self.state.upsert_resource(resource)
            task.resource_ids = [resource.id]
            assign = Action(
                kind=ActionKind.assign,
                status=ActionStatus.completed,
                task_id=task.id,
                summary=f"{resource.name} asignado a {task.title}",
                request={"resource_id": resource.id},
            )
            self.state.upsert_action(assign)
            task.action_ids.append(assign.id)

        if task.kind == TaskKind.evacuate_zone and task.zone_id in self.state.zones:
            z = self.state.zones[task.zone_id]
            z.evacuation_status = "ordered"
            self.state.upsert_zone(z)

        if contact is None:
            task.status = TaskStatus.in_progress
            task.outcome = "Sin contacto asociado; tarea interna."
            self.state.upsert_task(task)
            return task

        task.assignee_contact_id = contact.id
        task.status = TaskStatus.dispatching
        self.state.upsert_task(task)
        await self.call(task, contact)
        return task

    async def call(self, task: Task, contact: Contact) -> Action:
        wf = ROLE_TO_WORKFLOW[contact.role]
        payload = self._briefing(task, contact)
        action = Action(
            kind=ActionKind.call,
            task_id=task.id,
            contact_id=contact.id,
            summary=f"Llamada HappyRobot ({wf}) a {contact.name}",
            request={"workflow": wf, "payload": payload},
        )
        self.state.upsert_action(action)
        task.action_ids.append(action.id)
        try:
            if not self.state.integrations.get("happyrobot", True):
                raise HappyRobotError("integración HappyRobot marcada como caída")
            res = await self.hr.trigger(wf, payload)
            action.status = ActionStatus.dispatched
            action.happyrobot_run_id = str(res.get("run_id", ""))
            action.result = res
            task.status = TaskStatus.dispatched
            contact.last_contacted_at = now()
            self.state.upsert_contact(contact)
        except HappyRobotError as exc:
            log.warning("HappyRobot falló: %s", exc)
            action.status = ActionStatus.failed
            action.error = str(exc)
            task.status = TaskStatus.failed
            task.outcome = f"No se pudo contactar: {exc}"
            await self.store.add_lesson(
                ts=now().isoformat(),
                action_kind="call",
                success=False,
                detail=str(exc),
                contact_id=contact.id,
                role=contact.role.value,
            )
        self.state.upsert_action(action)
        self.state.upsert_task(task)
        await self.store.journal("action", action, action.ts.isoformat())
        return action

    async def sms(self, contact: Contact, message: str, task: Task | None = None) -> Action:
        action = Action(
            kind=ActionKind.sms,
            task_id=task.id if task else None,
            contact_id=contact.id,
            summary=f"SMS a {contact.name}",
            request={"phone": contact.phone, "message": message},
        )
        self.state.upsert_action(action)
        try:
            res = await self.hr.trigger(
                "sms",
                {
                    "phone": contact.phone,
                    "message": message,
                    "contact_id": contact.id,
                    "task_id": task.id if task else "",
                },
            )
            action.status = ActionStatus.dispatched
            action.happyrobot_run_id = str(res.get("run_id", ""))
            action.result = res
        except HappyRobotError as exc:
            action.status = ActionStatus.failed
            action.error = str(exc)
        self.state.upsert_action(action)
        await self.store.journal("action", action, action.ts.isoformat())
        return action

    async def broadcast_signal(self, key: str, payload: dict[str, object]) -> Action:
        """Avisa a las llamadas EN CURSO de que algo ha cambiado (viento, carretera...)."""
        action = Action(
            kind=ActionKind.signal,
            summary=f"Señal a sesiones activas: {key}",
            request={"key": key, "payload": payload},
        )
        self.state.upsert_action(action)
        try:
            action.result = await self.hr.publish_signal(key, payload)
            action.status = ActionStatus.completed
        except HappyRobotError as exc:
            action.status = ActionStatus.failed
            action.error = str(exc)
        self.state.upsert_action(action)
        return action

    async def cancel_task(self, task: Task, reason: str) -> None:
        for rid in task.resource_ids:
            r = self.state.resources.get(rid)
            if r and r.assigned_task_id == task.id:
                r.status = ResourceStatus.available
                r.assigned_task_id = None
                r.assigned_zone_id = None
                self.state.upsert_resource(r)
        for aid in task.action_ids:
            a = self.state.actions.get(aid)
            if a and a.happyrobot_run_id and a.status == ActionStatus.dispatched:
                try:
                    await self.hr.cancel_run(a.happyrobot_run_id)
                except HappyRobotError:
                    pass
        self.state.set_task_status(task.id, TaskStatus.cancelled, reason)

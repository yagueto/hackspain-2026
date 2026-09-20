from __future__ import annotations

import math
from datetime import timedelta

from app.agent.planner import Proposal, zone_eta
from app.domain.autonomy import hold_until
from app.domain.intake import NO_LOCATION, report_location
from app.domain.models import (
    Action,
    ActionKind,
    ActionStatus,
    Contact,
    ContactRole,
    Event,
    EventKind,
    EventSource,
    Location,
    Resource,
    ResourceStatus,
    ResourceType,
    Task,
    TaskKind,
    TaskStatus,
    now,
)
from app.domain.movement import clear_travel
from app.domain.state import WorldState
from app.integrations.happyrobot import HappyRobotClient, HappyRobotError, WorkflowKind
from app.store.persistence import Store

# Workflows que cada tipo de orden puede disparar. Una orden con un workflow fuera de esta
# tabla falla en vez de reenrutarse a otro canal.
KIND_TO_WORKFLOWS: dict[ActionKind, tuple[WorkflowKind, ...]] = {
    ActionKind.call: ("call_responder", "call_civilian", "notify_authority"),
    ActionKind.telegram: ("send_telegram",),
}

NO_RESOURCE = "Sin medios o contacto compatibles y accesibles; en espera."

ROLE_TO_WORKFLOW: dict[ContactRole, WorkflowKind] = {
    ContactRole.firefighter: "call_responder",
    ContactRole.ambulance: "call_responder",
    ContactRole.police: "call_responder",
    ContactRole.civil_protection: "call_responder",
    ContactRole.shelter: "call_responder",
    ContactRole.mayor: "notify_authority",
    ContactRole.civilian: "call_civilian",
}


def distance(a: Location, b: Location) -> float:
    lat1, lat2 = math.radians(a.lat), math.radians(b.lat)
    dlat, dlon = lat2 - lat1, math.radians(b.lng - a.lng)
    hav = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371 * 2 * math.asin(min(1, math.sqrt(hav)))


def location_pending(state: WorldState, task: Task) -> bool:
    """El aviso sigue vigente pero todavía no hay una ubicación utilizable.

    Se distingue de una ubicación *modificada* porque no invalida nada: la misión no
    puede salir todavía, pero descartarla perdería el aviso.
    """
    if not task.incoming_call_id or task.target_location:
        return False
    report = state.incoming_calls.get(task.incoming_call_id)
    return bool(
        report
        and report.timestamp == task.incoming_call_timestamp
        and report_location(report) is None
    )


def invalid_task(state: WorldState, task: Task) -> str:
    if task.incoming_call_id:
        report = state.incoming_calls.get(task.incoming_call_id)
        if not report or report.timestamp != task.incoming_call_timestamp:
            return "el aviso cambió; se requiere una nueva revisión"
        if not location_pending(state, task) and (
            not task.target_location or task.target_location != report_location(report)
        ):
            return "ubicación pendiente o modificada; se requiere revisión"
    if task.zone_id and task.zone_id not in (state.zones | state.fronts | state.roads):
        return "destino desconocido"
    front = state.fronts.get(task.zone_id or "")
    if front and front.contained_pct >= 100:
        return "frente contenido"
    if task.kind == TaskKind.evacuate_zone:
        eta = zone_eta(state, task.zone_id or "")
        if eta is None or eta > 180:
            return "el frente ya no amenaza la zona"
    if any(
        state.resources[rid].status == ResourceStatus.out_of_service
        for rid in task.resource_ids
        if rid in state.resources
    ):
        return "medio fuera de servicio"
    return ""


def reachable(state: WorldState, task: Task, resource: Resource) -> bool:
    if resource.type == ResourceType.helicopter:
        return True
    roads = [r for r in state.roads.values() if task.zone_id in r.connects]
    return not roads or any(r.open for r in roads)


def compatible_resource(state: WorldState, task: Task, resource: Resource) -> bool:
    contact = state.contact_for_resource(resource.id)
    return bool(
        resource.type in task.resource_types
        and contact
        and (not task.contact_roles or contact.role in task.contact_roles)
        and (not task.assignee_contact_id or task.assignee_contact_id == contact.id)
        and reachable(state, task, resource)
        and (
            resource.type not in (ResourceType.ambulance, ResourceType.evacuation_bus)
            or resource.capacity > 0
        )
    )


def allocation_pending(state: WorldState, task: Task) -> bool:
    return any(
        question.status == "pending" and task.id in question.allocation_task_ids
        for question in state.coordination_questions.values()
    )


class Executor:
    def __init__(
        self,
        state: WorldState,
        hr: HappyRobotClient,
        store: Store,
        public_base_url: str = "",
    ) -> None:
        self.state, self.hr, self.store = state, hr, store
        self.public_base_url = public_base_url

    def bind(self, state: WorldState) -> Executor:
        return Executor(state, self.hr, self.store, self.public_base_url)

    def _pick_resource(self, prop: Proposal, reliability: dict[str, float]) -> Resource | None:
        candidates = [
            r
            for r in self.state.available_resources(prop.wants_resource_types)
            if compatible_resource(self.state, prop.task, r)
            and not any(
                q.status == "pending" and q.allocation_resource_id == r.id
                for q in self.state.coordination_questions.values()
            )
        ]
        if prop.task.preferred_resource_id:
            preferred = next(
                (r for r in candidates if r.id == prop.task.preferred_resource_id), None
            )
            if preferred:
                return preferred
        target = self.state.zones.get(prop.task.zone_id or "") or self.state.fronts.get(
            prop.task.zone_id or ""
        )

        target_location = prop.task.target_location or (target.location if target else None)

        def score(resource: Resource) -> float:
            contact = self.state.contact_for_resource(resource.id)
            rel = reliability.get(contact.id, contact.reliability) if contact else 0
            eta = resource.eta_minutes
            if eta is None or prop.task.incoming_call_id:
                eta = distance(resource.location, target_location) * 1.5 if target_location else 30
            same_type = sum(r.type == resource.type for r in candidates)
            coverage = 15 if same_type == 1 and prop.task.priority < 90 else 0
            return -eta - coverage + min(resource.capacity, 50) / 10 + rel * 5

        return max(candidates, key=score) if candidates else None

    def can_progress(self, task: Task) -> bool:
        """Si hoy existe destino, medio y contacto para sacar esta tarea adelante.

        Permite no abrir una transacción por una misión que va a quedarse esperando igual.
        """
        if (
            allocation_pending(self.state, task)
            or location_pending(self.state, task)
            or invalid_task(self.state, task)
        ):
            return False
        proposal = Proposal(task, task.resource_types, task.contact_roles)
        if task.resource_types:
            return self._pick_resource(proposal, {}) is not None
        return any(c.role in task.contact_roles for c in self.state.contacts.values())

    def _briefing(self, task: Task, contact: Contact) -> dict[str, object]:
        s = self.state
        zone = s.zones.get(task.zone_id or "")
        return {
            "task_id": task.id,
            "task_kind": task.kind,
            "task_title": task.title,
            "instructions": task.description
            + (
                "\nCoordinación solicita reasignar desde la misión "
                f"{task.reassigned_from_task_id}. Confirma si puedes interrumpirla "
                "y atender el nuevo destino; no se presume aceptación."
                if task.reassigned_from_task_id
                else ""
            )
            + (
                f"\nDestino de la misión: {task.target_location.label}; "
                f"latitud {task.target_location.lat}, longitud {task.target_location.lng}."
                if task.target_location
                else ""
            ),
            "target_location": task.target_location.model_dump(mode="json")
            if task.target_location
            else None,
            "incoming_call_id": task.incoming_call_id,
            "priority": task.priority,
            "contact_id": contact.id,
            "contact_name": contact.name,
            "phone": contact.phone,
            "language": contact.language,
            "incident_id": s.incident.id if s.incident else "",
            "world_state_version": s.version + 1,
            "resource_ids": task.resource_ids,
            "zone_status": zone.model_dump(mode="json") if zone else {},
            "weather": s.weather.model_dump(mode="json") if s.weather else {},
            "roads_closed": [r.name for r in s.roads.values() if not r.open],
            "callback_url": f"{self.public_base_url}/api/v1/webhooks/happyrobot",
            "observations_table": "crisis_observations",
        }

    async def execute(self, prop: Proposal, reliability: dict[str, float]) -> Task:
        task = prop.task
        task.resource_types = prop.wants_resource_types
        task.contact_roles = prop.contact_roles
        self.state.tasks[task.id] = task
        if task.status not in (TaskStatus.proposed, TaskStatus.awaiting_approval):
            return task
        if (task.requires_approval or not self.state.agent.autonomous) and not task.approved_at:
            task.status = TaskStatus.awaiting_approval
            return task
        if location_pending(self.state, task):
            # Sin destino no se moviliza a nadie, pero el aviso no se descarta.
            task.status = TaskStatus.proposed
            task.blocked_reason = NO_LOCATION
            return task
        reason = invalid_task(self.state, task)
        if reason:
            task.status, task.outcome = TaskStatus.cancelled, reason
            return task
        task.blocked_reason = ""
        if allocation_pending(self.state, task):
            return task
        resource = self._pick_resource(prop, reliability) if prop.wants_resource_types else None
        contact = self.state.contacts.get(task.assignee_contact_id or "")
        if resource:
            contact = self.state.contact_for_resource(resource.id)
        elif not prop.wants_resource_types and not contact:
            contact = next(
                (
                    c
                    for c in self.state.contacts.values()
                    if c.role in prop.contact_roles and c.zone_id in (None, task.zone_id)
                ),
                None,
            )
        if (prop.wants_resource_types and not resource) or not contact:
            task.status = TaskStatus.proposed
            task.outcome = NO_RESOURCE
            return task
        if task.outcome == NO_RESOURCE:
            task.outcome = ""  # ya hay medio: la espera dejó de ser el estado de la misión
        if task.autonomous and task.hold_until and task.hold_until <= now():
            # La ventana se consumió esperando un medio libre. Se reabre al asignarlo: si no,
            # una misión que esperó horas saldría sin margen alguno para anularla.
            task.hold_until = hold_until(self.state.agent, False)
        if resource:
            resource.status = ResourceStatus.reserved
            resource.assigned_task_id = task.id
            resource.assigned_zone_id = task.zone_id
            self.state.field_clocks[f"resource:{resource.id}"] = now()
            task.resource_ids = [resource.id]
        if task.kind == TaskKind.evacuate_zone and task.zone_id in self.state.zones:
            self.state.zones[task.zone_id].evacuation_status = "ordered"
        task.assignee_contact_id = contact.id
        await self.call(task, contact)
        return task

    async def call(self, task: Task, contact: Contact) -> Action:
        if task.status in (TaskStatus.done, TaskStatus.cancelled, TaskStatus.rejected):
            raise ValueError("tarea cerrada")
        if allocation_pending(self.state, task):
            raise ValueError("el operador debe resolver el conflicto de recursos")
        if task.resource_types and not task.resource_ids:
            raise ValueError("se requiere una reserva antes de contactar para esta tarea")
        if (task.requires_approval or not self.state.agent.autonomous) and not task.approved_at:
            raise ValueError("la tarea necesita aprobación antes de contactar")
        if invalid_task(self.state, task):
            raise ValueError("la tarea ya no es viable")
        if any(
            a.task_id == task.id
            and a.kind == ActionKind.call
            and a.status
            in (
                ActionStatus.pending,
                ActionStatus.sending,
                ActionStatus.unknown,
                ActionStatus.dispatched,
            )
            for a in self.state.actions.values()
        ):
            raise ValueError("la tarea ya tiene una llamada pendiente o activa")
        action = Action(
            kind=ActionKind.call,
            task_id=task.id,
            contact_id=contact.id,
            summary=f"Llamada a {contact.name}",
            workflow=ROLE_TO_WORKFLOW[contact.role],
            decision_id=task.decision_id,
            state_version=self.state.version + 1,
            expires_at=now() + timedelta(minutes=10),
            hold_until=task.hold_until,
        )
        action.request = {
            **self._briefing(task, contact),
            "command_id": action.id,
            "action_id": action.id,
        }
        task.action_ids.append(action.id)
        task.status = TaskStatus.dispatching
        self.state.upsert_task(task)
        if task.autonomous:
            self.state.add_event(
                Event(
                    source=EventSource.system,
                    kind=EventKind.note,
                    title=f"Decisión automática: {task.title} → {contact.name}",
                    processed=True,
                    relevant=True,
                    payload={
                        "task_id": task.id,
                        "action_id": action.id,
                        "reason": task.priority_reason,
                        "hold_until": task.hold_until.isoformat() if task.hold_until else None,
                    },
                )
            )
        return self.state.upsert_action(action)

    async def message(
        self, contact: Contact | None, message: str, task_id: str | None = None
    ) -> Action:
        """El chat de destino lo resuelve el workflow; el contacto solo etiqueta el aviso."""
        name = contact.name if contact else "Coordinación"
        # Sin `task_id` en la acción a propósito: el outbox trata una orden con tarea como
        # misión y la cancelaría por "requiere aprobación", que es justo el caso que avisa.
        action = Action(
            kind=ActionKind.telegram,
            contact_id=contact.id if contact else None,
            summary=f"Telegram: aviso para {name}",
            workflow="send_telegram",
            state_version=self.state.version + 1,
            expires_at=now() + timedelta(minutes=10),
        )
        action.request = {
            "command_id": action.id,
            "action_id": action.id,
            "channel": "telegram",
            "message": message,
            "contact_id": contact.id if contact else None,
            "contact_name": name,
            "task_id": task_id,
            "incident_id": self.state.incident.id if self.state.incident else "",
            "callback_url": f"{self.public_base_url}/api/v1/webhooks/happyrobot",
        }
        return self.state.upsert_action(action)

    async def broadcast_signal(self, key: str, payload: dict[str, object]) -> Action:
        return self.state.upsert_action(
            Action(
                kind=ActionKind.signal,
                summary=f"Señal: {key}",
                request={"key": key, "payload": payload},
                state_version=self.state.version + 1,
                expires_at=now() + timedelta(minutes=2),
            )
        )

    def complete_task(self, task: Task, outcome: str) -> None:
        if task.status not in (TaskStatus.accepted, TaskStatus.in_progress):
            raise ValueError("solo puede finalizarse una misión aceptada o en curso")
        self.state.set_task_status(task.id, TaskStatus.done, outcome or "Finalizada por operador")

    async def cancel_task(self, task: Task, reason: str) -> None:
        if task.cancellation_requested:
            return
        task.cancellation_requested = True
        sent = False
        for aid in task.action_ids:
            action = self.state.actions[aid]
            if action.status == ActionStatus.pending:
                action.status = ActionStatus.skipped
                action.error = reason
            elif action.status != ActionStatus.skipped:
                sent = True
                if action.happyrobot_run_id and action.status == ActionStatus.dispatched:
                    self.state.upsert_action(
                        Action(
                            kind=ActionKind.internal,
                            summary=f"Cancelar run de {task.title}",
                            request={
                                "cancel_run_id": action.happyrobot_run_id,
                                "source_command_id": action.id,
                                "task_id": task.id,
                            },
                        )
                    )
        if not sent and not task.reassigned_from_task_id:
            for rid in task.resource_ids:
                resource = self.state.resources[rid]
                if resource.assigned_task_id == task.id:
                    if resource.status == ResourceStatus.reserved:
                        resource.status = ResourceStatus.available
                    resource.assigned_task_id = None
                    resource.assigned_zone_id = None
                    clear_travel(resource)
        self.state.set_task_status(task.id, TaskStatus.cancelled, reason)

    async def send(self, action: Action) -> None:
        task = self.state.tasks.get(action.task_id or "")
        try:
            if action.kind == ActionKind.signal:
                result = await self.hr.publish_signal(
                    str(action.request["key"]), action.request["payload"]
                )
            elif action.kind == ActionKind.internal:
                result = await self.hr.cancel_run(str(action.request["cancel_run_id"]))
            else:
                if action.workflow not in KIND_TO_WORKFLOWS.get(action.kind, ()):
                    raise HappyRobotError("workflow no configurado")
                result = await self.hr.trigger(action.workflow, action.request)
                if not result.get("run_id"):
                    raise HappyRobotError("respuesta sin run_id", ambiguous=True)
                action.happyrobot_run_id = str(result["run_id"])
            action.result = result
            action.status = (
                ActionStatus.dispatched
                if action.kind in (ActionKind.call, ActionKind.telegram)
                else ActionStatus.completed
            )
            if task:
                task.status = TaskStatus.dispatched
            if action.contact_id in self.state.contacts:
                self.state.contacts[action.contact_id].last_contacted_at = now()
        except HappyRobotError as exc:
            action.error = str(exc)
            if exc.ambiguous:
                action.status = ActionStatus.unknown
            elif exc.retryable and action.attempts < 3:
                action.status = ActionStatus.pending
                action.next_attempt_at = now() + timedelta(seconds=2**action.attempts)
            else:
                action.status = ActionStatus.failed
                if task:
                    task.status = TaskStatus.failed
                    task.outcome = action.error

"""Intervención humana: pausar, aprobar, forzar prioridades, lanzar llamadas a mano."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.agent.planner import Proposal
from app.api.deps import require_api_key
from app.domain.models import (
    Action,
    ActionStatus,
    AgentConfig,
    AgentMode,
    ContactRole,
    Decision,
    Event,
    EventKind,
    EventSource,
    ResourceType,
    Task,
    TaskKind,
    TaskStatus,
    WorldSnapshot,
    now,
)
from app.integrations.happyrobot import HappyRobotError
from app.runtime import Runtime, get_runtime

router = APIRouter(prefix="/control", tags=["control"], dependencies=[Depends(require_api_key)])


@router.post("/pause")
async def pause(rt: Runtime = Depends(get_runtime)) -> AgentConfig:
    async with rt.orchestrator.edit() as state:
        state.agent.mode = AgentMode.paused
    return rt.state.agent


@router.post("/resume")
async def resume(rt: Runtime = Depends(get_runtime)) -> AgentConfig:
    async with rt.orchestrator.edit() as state:
        state.agent.mode = AgentMode.running
    return rt.state.agent


@router.post("/tick")
async def tick(rt: Runtime = Depends(get_runtime)) -> Decision:
    return await rt.orchestrator.tick("manual")


class ApprovalIn(BaseModel):
    approved: bool = True
    note: str = ""


@router.post("/tasks/{task_id}/approve")
async def approve(task_id: str, body: ApprovalIn, rt: Runtime = Depends(get_runtime)) -> Task:
    if task_id not in rt.state.tasks:
        raise HTTPException(404)
    await rt.orchestrator.approve(task_id, body.approved, body.note)
    return rt.state.tasks[task_id]


class PriorityIn(BaseModel):
    priority: int
    reason: str = "Override del operador"


@router.post("/tasks/{task_id}/priority")
async def override_priority(
    task_id: str, body: PriorityIn, rt: Runtime = Depends(get_runtime)
) -> Task:
    async with rt.orchestrator.edit() as state:
        t = state.tasks.get(task_id)
        if not t:
            raise HTTPException(404)
        t.priority = max(0, min(100, body.priority))
        t.priority_reason = body.reason
    return rt.state.tasks[task_id]


class StatusIn(BaseModel):
    status: TaskStatus
    outcome: str = ""


@router.post("/tasks/{task_id}/status")
async def set_status(task_id: str, body: StatusIn, rt: Runtime = Depends(get_runtime)) -> Task:
    async with rt.orchestrator.edit() as state:
        t = state.tasks.get(task_id)
        if not t:
            raise HTTPException(404)
        if body.status == TaskStatus.cancelled:
            await rt.executor.bind(state).cancel_task(t, body.outcome or "Cancelada por operador")
        elif body.status == TaskStatus.done:
            state.set_task_status(task_id, body.status, body.outcome)
        else:
            raise HTTPException(409, "usa aprobación o una observación de estado de la unidad")
    await rt.orchestrator.dispatch_pending()
    return rt.state.tasks[task_id]


class ManualTaskIn(BaseModel):
    kind: TaskKind = TaskKind.other
    title: str
    description: str = ""
    priority: int = 50
    zone_id: str | None = None
    contact_id: str | None = None
    resource_types: list[ResourceType] = Field(default_factory=list)
    contact_roles: list[ContactRole] = Field(default_factory=list)


@router.post("/tasks", status_code=201)
async def create_task(body: ManualTaskIn, rt: Runtime = Depends(get_runtime)) -> Task:
    t = Task(
        kind=body.kind,
        title=body.title,
        description=body.description,
        priority=body.priority,
        priority_reason="Creada por operador",
        zone_id=body.zone_id,
        assignee_contact_id=body.contact_id,
        status=TaskStatus.proposed,
    )
    async with rt.orchestrator.edit() as state:
        if body.contact_id and body.contact_id not in state.contacts:
            raise HTTPException(404, "contacto desconocido")
        t.requires_approval = t.kind in state.agent.approval_required_for
        t.status = TaskStatus.awaiting_approval if t.requires_approval else TaskStatus.proposed
        types = body.resource_types or {
            TaskKind.dispatch_resource: [ResourceType.fire_engine, ResourceType.helicopter],
            TaskKind.medical_triage: [ResourceType.ambulance],
            TaskKind.close_road: [ResourceType.police_unit],
            TaskKind.evacuate_zone: [ResourceType.evacuation_bus],
        }.get(t.kind, [])
        await rt.executor.bind(state).execute(Proposal(t, types, body.contact_roles), {})
    await rt.orchestrator.dispatch_pending()
    return rt.state.tasks[t.id]


class CallIn(BaseModel):
    contact_id: str
    instructions: str
    task_id: str | None = None


@router.post("/call")
async def manual_call(body: CallIn, rt: Runtime = Depends(get_runtime)) -> Action:
    async with rt.orchestrator.edit() as state:
        contact = state.contacts.get(body.contact_id)
        if not contact:
            raise HTTPException(404, "contacto no existe")
        if body.task_id and body.task_id not in state.tasks:
            raise HTTPException(404, "tarea no existe")
        task = state.tasks.get(body.task_id or "") or Task(
            kind=TaskKind.other,
            title=f"Llamada manual a {contact.name}",
            description=body.instructions,
            priority=50,
            priority_reason="Lanzada por operador",
            assignee_contact_id=contact.id,
            status=TaskStatus.proposed,
        )
        if task.assignee_contact_id and task.assignee_contact_id != contact.id:
            raise HTTPException(409, "el contacto no corresponde a la tarea")
        action = await rt.executor.bind(state).call(task, contact)
    await rt.orchestrator.dispatch_pending()
    return rt.state.actions[action.id]


class TelegramIn(BaseModel):
    contact_id: str
    message: str = Field(min_length=1, max_length=4096)


@router.post("/telegram")
async def manual_telegram(body: TelegramIn, rt: Runtime = Depends(get_runtime)) -> Action:
    async with rt.orchestrator.edit() as state:
        contact = state.contacts.get(body.contact_id)
        if not contact:
            raise HTTPException(404, "contacto no existe")
        action = await rt.executor.bind(state).message(contact, body.message)
    await rt.orchestrator.dispatch_pending()
    return rt.state.actions[action.id]


class NoteIn(BaseModel):
    title: str
    zone_id: str | None = None


@router.post("/note", status_code=202)
async def operator_note(body: NoteIn, rt: Runtime = Depends(get_runtime)) -> Event:
    return await rt.orchestrator.ingest_event(
        Event(
            source=EventSource.operator, kind=EventKind.note, title=body.title, zone_id=body.zone_id
        )
    )


class AgentConfigIn(BaseModel):
    approval_required_for: list[TaskKind] | None = None
    tick_seconds: float | None = Field(default=None, ge=0.1)


@router.patch("/agent")
async def configure_agent(body: AgentConfigIn, rt: Runtime = Depends(get_runtime)) -> AgentConfig:
    async with rt.orchestrator.edit() as state:
        if body.approval_required_for is not None:
            state.agent.approval_required_for = body.approval_required_for
        if body.tick_seconds is not None:
            state.agent.tick_seconds = body.tick_seconds
    rt.orchestrator.tick_seconds = rt.state.agent.tick_seconds
    return rt.state.agent


@router.post("/incident", status_code=201)
async def initialize_incident(
    body: WorldSnapshot, rt: Runtime = Depends(get_runtime)
) -> WorldSnapshot:
    if rt.state.incident or await rt.store.load(body.incident.id):
        raise HTTPException(409, "el incidente ya está inicializado")
    if body.incident.id != rt.settings.incident_id:
        raise HTTPException(409, "incident.id debe coincidir con INCIDENT_ID")
    if body.tasks or body.recent_actions or body.recent_events or body.recent_decisions:
        raise HTTPException(422, "inicializa solo catálogos y estado, sin órdenes ni histórico")
    if any(r.assigned_task_id or r.assigned_zone_id for r in body.resources):
        raise HTTPException(422, "las unidades iniciales no deben tener asignaciones")
    for items in (body.zones, body.fronts, body.roads, body.contacts, body.resources):
        if len({item.id for item in items}) != len(items):
            raise HTTPException(422, "id duplicado en catálogo")
    zone_ids = {z.id for z in body.zones}
    resource_ids = {r.id for r in body.resources}
    if any(set(road.connects) - zone_ids for road in body.roads):
        raise HTTPException(422, "carretera con zonas desconocidas")
    if any(
        (set(f.threatens_zone_ids) | set(f.eta_minutes_to_zone)) - zone_ids for f in body.fronts
    ):
        raise HTTPException(422, "frente con zonas desconocidas")
    if any(
        (c.zone_id and c.zone_id not in zone_ids)
        or (c.resource_id and c.resource_id not in resource_ids)
        for c in body.contacts
    ):
        raise HTTPException(422, "contacto con zona/recurso desconocido")
    body.version = 0
    body.last_synced_at = now()
    body.field_clocks = {}
    body.event_facts = {}
    snapshot = await rt.store.create(body)
    rt.state.restore(snapshot, emit=True)
    return snapshot


@router.post("/actions/{action_id}/reconcile")
async def reconcile(action_id: str, rt: Runtime = Depends(get_runtime)) -> Action:
    async with rt.orchestrator.edit() as state:
        action = state.actions.get(action_id)
        if not action:
            raise HTTPException(404, "orden desconocida")
        if action.status in (ActionStatus.completed, ActionStatus.failed, ActionStatus.skipped):
            return action
        if not action.happyrobot_run_id:
            raise HTTPException(
                409, "sin run_id: aporta un resultado correlacionado con command_id"
            )
        try:
            result = await rt.hr.get_run(action.happyrobot_run_id)
        except HappyRobotError as exc:
            raise HTTPException(503, str(exc)) from exc
        if result.get("id") != action.happyrobot_run_id:
            raise HTTPException(502, "HappyRobot devolvió un run distinto")
        action.result["run"] = result
        status = result.get("status")
        if status in ("not_started", "scheduled", "running"):
            action.status = ActionStatus.dispatched
        elif status in ("succeeded", "completed", "canceled", "skipped", "failed"):
            action.status = ActionStatus.unknown
            action.error = f"run {status}; falta resultado operativo, no se libera la unidad"
        else:
            raise HTTPException(502, "estado de run no reconocido")
    return rt.state.actions[action_id]

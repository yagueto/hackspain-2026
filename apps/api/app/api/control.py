"""Intervención humana: pausar, aprobar, forzar prioridades, lanzar llamadas a mano."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import AwareDatetime, BaseModel, Field

from app.agent.planner import Proposal
from app.api.deps import require_api_key
from app.domain.autonomy import hold_until, needs_confirmation
from app.domain.intake import prepare_intake_tasks
from app.domain.models import (
    Action,
    ActionStatus,
    AgentConfig,
    AgentMode,
    ContactRole,
    CoordinationAnswer,
    CoordinationQuestion,
    CoordinationQuestionIn,
    Decision,
    Event,
    EventKind,
    EventSource,
    GeocodedPlace,
    IncomingCall,
    LocationResolution,
    ResourceType,
    Severity,
    Task,
    TaskKind,
    TaskStatus,
    WorldSnapshot,
    now,
)
from app.integrations.geocoding import COARSE_PLACES
from app.integrations.happyrobot import HappyRobotError
from app.runtime import Runtime, get_runtime

router = APIRouter(prefix="/control", tags=["control"], dependencies=[Depends(require_api_key)])


@router.post("/pause")
async def pause(rt: Runtime = Depends(get_runtime)) -> AgentConfig:
    """Parada de emergencia: no sale nada nuevo, ni siquiera lo ya retenido.

    No cancela los runs ya enviados ni libera las unidades movilizadas: para eso hay
    que cancelar cada misión.
    """
    async with rt.orchestrator.edit() as state:
        state.agent.mode = AgentMode.paused
        state.add_event(
            Event(
                source=EventSource.operator,
                kind=EventKind.note,
                severity=Severity.high,
                title="Parada de emergencia activada: el agente no envía nuevas órdenes",
            )
        )
    return rt.state.agent


@router.post("/resume")
async def resume(rt: Runtime = Depends(get_runtime)) -> AgentConfig:
    async with rt.orchestrator.edit() as state:
        state.agent.mode = AgentMode.running
        state.add_event(
            Event(
                source=EventSource.operator,
                kind=EventKind.note,
                title="Autonomía reactivada por el operador",
            )
        )
    rt.orchestrator.start(autoplan=True)
    return rt.state.agent


@router.post("/resume-simulated")
async def resume_simulated(rt: Runtime = Depends(get_runtime)) -> AgentConfig:
    if rt.settings.happyrobot_mode != "simulated":
        raise HTTPException(409, "esta operación solo permite envíos simulados")
    async with rt.orchestrator.edit() as state:
        state.agent.mode = AgentMode.running
    await rt.orchestrator.dispatch_pending()
    rt.orchestrator.start(autoplan=True)
    return rt.state.agent


@router.post("/tick")
async def tick(rt: Runtime = Depends(get_runtime)) -> Decision:
    return await rt.orchestrator.tick("manual")


@router.post("/dispatch")
async def dispatch(rt: Runtime = Depends(get_runtime)) -> dict[str, str]:
    await rt.orchestrator.dispatch_pending()
    return {"agent_mode": rt.state.agent.mode}


class ApprovalIn(BaseModel):
    approved: bool = True
    note: str = ""
    confirm_location: bool = False
    expected_updated_at: AwareDatetime | None = None


@router.post("/tasks/{task_id}/approve")
async def approve(task_id: str, body: ApprovalIn, rt: Runtime = Depends(get_runtime)) -> Task:
    if task_id not in rt.state.tasks:
        raise HTTPException(404)
    await rt.orchestrator.approve(
        task_id,
        body.approved,
        body.note,
        confirm_location=body.confirm_location,
        expected_updated_at=body.expected_updated_at,
    )
    return rt.state.tasks[task_id]


class GeocodeIn(BaseModel):
    expected_timestamp: AwareDatetime


@router.post("/incoming-calls/{run_id}/geocode")
async def geocode_report(
    run_id: str, body: GeocodeIn, rt: Runtime = Depends(get_runtime)
) -> LocationResolution:
    """Reintento explícito: el agente ya lo intenta solo al recibir el aviso."""
    if run_id not in rt.state.incoming_calls:
        raise HTTPException(404, "aviso desconocido")
    if not rt.geocoder.enabled:
        raise HTTPException(409, "geocodificación desactivada")
    return await rt.geocode_report(run_id, body.expected_timestamp, retry=True)


class ConfirmLocationIn(BaseModel):
    expected_timestamp: AwareDatetime
    location: GeocodedPlace


@router.post("/incoming-calls/{run_id}/location")
async def confirm_report_location(
    run_id: str, body: ConfirmLocationIn, rt: Runtime = Depends(get_runtime)
) -> IncomingCall:
    async with rt.orchestrator.edit() as state:
        report = state.incoming_calls.get(run_id)
        if not report:
            raise HTTPException(404, "aviso desconocido")
        if report.timestamp != body.expected_timestamp:
            raise HTTPException(409, "el aviso ha cambiado; revisa la ubicación actual")
        if body.location.kind in COARSE_PLACES:
            raise HTTPException(
                422, "el centro de una población no localiza el incidente; concreta la dirección"
            )
        if any(
            task.incoming_call_id == run_id
            and (task.approved_at or task.action_ids)
            and task.status not in (TaskStatus.cancelled, TaskStatus.done, TaskStatus.failed)
            for task in state.tasks.values()
        ):
            raise HTTPException(
                409, "hay una misión en curso; cancélala antes de cambiar su destino"
            )
        report.resolution = report.resolution.model_copy(
            update={
                "status": "confirmed",
                "selected": body.location,
                "provider": "operator",
                "error": "",
            }
        )
        prepare_intake_tasks(state, report)
        state.add_event(
            Event(
                source=EventSource.operator,
                kind=EventKind.note,
                title="Ubicación de aviso confirmada por operador",
                payload={"run_id": run_id},
            )
        )
    return rt.state.incoming_calls[run_id]


class PriorityIn(BaseModel):
    priority: int = Field(ge=0, le=100)
    reason: str = Field(default="Override del operador", max_length=2000)
    expected_updated_at: AwareDatetime | None = None


@router.post("/tasks/{task_id}/priority")
async def override_priority(
    task_id: str, body: PriorityIn, rt: Runtime = Depends(get_runtime)
) -> Task:
    async with rt.orchestrator.edit() as state:
        t = state.tasks.get(task_id)
        if not t:
            raise HTTPException(404)
        if body.expected_updated_at and body.expected_updated_at != t.updated_at:
            raise HTTPException(409, "la tarea ha cambiado; revisa su estado actual")
        t.priority = body.priority
        t.priority_reason = body.reason
        state.upsert_task(t)
        state.add_event(
            Event(
                source=EventSource.operator,
                kind=EventKind.note,
                title=f"Prioridad actualizada: {t.title}",
                payload={"task_id": t.id, "summary": f"Prioridad {t.priority}. {body.reason}"},
            )
        )
    return rt.state.tasks[task_id]


class StatusIn(BaseModel):
    status: TaskStatus
    outcome: str = Field(default="", max_length=2000)
    expected_updated_at: AwareDatetime | None = None


@router.post("/tasks/{task_id}/status")
async def set_status(task_id: str, body: StatusIn, rt: Runtime = Depends(get_runtime)) -> Task:
    async with rt.orchestrator.edit() as state:
        t = state.tasks.get(task_id)
        if not t:
            raise HTTPException(404)
        if body.expected_updated_at and body.expected_updated_at != t.updated_at:
            raise HTTPException(409, "la tarea ha cambiado; revisa su estado actual")
        if body.status == TaskStatus.cancelled:
            if t.status in (TaskStatus.done, TaskStatus.rejected, TaskStatus.failed):
                raise HTTPException(409, "la misión ya está cerrada")
            await rt.executor.bind(state).cancel_task(t, body.outcome or "Cancelada por operador")
        elif body.status == TaskStatus.done:
            rt.executor.bind(state).complete_task(t, body.outcome)
        else:
            raise HTTPException(409, "usa aprobación o una observación de estado de la unidad")
        state.add_event(
            Event(
                source=EventSource.operator,
                kind=EventKind.note,
                title=f"Misión actualizada: {t.title}",
                payload={"task_id": t.id, "summary": f"{t.status}: {t.outcome}"},
            )
        )
    await rt.orchestrator.dispatch_pending()
    return rt.state.tasks[task_id]


@router.post("/questions", status_code=201)
async def create_question(
    body: CoordinationQuestionIn, rt: Runtime = Depends(get_runtime)
) -> CoordinationQuestion:
    return await rt.orchestrator.create_question(body)


@router.post("/questions/{question_id}/answer")
async def answer_question(
    question_id: str, body: CoordinationAnswer, rt: Runtime = Depends(get_runtime)
) -> CoordinationQuestion:
    if question_id not in rt.state.coordination_questions:
        raise HTTPException(404, "pregunta desconocida")
    return await rt.orchestrator.answer_question(question_id, body)


@router.post("/questions/demo", status_code=201)
async def demo_question(rt: Runtime = Depends(get_runtime)) -> CoordinationQuestion:
    if not rt.settings.seed_demo or rt.settings.happyrobot_mode != "simulated":
        raise HTTPException(
            409, "las preguntas de prueba solo están disponibles en la demo simulada"
        )
    candidates = [f"call:{run_id}" for run_id in rt.state.incoming_calls] + list(rt.state.zones)
    if not candidates:
        raise HTTPException(409, "no hay incidencias para preparar una pregunta")
    sequence = len(rt.state.coordination_questions)
    incident_id = candidates[sequence % len(candidates)]
    input_kind = ("options", "text", "mixed")[sequence % 3]
    body = CoordinationQuestionIn.model_validate(
        {
            "incidentId": incident_id,
            "prompt": (
                f"Revisión de coordinación de {incident_id}: "
                "¿mantener el plan o registrar una instrucción?"
            ),
            "urgency": ("moderate", "critical", "high")[sequence % 3],
            "input": input_kind,
            "options": []
            if input_kind == "text"
            else [
                {
                    "id": "maintain",
                    "label": "Mantener la actuación actual",
                    "action": {"type": "none"},
                },
                {
                    "id": "review",
                    "label": "Registrar revisión de accesos",
                    "action": {"type": "note"},
                },
            ],
            "defaultAnswer": {
                "optionIds": [] if input_kind == "text" else ["maintain"],
                "text": "Mantener el plan y solicitar revisión del coordinador."
                if input_kind == "text"
                else "",
                "custom": input_kind == "text",
            },
        }
    )
    return await rt.orchestrator.create_question(body)


class ManualTaskIn(BaseModel):
    kind: TaskKind = TaskKind.other
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=10000)
    priority: int = Field(default=50, ge=0, le=100)
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
        if not body.title.strip():
            raise HTTPException(422, "el título no puede estar vacío")
        if body.zone_id and body.zone_id not in (state.zones | state.fronts | state.roads):
            raise HTTPException(404, "destino desconocido")
        if body.contact_id and body.contact_id not in state.contacts:
            raise HTTPException(404, "contacto desconocido")
        t.requires_approval = needs_confirmation(state.agent, t.kind, None)
        t.status = TaskStatus.awaiting_approval if t.requires_approval else TaskStatus.proposed
        types = body.resource_types or {
            TaskKind.dispatch_resource: [ResourceType.fire_engine, ResourceType.helicopter],
            TaskKind.medical_triage: [ResourceType.ambulance],
            TaskKind.close_road: [ResourceType.police_unit],
            TaskKind.evacuate_zone: [ResourceType.evacuation_bus],
        }.get(t.kind, [])
        roles = body.contact_roles or {
            TaskKind.warn_civilian: [ContactRole.civilian],
            TaskKind.brief_authority: [ContactRole.mayor],
            TaskKind.open_shelter: [ContactRole.shelter],
        }.get(t.kind, [])
        await rt.executor.bind(state).execute(Proposal(t, types, roles), {})
        state.add_event(
            Event(
                source=EventSource.operator,
                kind=EventKind.note,
                title=f"Misión creada: {t.title}",
                payload={"task_id": t.id},
            )
        )
    await rt.orchestrator.dispatch_pending()
    return rt.state.tasks[t.id]


class CallIn(BaseModel):
    contact_id: str
    instructions: str = Field(min_length=1, max_length=4096)
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
        if not body.instructions.strip():
            raise HTTPException(422, "las instrucciones no pueden estar vacías")
        task.description = body.instructions.strip()
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
    title: str = Field(min_length=1, max_length=2000)
    zone_id: str | None = None
    incident_id: str | None = None


@router.post("/note", status_code=202)
async def operator_note(body: NoteIn, rt: Runtime = Depends(get_runtime)) -> Event:
    if not body.title.strip():
        raise HTTPException(422, "la nota no puede estar vacía")
    incident_id = body.incident_id or body.zone_id or rt.orchestrator.incident_id
    known = {rt.orchestrator.incident_id, *rt.state.zones, *rt.state.fronts, *rt.state.roads}
    known.update(f"call:{run_id}" for run_id in rt.state.incoming_calls)
    if incident_id not in known:
        raise HTTPException(404, "incidencia desconocida")
    return await rt.orchestrator.ingest_event(
        Event(
            source=EventSource.operator,
            kind=EventKind.note,
            title=body.title.strip(),
            zone_id=body.zone_id,
            payload={"incident_id": incident_id, "summary": body.title.strip()},
        )
    )


class AgentConfigIn(BaseModel):
    autonomous: bool | None = None
    approval_required_for: list[TaskKind] | None = None
    approval_required_severities: list[str] | None = None
    tick_seconds: float | None = Field(default=None, ge=0.1)
    hold_seconds: float | None = Field(default=None, ge=0)
    escalate_after_seconds: float | None = Field(default=None, ge=0)


@router.patch("/agent")
async def configure_agent(body: AgentConfigIn, rt: Runtime = Depends(get_runtime)) -> AgentConfig:
    async with rt.orchestrator.edit() as state:
        for field, value in body.model_dump(exclude_none=True).items():
            setattr(state.agent, field, value)
        for task in state.open_tasks():
            if task.approved_at or any(
                state.actions[aid].status not in (ActionStatus.pending, ActionStatus.skipped)
                for aid in task.action_ids
            ):
                continue
            report = state.incoming_calls.get(task.incoming_call_id or "")
            required = needs_confirmation(
                state.agent, task.kind, report.severity if report else None
            )
            if task.requires_approval == required:
                continue
            if required:
                await rt.executor.bind(state).cancel_task(
                    task, "Cambio de política: requiere confirmación"
                )
                task.resource_ids = []
                task.status = TaskStatus.awaiting_approval
                task.hold_until = None
                task.outcome = "Pendiente de confirmación por la política actualizada"
                task.cancellation_requested = False
            elif task.status == TaskStatus.awaiting_approval:
                task.status = TaskStatus.proposed
                task.hold_until = hold_until(state.agent, False)
                task.outcome = ""
            task.requires_approval = required
            task.autonomous = not required
            state.upsert_task(task)
        state.add_event(
            Event(
                source=EventSource.operator,
                kind=EventKind.note,
                title="Política del agente actualizada por operador",
            )
        )
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
    if (
        body.tasks
        or body.recent_actions
        or body.recent_events
        or body.recent_decisions
        or body.coordination_questions
    ):
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

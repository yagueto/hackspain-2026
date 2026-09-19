"""Intervención humana: pausar, aprobar, forzar prioridades, lanzar llamadas a mano."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.api.deps import require_api_key
from app.domain.models import (
    Action,
    AgentConfig,
    AgentMode,
    Decision,
    Event,
    EventKind,
    EventSource,
    Task,
    TaskKind,
    TaskStatus,
)
from app.runtime import Runtime, get_runtime

router = APIRouter(prefix="/control", tags=["control"], dependencies=[Depends(require_api_key)])


@router.post("/pause")
async def pause(rt: Runtime = Depends(get_runtime)) -> AgentConfig:
    rt.state.agent.mode = AgentMode.paused
    return rt.state.set_agent(rt.state.agent)


@router.post("/resume")
async def resume(rt: Runtime = Depends(get_runtime)) -> AgentConfig:
    rt.state.agent.mode = AgentMode.running
    rt.state.dirty.set()
    return rt.state.set_agent(rt.state.agent)


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
    t = rt.state.tasks.get(task_id)
    if not t:
        raise HTTPException(404)
    t.priority = max(0, min(100, body.priority))
    t.priority_reason = body.reason
    return rt.state.upsert_task(t)


class StatusIn(BaseModel):
    status: TaskStatus
    outcome: str = ""


@router.post("/tasks/{task_id}/status")
async def set_status(task_id: str, body: StatusIn, rt: Runtime = Depends(get_runtime)) -> Task:
    t = rt.state.tasks.get(task_id)
    if not t:
        raise HTTPException(404)
    if body.status == TaskStatus.cancelled:
        await rt.executor.cancel_task(t, body.outcome or "Cancelada por operador")
        return rt.state.tasks[task_id]
    return rt.state.set_task_status(task_id, body.status, body.outcome)


class ManualTaskIn(BaseModel):
    kind: TaskKind = TaskKind.other
    title: str
    description: str = ""
    priority: int = 50
    zone_id: str | None = None
    contact_id: str | None = None


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
    rt.state.upsert_task(t)
    if body.contact_id and body.contact_id in rt.state.contacts:
        await rt.executor.call(t, rt.state.contacts[body.contact_id])
    return t


class CallIn(BaseModel):
    contact_id: str
    instructions: str
    task_id: str | None = None


@router.post("/call")
async def manual_call(body: CallIn, rt: Runtime = Depends(get_runtime)) -> Action:
    contact = rt.state.contacts.get(body.contact_id)
    if not contact:
        raise HTTPException(404, "contacto no existe")
    task = rt.state.tasks.get(body.task_id or "") or Task(
        kind=TaskKind.other,
        title=f"Llamada manual a {contact.name}",
        description=body.instructions,
        priority=50,
        priority_reason="Lanzada por operador",
        assignee_contact_id=contact.id,
        status=TaskStatus.dispatching,
    )
    rt.state.upsert_task(task)
    return await rt.executor.call(task, contact)


class SmsIn(BaseModel):
    contact_id: str
    message: str


@router.post("/sms")
async def manual_sms(body: SmsIn, rt: Runtime = Depends(get_runtime)) -> Action:
    contact = rt.state.contacts.get(body.contact_id)
    if not contact:
        raise HTTPException(404, "contacto no existe")
    return await rt.executor.sms(contact, body.message)


class NoteIn(BaseModel):
    title: str
    zone_id: str | None = None


@router.post("/note", status_code=202)
async def operator_note(body: NoteIn, rt: Runtime = Depends(get_runtime)) -> Event:
    return rt.state.add_event(
        Event(
            source=EventSource.operator, kind=EventKind.note, title=body.title, zone_id=body.zone_id
        )
    )


class AgentConfigIn(BaseModel):
    approval_required_for: list[TaskKind] | None = None
    tick_seconds: float | None = None


@router.patch("/agent")
async def configure_agent(body: AgentConfigIn, rt: Runtime = Depends(get_runtime)) -> AgentConfig:
    a = rt.state.agent
    if body.approval_required_for is not None:
        a.approval_required_for = body.approval_required_for
    if body.tick_seconds is not None:
        a.tick_seconds = body.tick_seconds
        rt.orchestrator.tick_seconds = body.tick_seconds
    return rt.state.set_agent(a)

"""Recibe los resultados de HappyRobot (variables extraídas de llamadas y mensajes).

El workflow de HappyRobot, en su último nodo, hace un POST aquí con el JSON que haya
extraído de la conversación. El contrato es deliberadamente laxo: solo `task_id` (o
`action_id`/`run_id`) es necesario para enlazar; el resto son variables opcionales.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from app.domain.models import (
    ActionStatus,
    Event,
    EventKind,
    EventSource,
    ResourceStatus,
    Severity,
    TaskStatus,
    now,
)
from app.runtime import Runtime, get_runtime

log = logging.getLogger(__name__)
router = APIRouter(prefix="/webhooks", tags=["webhooks"])

Outcome = Literal["accepted", "rejected", "no_answer", "voicemail", "busy", "failed", "info"]


class CallOutcome(BaseModel):
    """Variables que extrae el agente de voz. Todas opcionales salvo el enlace."""

    task_id: str | None = None
    action_id: str | None = None
    run_id: str | None = None
    session_id: str | None = None
    contact_id: str | None = None
    phone: str | None = None

    outcome: Outcome = "info"
    eta_minutes: float | None = None
    injured_count: int | None = None
    civilians_count: int | None = None
    road_blocked: str | None = None  # id o nombre de carretera
    needs_medical: bool | None = None
    evacuation_confirmed: bool | None = None
    shelter_capacity: int | None = None
    resource_status: ResourceStatus | None = None
    summary: str = ""
    transcript: str = ""
    extra: dict[str, Any] = Field(default_factory=dict)


def _check_secret(rt: Runtime, secret: str | None) -> None:
    expected = rt.settings.happyrobot_webhook_secret
    if expected and secret != expected:
        raise HTTPException(401, "webhook secret inválido")


@router.post("/happyrobot", status_code=202)
async def happyrobot_webhook(
    body: CallOutcome,
    rt: Runtime = Depends(get_runtime),
    x_webhook_secret: str | None = Header(default=None),
) -> dict[str, Any]:
    _check_secret(rt, x_webhook_secret)
    s = rt.state

    action = None
    if body.action_id:
        action = s.actions.get(body.action_id)
    if action is None and body.run_id:
        action = next((a for a in s.actions.values() if a.happyrobot_run_id == body.run_id), None)
    if action is None and body.task_id:
        t = s.tasks.get(body.task_id)
        if t and t.action_ids:
            action = s.actions.get(t.action_ids[-1])

    task = s.tasks.get(body.task_id or (action.task_id if action else "") or "")
    contact_id = body.contact_id or (action.contact_id if action else None)
    contact = s.contacts.get(contact_id or "")
    if contact is None and body.phone:
        contact = next((c for c in s.contacts.values() if c.phone == body.phone), None)

    success = body.outcome in ("accepted", "info")
    if action:
        action.status = ActionStatus.completed if success else ActionStatus.failed
        action.result = {**action.result, "webhook": body.model_dump(mode="json")}
        s.upsert_action(action)

    facts: list[str] = []
    if task:
        if body.outcome == "accepted":
            task.status = TaskStatus.accepted
            facts.append(f"{task.title}: aceptada")
            if body.eta_minutes is not None:
                for rid in task.resource_ids:
                    r = s.resources.get(rid)
                    if r:
                        r.eta_minutes = body.eta_minutes
                        s.upsert_resource(r)
                facts.append(f"ETA {body.eta_minutes:.0f} min")
            if (
                task.kind == "evacuate_zone"
                and task.zone_id in s.zones
                and body.evacuation_confirmed
            ):
                z = s.zones[task.zone_id]
                z.evacuation_status = "in_progress"
                s.upsert_zone(z)
        elif body.outcome in ("rejected", "no_answer", "voicemail", "busy", "failed"):
            task.status = TaskStatus.failed
            task.outcome = f"{body.outcome}: {body.summary}"
            for rid in task.resource_ids:
                r = s.resources.get(rid)
                if r and r.assigned_task_id == task.id:
                    r.status = ResourceStatus.available
                    r.assigned_task_id = None
                    r.assigned_zone_id = None
                    s.upsert_resource(r)
            facts.append(f"{task.title}: {body.outcome}, medios liberados")
        if body.summary:
            task.outcome = body.summary
        s.upsert_task(task)

    if contact:
        contact.reliability = round(contact.reliability * 0.7 + (1.0 if success else 0.0) * 0.3, 3)
        s.upsert_contact(contact)
        await rt.store.add_lesson(
            ts=now().isoformat(),
            action_kind=action.kind.value if action else "call",
            success=success,
            detail=f"{body.outcome}: {body.summary}"[:500],
            contact_id=contact.id,
            role=contact.role.value,
        )

    # Información nueva que llega por la conversación -> eventos para el orquestador.
    zone_id = task.zone_id if task else (contact.zone_id if contact else None)
    derived: list[Event] = []
    if body.injured_count:
        derived.append(
            Event(
                source=EventSource.happyrobot,
                kind=EventKind.injured_reported,
                severity=Severity.high,
                title=f"Heridos reportados por teléfono: {body.injured_count}",
                payload={"count": body.injured_count},
                zone_id=zone_id,
            )
        )
    if body.civilians_count is not None:
        derived.append(
            Event(
                source=EventSource.happyrobot,
                kind=EventKind.civilians_reported,
                title=f"Personas presentes según llamada: {body.civilians_count}",
                payload={"count": body.civilians_count},
                zone_id=zone_id,
            )
        )
    if body.road_blocked:
        road = s.roads.get(body.road_blocked) or next(
            (r for r in s.roads.values() if r.name.lower() == body.road_blocked.lower()), None
        )
        if road:
            derived.append(
                Event(
                    source=EventSource.happyrobot,
                    kind=EventKind.road_blocked,
                    severity=Severity.high,
                    title=f"Carretera cortada según llamada: {road.name}",
                    payload={"road_id": road.id, "reason": body.summary or "reportado en llamada"},
                )
            )
    if body.resource_status and task and task.resource_ids:
        derived.append(
            Event(
                source=EventSource.happyrobot,
                kind=EventKind.resource_status,
                title=f"Estado de medio: {body.resource_status}",
                payload={"resource_id": task.resource_ids[0], "status": body.resource_status},
            )
        )
    if body.shelter_capacity is not None and zone_id in s.zones:
        z = s.zones[zone_id]
        z.shelter_capacity = body.shelter_capacity
        s.upsert_zone(z)

    s.add_event(
        Event(
            source=EventSource.happyrobot,
            kind=EventKind.call_outcome
            if (action is None or action.kind == "call")
            else EventKind.message_outcome,
            severity=Severity.medium if success else Severity.high,
            title=f"HappyRobot: {contact.name if contact else body.phone or '?'} -> {body.outcome}",
            payload={"facts": facts, **body.model_dump(mode="json", exclude={"transcript"})},
            zone_id=zone_id,
        )
    )
    for e in derived:
        s.add_event(e)

    return {"ok": True, "task_id": task.id if task else None, "derived_events": len(derived)}

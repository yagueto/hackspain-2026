"""Ingesta de señales: sensores, 112, partes de campo, simulador."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.api.deps import require_api_key
from app.domain.models import Event, EventKind, EventSource, Severity
from app.runtime import Runtime, get_runtime

router = APIRouter(prefix="/events", tags=["events"])


class EventIn(BaseModel):
    source: EventSource = EventSource.simulator
    kind: EventKind
    severity: Severity = Severity.medium
    title: str
    payload: dict[str, Any] = Field(default_factory=dict)
    zone_id: str | None = None


@router.post("", status_code=202, dependencies=[Depends(require_api_key)])
async def ingest(body: EventIn, rt: Runtime = Depends(get_runtime)) -> Event:
    return rt.state.add_event(Event(**body.model_dump()))


@router.post("/batch", status_code=202, dependencies=[Depends(require_api_key)])
async def ingest_batch(body: list[EventIn], rt: Runtime = Depends(get_runtime)) -> list[Event]:
    return [rt.state.add_event(Event(**b.model_dump())) for b in body]


@router.get("")
async def list_events(
    limit: int = 100,
    relevant: bool | None = None,
    kind: EventKind | None = None,
    rt: Runtime = Depends(get_runtime),
) -> list[Event]:
    evs = list(rt.state.events)[::-1]
    if relevant is not None:
        evs = [e for e in evs if e.relevant is relevant]
    if kind:
        evs = [e for e in evs if e.kind == kind]
    return evs[:limit]

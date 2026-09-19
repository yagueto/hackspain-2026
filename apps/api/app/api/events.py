"""Ingesta de señales: sensores, 112, partes de campo, simulador."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import AwareDatetime, BaseModel, Field

from app.api.deps import require_api_key
from app.domain.models import (
    Event,
    EventKind,
    EventSource,
    Observation,
    Receipt,
    Severity,
    new_id,
    now,
)
from app.runtime import Runtime, get_runtime

router = APIRouter(tags=["events"])


class EventIn(BaseModel):
    observation_id: str | None = None
    observed_at: AwareDatetime | None = None
    source: EventSource = EventSource.simulator
    kind: EventKind
    severity: Severity = Severity.medium
    title: str
    payload: dict[str, Any] = Field(default_factory=dict)
    zone_id: str | None = None


@router.post("/events", status_code=202, dependencies=[Depends(require_api_key)])
async def ingest(body: EventIn, rt: Runtime = Depends(get_runtime)) -> Event:
    return await rt.orchestrator.ingest_event(
        Event(
            **body.model_dump(exclude={"observation_id", "observed_at"}),
            id=body.observation_id or new_id("evt"),
            ts=body.observed_at or now(),
        )
    )


@router.post("/events/batch", status_code=202, dependencies=[Depends(require_api_key)])
async def ingest_batch(body: list[EventIn], rt: Runtime = Depends(get_runtime)) -> list[Event]:
    return [await ingest(b, rt) for b in body]


@router.post("/observations", status_code=202, dependencies=[Depends(require_api_key)])
async def ingest_observation(body: Observation, rt: Runtime = Depends(get_runtime)) -> Observation:
    await rt.orchestrator.ingest(body)
    await rt.orchestrator.synchronize()
    return body


@router.get("/receipts", dependencies=[Depends(require_api_key)])
async def receipts(rt: Runtime = Depends(get_runtime)) -> list[Receipt]:
    return await rt.store.receipts(rt.orchestrator.incident_id)


@router.get("/events")
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

"""Lectura del estado para el dashboard."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.domain.models import Action, Contact, Decision, Resource, Task, TaskStatus, WorldSnapshot
from app.runtime import Runtime, get_runtime

router = APIRouter(tags=["state"])


@router.get("/meta")
async def get_meta(rt: Runtime = Depends(get_runtime)) -> dict[str, str | bool | float]:
    return {
        "seed_demo": rt.settings.seed_demo,
        "happyrobot_mode": rt.settings.happyrobot_mode,
        "storage": rt.settings.storage_backend,
        "geocoding_enabled": rt.geocoder.enabled,
        "autonomous": rt.state.agent.autonomous,
        "hold_seconds": rt.state.agent.hold_seconds,
        "escalate_after_seconds": rt.state.agent.escalate_after_seconds,
    }


@router.get("/state")
async def get_state(rt: Runtime = Depends(get_runtime)) -> WorldSnapshot:
    try:
        return rt.state.snapshot()
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/tasks")
async def list_tasks(
    status: TaskStatus | None = None, rt: Runtime = Depends(get_runtime)
) -> list[Task]:
    tasks = sorted(rt.state.tasks.values(), key=lambda t: -t.priority)
    return [t for t in tasks if status is None or t.status == status]


@router.get("/tasks/{task_id}")
async def get_task(task_id: str, rt: Runtime = Depends(get_runtime)) -> Task:
    t = rt.state.tasks.get(task_id)
    if not t:
        raise HTTPException(404)
    return t


@router.get("/resources")
async def list_resources(rt: Runtime = Depends(get_runtime)) -> list[Resource]:
    return list(rt.state.resources.values())


@router.get("/contacts")
async def list_contacts(rt: Runtime = Depends(get_runtime)) -> list[Contact]:
    return list(rt.state.contacts.values())


@router.get("/decisions")
async def list_decisions(limit: int = 20, rt: Runtime = Depends(get_runtime)) -> list[Decision]:
    return list(rt.state.decisions)[::-1][:limit]


@router.get("/actions")
async def list_actions(limit: int = 50, rt: Runtime = Depends(get_runtime)) -> list[Action]:
    return sorted(rt.state.actions.values(), key=lambda a: a.ts, reverse=True)[:limit]


@router.get("/timeline")
async def timeline(limit: int = 100, rt: Runtime = Depends(get_runtime)) -> list[dict[str, Any]]:
    """Eventos, decisiones y acciones mezclados en orden temporal."""
    items: list[dict[str, Any]] = []
    items += [{"type": "event", "ts": e.ts, **e.model_dump(mode="json")} for e in rt.state.events]
    items += [
        {"type": "decision", "ts": d.ts, **d.model_dump(mode="json")} for d in rt.state.decisions
    ]
    items += [
        {"type": "action", "ts": a.ts, **a.model_dump(mode="json")}
        for a in rt.state.actions.values()
    ]
    items.sort(key=lambda i: i["ts"], reverse=True)
    return items[:limit]


@router.get("/history/runs")
async def past_runs(rt: Runtime = Depends(get_runtime)) -> list[dict[str, Any]]:
    return await rt.store.past_runs()


@router.get("/history/runs/{run_id}")
async def run_journal(
    run_id: str, kind: str | None = None, rt: Runtime = Depends(get_runtime)
) -> list[dict[str, Any]]:
    return await rt.store.journal_for_run(run_id, kind)


@router.get("/history/lessons")
async def lessons(rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    return {
        "contact_reliability": await rt.store.contact_reliability(rt.orchestrator.incident_id),
        "recent": await rt.store.lessons_summary(50),
    }

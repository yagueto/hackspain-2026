import hashlib
import hmac

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import JsonValue

from app.domain.models import CallOutcome, EventKind, Observation
from app.domain.observations import resolve_action
from app.runtime import Runtime, get_runtime

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


@router.post("/happyrobot", status_code=202)
async def happyrobot_webhook(
    body: CallOutcome,
    rt: Runtime = Depends(get_runtime),
    x_webhook_secret: str | None = Header(default=None),
) -> dict[str, JsonValue]:
    expected = rt.settings.happyrobot_webhook_secret
    if expected and not hmac.compare_digest(expected, x_webhook_secret or ""):
        raise HTTPException(401, "webhook secret inválido")
    await rt.orchestrator.synchronize()
    try:
        action = resolve_action(rt.state, body)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    digest = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
    observation = Observation(
        observation_id=body.observation_id or f"hr_{digest}",
        incident_id=rt.orchestrator.incident_id,
        kind=EventKind.call_outcome,
        command_id=action.id,
        source_run_id=body.run_id,
        observed_at=body.observed_at or action.ts,
        title=f"HappyRobot: {body.outcome}",
        payload=body.model_dump(mode="json"),
    )
    await rt.orchestrator.ingest(observation)
    await rt.orchestrator.synchronize()
    derived = sum(e.id.startswith(f"{observation.observation_id}:") for e in rt.state.events)
    return {
        "ok": True,
        "observation_id": observation.observation_id,
        "task_id": action.task_id,
        "derived_events": derived,
    }

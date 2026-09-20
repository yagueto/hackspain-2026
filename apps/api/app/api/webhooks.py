import hashlib
import hmac

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import JsonValue

from app.domain.models import (
    ActionKind,
    CallOutcome,
    EventKind,
    IncomingCallIn,
    Observation,
    Severity,
    TaskStatus,
)
from app.domain.observations import apply_observation, resolve_action
from app.runtime import Runtime, get_runtime

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


@router.post("/happyrobot/inbound", status_code=202)
async def incoming_call_webhook(
    body: IncomingCallIn,
    rt: Runtime = Depends(get_runtime),
    x_webhook_secret: str | None = Header(default=None),
) -> dict[str, JsonValue]:
    expected = rt.settings.happyrobot_webhook_secret
    if expected and not hmac.compare_digest(expected, x_webhook_secret or ""):
        raise HTTPException(401, "webhook secret inválido")
    await rt.orchestrator.synchronize()
    digest = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
    observation = Observation(
        observation_id=f"inbound_{digest}",
        incident_id=rt.orchestrator.incident_id,
        kind=EventKind.incoming_call,
        source_run_id=body.run_id,
        observed_at=body.timestamp,
        title=f"Aviso ciudadano: {body.emergency_type}",
        severity={
            "vital": Severity.critical,
            "grave": Severity.high,
            "moderada": Severity.medium,
            "leve": Severity.low,
            "no_emergencia": Severity.low,
        }[body.severity],
        payload=body.model_dump(mode="json"),
    )
    try:
        apply_observation(rt.state.copy(), observation)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    await rt.orchestrator.ingest(observation)
    await rt.orchestrator.synchronize()
    receipt = next(
        r
        for r in await rt.store.receipts(rt.orchestrator.incident_id)
        if r.observation_id == observation.observation_id
    )
    if receipt.status == "invalid":
        raise HTTPException(422, receipt.reason)
    # La decisión no espera a nadie: se asigna el medio y se prepara la orden aquí mismo.
    # Enviarla es cosa del outbox, que respeta la ventana para anular y la parada.
    # La localización sin GPS, en cambio, la resuelve el bucle: quien llama es el workflow
    # que está atendiendo al ciudadano y no debe esperar a un proveedor externo.
    if receipt.status == "applied":
        await rt.orchestrator.reconcile_intake()
    tasks = [t for t in rt.state.tasks.values() if t.incoming_call_id == body.run_id]
    return {
        "ok": True,
        "status": receipt.status,
        "observation_id": observation.observation_id,
        "run_id": body.run_id,
        "location_confirmed": body.location.confirmed and body.location.lat is not None,
        "requires_operator": any(
            t.status == TaskStatus.awaiting_approval or t.blocked_reason for t in tasks
        ),
    }


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
        if action.kind not in (ActionKind.call, ActionKind.telegram):
            raise ValueError("la orden no corresponde a HappyRobot")
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    digest = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
    observation = Observation(
        observation_id=body.observation_id or f"hr_{digest}",
        incident_id=rt.orchestrator.incident_id,
        kind=(
            EventKind.message_outcome
            if action.kind == ActionKind.telegram
            else EventKind.call_outcome
        ),
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

"""Avisos de texto: el backend dispara el workflow de HappyRobot, que hace el POST a Telegram.

El backend no habla con api.telegram.org ni con ningún puente propio: solo confía el envío a
HappyRobot y espera el resultado por el webhook de observaciones.
"""

from typing import Any

import httpx
import pytest

from app.config import Settings
from app.domain.models import ActionKind, ActionStatus, AgentMode, now
from app.domain.scenario import seed_wildfire
from app.domain.state import WorldState
from app.integrations.happyrobot import HappyRobotClient
from app.main import build_runtime
from app.runtime import Runtime
from app.store.persistence import MemoryStore
from tests.conftest import HEADERS

AVISO = {"contact_id": "ct_camping", "message": "Aviso de prueba"}


async def seeded_runtime(settings: Settings) -> Runtime:
    state, store = WorldState(), MemoryStore()
    seed_wildfire(state)
    await store.create(state.snapshot(full=True))
    return build_runtime(settings, state=state, store=store)


def live_settings(**kw: Any) -> Settings:
    return Settings(
        happyrobot_mode="live",
        happyrobot_api_key="test-only-key",
        happyrobot_webhook_secret="test-only-secret",
        agent_autostart=False,
        **kw,
    )


async def use_mock_transport(rt: Runtime, handler: Any) -> None:
    """Sustituye el cliente live por uno con MockTransport (el real está bloqueado en tests)."""
    await rt.hr.aclose()
    rt.hr = HappyRobotClient(
        rt.settings,
        httpx.AsyncClient(
            base_url=rt.settings.happyrobot_base_url, transport=httpx.MockTransport(handler)
        ),
    )
    rt.executor.hr = rt.hr


async def test_telegram_route_and_sms_alias_trigger_the_workflow(client: httpx.AsyncClient) -> None:
    for path in ("telegram", "sms"):
        denied = await client.post(f"/api/v1/control/{path}", json=AVISO)
        assert denied.status_code == 401
        response = await client.post(f"/api/v1/control/{path}", headers=HEADERS, json=AVISO)
        assert response.status_code == 200
        action = response.json()
        assert action["kind"] == "telegram"
        assert action["workflow"] == "send_telegram"
        # Queda a la espera del resultado del workflow, no completada por haber salido.
        assert action["status"] == "dispatched"
        assert action["happyrobot_run_id"].startswith("fake_")
        assert action["request"]["channel"] == "telegram"
        # El chat lo resuelve HappyRobot: un teléfono no es un chat de Telegram.
        assert "phone" not in action["request"]
        assert "chat_id" not in action["request"]


async def test_workflow_receives_the_documented_payload() -> None:
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"run_id": "run_tg_1", "status": "queued"})

    rt = await seeded_runtime(live_settings(happyrobot_wf_telegram="wf_tg"))
    await use_mock_transport(rt, handle)
    try:
        message = 'Aviso: línea uno\n"Atención" \\ punto de reunión'
        async with rt.orchestrator.edit() as candidate:
            action = await rt.executor.bind(candidate).message(
                candidate.contacts["ct_camping"], message
            )
        await rt.orchestrator.dispatch_pending()
        assert rt.state.actions[action.id].status == ActionStatus.dispatched
        assert rt.state.actions[action.id].happyrobot_run_id == "run_tg_1"
        assert len(requests) == 1
        assert requests[0].url.path.endswith("/workflows/wf_tg/runs")
        body = requests[0].read().decode()
        assert '"environment"' in body
        assert rt.state.actions[action.id].request == {
            "channel": "telegram",
            "command_id": action.id,
            "action_id": action.id,
            "incident_id": rt.state.incident.id if rt.state.incident else "",
            "contact_id": "ct_camping",
            "contact_name": rt.state.contacts["ct_camping"].name,
            "message": message,
            "callback_url": f"{rt.settings.public_base_url}/api/v1/webhooks/happyrobot",
        }
    finally:
        await rt.hr.aclose()


async def test_unconfigured_workflow_fails_without_sending() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no debe llamar a HappyRobot sin workflow configurado")

    rt = await seeded_runtime(live_settings(happyrobot_wf_telegram=""))
    await use_mock_transport(rt, handle)
    try:
        async with rt.orchestrator.edit() as candidate:
            action = await rt.executor.bind(candidate).message(
                candidate.contacts["ct_camping"], "aviso"
            )
        await rt.orchestrator.dispatch_pending()
        assert rt.state.actions[action.id].status == ActionStatus.failed
        assert "HAPPYROBOT_WF" in rt.state.actions[action.id].error
    finally:
        await rt.hr.aclose()


async def test_callback_closes_the_aviso_without_moving_reliability(
    client: httpx.AsyncClient,
) -> None:
    action = (await client.post("/api/v1/control/telegram", headers=HEADERS, json=AVISO)).json()
    contacts = (await client.get("/api/v1/contacts")).json()
    before = next(c for c in contacts if c["id"] == "ct_camping")["reliability"]

    # El workflow reporta el error real de Telegram (p.ej. chat_id desconocido).
    receipt = await client.post(
        "/api/v1/webhooks/happyrobot",
        json={
            "command_id": action["id"],
            "observation_id": "tg-entrega-1",
            "outcome": "failed",
            "summary": "chat not found",
        },
    )
    assert receipt.status_code == 202

    actions = (await client.get("/api/v1/actions")).json()
    assert next(a for a in actions if a["id"] == action["id"])["status"] == "failed"
    events = (await client.get("/api/v1/events")).json()
    assert any(e["kind"] == "message_outcome" for e in events)

    contacts = (await client.get("/api/v1/contacts")).json()
    after = next(c for c in contacts if c["id"] == "ct_camping")["reliability"]
    assert after == before, "un aviso no entregado no dice nada de si la persona responde"


async def test_pending_legacy_sms_is_not_rerouted_to_telegram() -> None:
    rt = await seeded_runtime(Settings(agent_autostart=False))
    try:
        async with rt.orchestrator.edit() as candidate:
            action = await rt.executor.bind(candidate).message(
                candidate.contacts["ct_camping"], "orden antigua"
            )
            action.kind = ActionKind.sms
            action.workflow = "sms"
        await rt.orchestrator.dispatch_pending()
        assert rt.state.actions[action.id].status == ActionStatus.failed
        assert rt.hr.calls == []  # type: ignore[attr-defined]
    finally:
        await rt.hr.aclose()


@pytest.mark.parametrize(
    "status,expected,attempts",
    [(500, ActionStatus.unknown, 1), (429, ActionStatus.failed, 3), (400, ActionStatus.failed, 1)],
)
async def test_outbox_policy_applies_to_avisos(
    status: int, expected: ActionStatus, attempts: int
) -> None:
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(status, json={"error": "nope"})

    rt = await seeded_runtime(live_settings(happyrobot_wf_telegram="wf_tg"))
    await use_mock_transport(rt, handle)
    try:
        async with rt.orchestrator.edit() as candidate:
            action = await rt.executor.bind(candidate).message(
                candidate.contacts["ct_camping"], "aviso"
            )
        for _ in range(4):
            async with rt.orchestrator.edit() as candidate:
                candidate.actions[action.id].next_attempt_at = now()
            await rt.orchestrator.dispatch_pending()
        assert rt.state.actions[action.id].status == expected
        assert len(requests) == attempts
    finally:
        await rt.hr.aclose()


async def test_pause_blocks_avisos_and_resume_dispatches_them() -> None:
    rt = await seeded_runtime(Settings(agent_autostart=False))
    try:
        async with rt.orchestrator.edit() as candidate:
            candidate.agent.mode = AgentMode.paused
            action = await rt.executor.bind(candidate).message(
                candidate.contacts["ct_camping"], "aviso"
            )
        await rt.orchestrator.dispatch_pending()
        assert rt.state.actions[action.id].status == ActionStatus.pending
        async with rt.orchestrator.edit() as candidate:
            candidate.agent.mode = AgentMode.running
        await rt.orchestrator.dispatch_pending()
        assert rt.state.actions[action.id].status == ActionStatus.dispatched
    finally:
        await rt.hr.aclose()

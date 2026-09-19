import json
import logging
from unittest.mock import AsyncMock

import httpx
import pytest

from app.config import Settings
from app.domain.models import ActionKind, ActionStatus, AgentMode, now
from app.domain.scenario import seed_wildfire
from app.domain.state import WorldState
from app.integrations.telegram import TelegramError, TelegramWebhookClient
from app.main import build_runtime, create_app
from app.store.persistence import MemoryStore
from tests.conftest import HEADERS


async def test_telegram_route_and_sms_alias_use_no_happyrobot(client: httpx.AsyncClient) -> None:
    for path in ("telegram", "sms"):
        denied = await client.post(
            f"/api/v1/control/{path}", json={"contact_id": "ct_camping", "message": "aviso"}
        )
        assert denied.status_code == 401
        response = await client.post(
            f"/api/v1/control/{path}",
            headers=HEADERS,
            json={"contact_id": "ct_camping", "message": "Aviso de prueba"},
        )
        assert response.status_code == 200
        action = response.json()
        assert action["kind"] == "telegram"
        assert action["status"] == "completed"
        assert action["happyrobot_run_id"] is None
        assert action["result"]["simulated"]
        assert action["request"]["channel"] == "telegram"
        assert "phone" not in action["request"]
        callback = await client.post(
            "/api/v1/webhooks/happyrobot",
            json={"command_id": action["id"], "outcome": "accepted"},
        )
        assert callback.status_code == 422


@pytest.mark.parametrize("path", ["telegram", "sms"])
@pytest.mark.parametrize("status", [200, 202, 204])
async def test_control_routes_send_bridge_contract_without_happyrobot(
    path: str, status: int
) -> None:
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(status, text="private bridge response")

    app = create_app(Settings(agent_autostart=False, api_key=HEADERS["X-API-Key"]))
    rt = app.state.rt
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as transport:
        await rt.telegram.aclose()
        rt.telegram = TelegramWebhookClient(
            Settings(
                telegram_mode="live",
                telegram_webhook_url="https://bridge.test/private-token",
                telegram_webhook_secret="test-only-secret",
            ),
            transport,
        )
        rt.executor.telegram = rt.telegram
        rt.hr.trigger = AsyncMock(side_effect=AssertionError("No iniciar workflows SMS"))
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://test"
            ) as client:
                message = 'Aviso de prueba: línea uno\n"Atención" \\ punto de reunión'
                response = await client.post(
                    f"/api/v1/control/{path}",
                    headers=HEADERS,
                    json={"contact_id": "ct_camping", "message": message},
                )
                assert response.status_code == 200
                action = response.json()
                assert action["kind"] == "telegram"
                assert action["workflow"] == "telegram"
                assert action["status"] == "completed"
                assert action["happyrobot_run_id"] is None
                assert action["result"] == {
                    "status": "accepted",
                    "status_code": status,
                    "delivery_confirmed": False,
                }
                assert len(requests) == 1
                request = requests[0]
                assert request.method == "POST"
                assert request.headers["Content-Type"] == "application/json"
                assert request.headers["Idempotency-Key"] == action["id"]
                assert request.headers["X-Webhook-Secret"] == "test-only-secret"
                assert (
                    json.loads(request.content)
                    == action["request"]
                    == {
                        "channel": "telegram",
                        "command_id": action["id"],
                        "action_id": action["id"],
                        "incident_id": rt.state.incident.id,
                        "contact_id": "ct_camping",
                        "contact_name": rt.state.contacts["ct_camping"].name,
                        "message": message,
                    }
                )
                assert "private-token" not in response.text
                assert "test-only-secret" not in response.text
                assert "private bridge response" not in response.text
                rt.hr.trigger.assert_not_called()
                assert rt.hr.calls == []


async def test_pending_legacy_sms_is_not_rerouted_to_telegram() -> None:
    state, store = WorldState(), MemoryStore()
    seed_wildfire(state)
    await store.create(state.snapshot(full=True))
    rt = build_runtime(Settings(agent_autostart=False), state=state, store=store)
    try:
        async with rt.orchestrator.edit() as candidate:
            action = await rt.executor.bind(candidate).message(
                candidate.contacts["ct_camping"], "orden antigua"
            )
            action.kind = ActionKind.sms
            action.workflow = "sms"
        await rt.orchestrator.dispatch_pending()
        assert rt.state.actions[action.id].status == ActionStatus.failed
        assert rt.telegram.calls == []
        assert rt.hr.calls == []
    finally:
        await rt.telegram.aclose()
        await rt.hr.aclose()


async def test_webhook_payload_idempotency_auth_and_redacted_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    requests = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(202, json={"received": True})

    settings = Settings(
        telegram_mode="live",
        telegram_webhook_url="https://bridge.test/private-token",
        telegram_webhook_secret="test-only-secret",
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as transport:
        client = TelegramWebhookClient(settings, transport)
        payload = {"command_id": "act_1", "message": 'Línea uno\n"Urgente"', "channel": "telegram"}
        with caplog.at_level(logging.INFO, logger="httpx"):
            result = await client.send(payload)
        assert result == {"status": "accepted", "status_code": 202, "delivery_confirmed": False}
        assert json.loads(requests[0].content) == payload
        assert requests[0].headers["Idempotency-Key"] == "act_1"
        assert requests[0].headers["X-Webhook-Secret"] == "test-only-secret"
        assert "private-token" not in caplog.text
        assert "test-only-secret" not in caplog.text
        assert "private-token" not in repr(settings)


@pytest.mark.parametrize(
    "status,ambiguous,retryable",
    [
        (400, False, False),
        (401, False, False),
        (429, False, True),
        (500, True, False),
        (302, False, False),
    ],
)
async def test_http_errors_do_not_leak_response(
    status: int, ambiguous: bool, retryable: bool
) -> None:
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(
                status, text="secret response", headers={"Location": "https://other.test"}
            )
        )
    ) as transport:
        client = TelegramWebhookClient(
            Settings(
                telegram_mode="live", telegram_webhook_url="https://bridge.test/private-token"
            ),
            transport,
        )
        with pytest.raises(TelegramError) as error:
            await client.send({"command_id": "act_1", "message": "aviso"})
        assert error.value.ambiguous is ambiguous
        assert error.value.retryable is retryable
        assert "secret" not in str(error.value)
        assert "private-token" not in str(error.value)


@pytest.mark.parametrize(
    "failure,expected,attempts",
    [(httpx.ReadTimeout, ActionStatus.unknown, 1), (httpx.ConnectError, ActionStatus.failed, 3)],
)
async def test_telegram_outbox_retry_policy(
    failure: type[httpx.HTTPError], expected: ActionStatus, attempts: int
) -> None:
    state, store = WorldState(), MemoryStore()
    seed_wildfire(state)
    await store.create(state.snapshot(full=True))
    rt = build_runtime(Settings(agent_autostart=False), state=state, store=store)
    rt.hr.trigger = AsyncMock(side_effect=AssertionError("Telegram no debe usar HappyRobot"))
    requests = []

    def fail(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        raise failure("private-token")

    async with httpx.AsyncClient(transport=httpx.MockTransport(fail)) as transport:
        await rt.telegram.aclose()
        rt.telegram = TelegramWebhookClient(
            Settings(
                telegram_mode="live", telegram_webhook_url="https://bridge.test/private-token"
            ),
            transport,
        )
        rt.executor.telegram = rt.telegram
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
        assert rt.state.actions[action.id].attempts == attempts
        assert "private-token" not in rt.state.actions[action.id].error
        rt.hr.trigger.assert_not_called()
    await rt.hr.aclose()


async def test_pause_blocks_telegram_and_resume_dispatches_without_happyrobot() -> None:
    state, store = WorldState(), MemoryStore()
    seed_wildfire(state)
    await store.create(state.snapshot(full=True))
    rt = build_runtime(Settings(agent_autostart=False), state=state, store=store)
    rt.state.integrations["happyrobot"] = False
    async with rt.orchestrator.edit() as candidate:
        candidate.integrations["happyrobot"] = False
        candidate.agent.mode = AgentMode.paused
        action = await rt.executor.bind(candidate).message(
            candidate.contacts["ct_camping"], "aviso"
        )
    await rt.orchestrator.dispatch_pending()
    assert rt.state.actions[action.id].status == ActionStatus.pending
    async with rt.orchestrator.edit() as candidate:
        candidate.agent.mode = AgentMode.running
    await rt.orchestrator.dispatch_pending()
    assert rt.state.actions[action.id].kind == ActionKind.telegram
    assert rt.state.actions[action.id].status == ActionStatus.completed
    assert not rt.telegram.calls[0].get("phone")
    await rt.telegram.aclose()
    await rt.hr.aclose()


@pytest.mark.parametrize("url", ["", "http://bridge.test", "https://user:password@bridge.test"])
def test_live_webhook_requires_secure_url(url: str) -> None:
    with pytest.raises(ValueError, match="TELEGRAM_WEBHOOK_URL"):
        TelegramWebhookClient(Settings(telegram_mode="live", telegram_webhook_url=url))

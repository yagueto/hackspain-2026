from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.domain.models import WorldSnapshot, now
from app.domain.scenario import seed_wildfire
from app.domain.state import WorldState
from app.integrations.happyrobot import FakeHappyRobotClient
from app.main import create_app
from app.store.persistence import MemoryStore
from tests.conftest import HEADERS


async def test_restore_snapshot_and_operator_settings_without_reseed() -> None:
    store = MemoryStore()
    settings = Settings(agent_autostart=False, incident_id="restart", api_key=HEADERS["X-API-Key"])
    app = create_app(settings, store)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
            response = await client.post("/api/v1/control/tick", headers=HEADERS)
            assert response.status_code == 200
            await client.patch("/api/v1/control/agent", headers=HEADERS, json={"tick_seconds": 25})
            await client.post("/api/v1/control/pause", headers=HEADERS)
            saved = await store.load("restart")
    app2 = create_app(settings.model_copy(update={"seed_demo": False}), store)
    async with app2.router.lifespan_context(app2):
        async with AsyncClient(transport=ASGITransport(app2), base_url="http://test") as client:
            restored = WorldSnapshot.model_validate((await client.get("/api/v1/state")).json())
            assert restored.version == saved.version
            assert restored.tasks == saved.tasks
            assert restored.agent.mode == "paused"
            assert app2.state.rt.orchestrator.tick_seconds == 25
            assert isinstance(app2.state.rt.hr, FakeHappyRobotClient)
            assert app2.state.rt.hr.calls == []


async def test_initialize_catalog_and_disable_production_reset() -> None:
    store = MemoryStore()
    settings = Settings(seed_demo=False, agent_autostart=False, api_key=HEADERS["X-API-Key"])
    app = create_app(settings, store)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
            assert (await client.get("/api/v1/state")).status_code == 409
            assert (await client.get("/api/v1/stream")).status_code == 409
            state = WorldState()
            seed_wildfire(state)
            state.incident.id = settings.incident_id
            initial = state.snapshot(full=True).model_dump(mode="json")
            response = await client.post("/api/v1/control/incident", headers=HEADERS, json=initial)
            assert response.status_code == 201
            assert (await client.get("/api/v1/state")).status_code == 200
            assert (
                await client.post("/api/v1/control/incident", headers=HEADERS, json=initial)
            ).status_code == 409
            assert (await client.post("/api/v1/scenario/reset", headers=HEADERS)).status_code == 409


async def test_manual_evacuation_cannot_bypass_approval(client: AsyncClient) -> None:
    response = await client.post(
        "/api/v1/control/tasks",
        headers=HEADERS,
        json={
            "kind": "evacuate_zone",
            "title": "evacuar",
            "zone_id": "zone_poyales",
        },
    )
    assert response.status_code == 201
    task = response.json()
    assert task["status"] == "awaiting_approval"
    assert task["resource_ids"] == []
    call = await client.post(
        "/api/v1/control/call",
        headers=HEADERS,
        json={
            "contact_id": "ct_camping",
            "task_id": task["id"],
            "instructions": "salid",
        },
    )
    assert call.status_code == 409


async def test_webhook_replay_and_conflicting_correlation(client: AsyncClient) -> None:
    await client.post("/api/v1/control/tick", headers=HEADERS)
    actions = (await client.get("/api/v1/actions")).json()
    action = next(a for a in actions if a["kind"] == "call")
    body = {
        "command_id": action["id"],
        "observation_id": "repeat",
        "outcome": "accepted",
        "summary": "recibido",
    }
    assert (await client.post("/api/v1/webhooks/happyrobot", json=body)).status_code == 202
    state = (await client.get("/api/v1/state")).json()
    assert (await client.post("/api/v1/webhooks/happyrobot", json=body)).status_code == 202
    assert (await client.get("/api/v1/state")).json()["version"] == state["version"]
    invalid = {**body, "action_id": "another", "observation_id": "invalid"}
    assert (await client.post("/api/v1/webhooks/happyrobot", json=invalid)).status_code == 422


async def test_reconcile_known_run_does_not_imply_unit_available() -> None:
    app = create_app(Settings(agent_autostart=False, api_key=HEADERS["X-API-Key"]))
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
            await client.post("/api/v1/control/tick", headers=HEADERS)
            task = next(t for t in app.state.rt.state.tasks.values() if t.resource_ids)
            action = app.state.rt.state.actions[task.action_ids[0]]
            app.state.rt.hr.get_run = AsyncMock(
                return_value={
                    "id": action.happyrobot_run_id,
                    "status": "completed",
                }
            )
            result = await client.post(
                f"/api/v1/control/actions/{action.id}/reconcile", headers=HEADERS
            )
            assert result.status_code == 200
            assert result.json()["status"] == "unknown"
            assert app.state.rt.state.resources[task.resource_ids[0]].assigned_task_id == task.id


def test_live_requires_durable_storage_and_webhook_secret() -> None:
    with pytest.raises(ValueError, match="modo live"):
        create_app(Settings(happyrobot_mode="live", happyrobot_api_key="test"))


async def test_documented_observation_and_receipt_contract(client: AsyncClient) -> None:
    state = (await client.get("/api/v1/state")).json()
    body = {
        "observation_id": "documented-observation",
        "incident_id": state["incident"]["id"],
        "observed_at": now().isoformat(),
        "kind": "injured_reported",
        "zone_id": "zone_camping",
        "title": "Tres heridos en el camping",
        "payload": {"count": 3},
    }
    assert (await client.post("/api/v1/observations", json=body)).status_code == 401
    assert (await client.get("/api/v1/receipts")).status_code == 401
    result = await client.post("/api/v1/observations", json=body, headers=HEADERS)
    assert result.status_code == 202
    receipts = (await client.get("/api/v1/receipts", headers=HEADERS)).json()
    assert any(
        r["observation_id"] == body["observation_id"] and r["status"] == "applied" for r in receipts
    )
    updated = (await client.get("/api/v1/state")).json()
    assert next(z for z in updated["zones"] if z["id"] == "zone_camping")["injured"] == 3
    replay = await client.post("/api/v1/observations", json=body, headers=HEADERS)
    assert replay.status_code == 202
    assert (await client.get("/api/v1/state")).json()["version"] == updated["version"]
    invalid = {**body, "observation_id": "invalid-count", "payload": {"count": -1}}
    assert (
        await client.post("/api/v1/observations", json=invalid, headers=HEADERS)
    ).status_code == 202
    receipts = (await client.get("/api/v1/receipts", headers=HEADERS)).json()
    assert any(
        r["observation_id"] == "invalid-count" and r["status"] == "invalid" for r in receipts
    )
    current = (await client.get("/api/v1/state")).json()
    assert current["zones"] == updated["zones"]


async def test_callback_id_conflict_is_permanent_and_preserves_state(client: AsyncClient) -> None:
    await client.post("/api/v1/control/tick", headers=HEADERS)
    action = next(a for a in (await client.get("/api/v1/actions")).json() if a["kind"] == "call")
    body = {
        "command_id": action["id"],
        "observation_id": "immutable-callback",
        "outcome": "accepted",
        "summary": "recibido",
    }
    assert (await client.post("/api/v1/webhooks/happyrobot", json=body)).status_code == 202
    before = (await client.get("/api/v1/state")).json()
    changed = {**body, "summary": "distinto contenido"}
    result = await client.post("/api/v1/webhooks/happyrobot", json=changed)
    assert result.status_code == 409
    assert "observation_id" in result.json()["detail"]
    after = (await client.get("/api/v1/state")).json()
    assert after["version"] == before["version"]
    assert after["tasks"] == before["tasks"]
    assert after["resources"] == before["resources"]
    assert (await client.post("/api/v1/webhooks/happyrobot", json=body)).status_code == 202
    receipts = (await client.get("/api/v1/receipts", headers=HEADERS)).json()
    assert sum(r["observation_id"] == body["observation_id"] for r in receipts) == 1

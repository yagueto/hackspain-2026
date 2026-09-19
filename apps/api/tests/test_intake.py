import asyncio
from datetime import timedelta

import httpx
import pytest

from app.config import Settings
from app.domain.models import now
from app.integrations.geocoding import NominatimGeocoder
from app.main import create_app
from app.store.persistence import MemoryStore


def report(**updates: object) -> dict[str, object]:
    return {
        "run_id": "incoming-test-1",
        "timestamp": now().isoformat(),
        "emergency_type": "incendio",
        "severity": "grave",
        "escalation_required": "true",
        "location": {
            "raw_text": "Calle Mayor 14, Ávila",
            "street": "Calle Mayor",
            "number": "14",
            "city": "Ávila",
            "lat": "40.6564",
            "lng": "-4.7003",
            "confirmed": "true",
        },
        "victims": {"count": "2", "conscious": "true", "breathing": "null"},
        "caller": {"name": "Persona de prueba", "phone": "", "is_victim": "false"},
        "notes": "Humo en el edificio",
        **updates,
    }


async def test_inbound_call_reaches_snapshot_without_outbound_order(
    client: httpx.AsyncClient,
) -> None:
    payload = report()
    response = await client.post("/api/v1/webhooks/happyrobot/inbound", json=payload)
    assert response.status_code == 202
    assert response.json()["status"] == "applied"
    snapshot = (await client.get("/api/v1/state")).json()
    incoming = snapshot["incoming_calls"]
    assert len(incoming) == 1
    assert incoming[0]["location"]["lat"] == 40.6564
    assert incoming[0]["location"]["lng"] == -4.7003
    assert incoming[0]["location"]["confirmed"] is True
    assert incoming[0]["victims"]["breathing"] is None
    assert incoming[0]["caller"]["phone"] is None
    assert snapshot["recent_actions"] == []
    assert any(e["kind"] == "incoming_call" for e in snapshot["recent_events"])
    version = snapshot["version"]
    repeated = await client.post("/api/v1/webhooks/happyrobot/inbound", json=payload)
    assert repeated.status_code == 202
    repeated_snapshot = (await client.get("/api/v1/state")).json()
    assert repeated_snapshot["version"] == version
    assert len(repeated_snapshot["incoming_calls"]) == 1


@pytest.mark.parametrize(
    "location",
    [
        {"raw_text": "Junto al río"},
        {"raw_text": "Calle Mayor 14, Ávila", "confirmed": True},
        {"raw_text": "null", "lat": "", "lng": "null", "confirmed": "false"},
    ],
)
async def test_unknown_coordinates_never_become_a_fabricated_pin(
    client: httpx.AsyncClient, location: dict[str, object]
) -> None:
    response = await client.post(
        "/api/v1/webhooks/happyrobot/inbound", json=report(location=location)
    )
    assert response.status_code == 202
    incoming = (await client.get("/api/v1/state")).json()["incoming_calls"][0]
    assert incoming["location"]["lat"] is None
    assert incoming["location"]["lng"] is None


@pytest.mark.parametrize(
    "location",
    [
        {"lat": 91, "lng": -4},
        {"lat": 40, "lng": -181},
        {"lat": 40},
        {"lng": -4},
        {"lat": "NaN", "lng": 0},
        {"lat": 40, "lng": 0, "accuracy_m": -1},
        {"lat": True, "lng": False},
    ],
)
async def test_invalid_coordinates_are_rejected(
    client: httpx.AsyncClient, location: dict[str, object]
) -> None:
    response = await client.post(
        "/api/v1/webhooks/happyrobot/inbound", json=report(location=location)
    )
    assert response.status_code == 422
    assert (await client.get("/api/v1/state")).json()["incoming_calls"] == []


async def test_intake_checks_authentication_and_survives_restart() -> None:
    store = MemoryStore()
    settings = Settings(agent_autostart=False, happyrobot_webhook_secret="test-secret")
    app = create_app(settings, store=store)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            payload = report()
            response = await client.post("/api/v1/webhooks/happyrobot/inbound", json=payload)
            assert response.status_code == 401
            response = await client.post(
                "/api/v1/webhooks/happyrobot/inbound",
                json=payload,
                headers={"X-Webhook-Secret": "test-secret"},
            )
            assert response.status_code == 202
    restored = create_app(settings, store=store)
    async with restored.router.lifespan_context(restored):
        assert restored.state.rt.state.snapshot().incoming_calls[0].run_id == "incoming-test-1"


async def test_late_call_update_does_not_replace_new_location(client: httpx.AsyncClient) -> None:
    payload = report()
    assert (
        await client.post("/api/v1/webhooks/happyrobot/inbound", json=payload)
    ).status_code == 202
    older = report(timestamp=(now() - timedelta(hours=1)).isoformat(), location={})
    response = await client.post("/api/v1/webhooks/happyrobot/inbound", json=older)
    assert response.status_code == 202
    assert response.json()["status"] == "ignored"
    incoming = (await client.get("/api/v1/state")).json()["incoming_calls"]
    assert len(incoming) == 1
    assert incoming[0]["location"]["lat"] == 40.6564


async def test_intake_proposes_help_while_paused_and_requires_review(
    client: httpx.AsyncClient,
) -> None:
    headers = {"X-API-Key": "test"}
    await client.post("/api/v1/control/pause", headers=headers)
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report())
    state = (await client.get("/api/v1/state")).json()
    task = state["tasks"][0]
    assert task["incoming_call_id"] == "incoming-test-1"
    assert task["status"] == "awaiting_approval"
    assert task["resource_types"] == ["fire_engine"]
    assert task["target_location"]["lat"] == 40.6564
    assert task["resource_ids"] == []
    assert state["recent_actions"] == []
    url = f"/api/v1/control/tasks/{task['id']}/approve"
    assert (await client.post(url, json={"approved": True})).status_code == 401
    assert (await client.post(url, headers=headers, json={"approved": True})).status_code == 409
    response = await client.post(
        url,
        headers=headers,
        json={
            "approved": True,
            "confirm_location": True,
            "expected_updated_at": task["updated_at"],
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "dispatching"
    state = (await client.get("/api/v1/state")).json()
    action = next(a for a in state["recent_actions"] if a["task_id"] == task["id"])
    assert action["status"] == "pending"
    assert action["request"]["target_location"]["lat"] == 40.6564
    await client.post("/api/v1/control/resume", headers=headers)
    assert (await client.post("/api/v1/control/dispatch", headers=headers)).status_code == 200
    state = (await client.get("/api/v1/state")).json()
    action = next(a for a in state["recent_actions"] if a["task_id"] == task["id"])
    assert action["status"] == "dispatched"
    assert action["happyrobot_run_id"].startswith("fake_")
    assert (
        next(r for r in state["resources"] if r["assigned_task_id"] == task["id"])["status"]
        == "reserved"
    )


async def test_unknown_location_blocks_approval_and_corrections_invalidate_old_reviews(
    client: httpx.AsyncClient,
) -> None:
    headers = {"X-API-Key": "test"}
    await client.post(
        "/api/v1/webhooks/happyrobot/inbound", json=report(location={"raw_text": "sin localizar"})
    )
    task = (await client.get("/api/v1/tasks")).json()[0]
    response = await client.post(
        f"/api/v1/control/tasks/{task['id']}/approve",
        headers=headers,
        json={
            "approved": True,
            "confirm_location": True,
            "expected_updated_at": task["updated_at"],
        },
    )
    assert response.status_code == 409
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report())
    updated = (await client.get("/api/v1/tasks")).json()[0]
    assert updated["id"] == task["id"]
    assert updated["updated_at"] != task["updated_at"]
    assert updated["target_location"] is not None
    response = await client.post(
        f"/api/v1/control/tasks/{task['id']}/approve",
        headers=headers,
        json={
            "approved": True,
            "confirm_location": True,
            "expected_updated_at": task["updated_at"],
        },
    )
    assert response.status_code == 409


async def test_non_emergency_does_not_create_dispatch_proposal(client: httpx.AsyncClient) -> None:
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report(severity="no_emergencia"))
    assert (await client.get("/api/v1/tasks")).json() == []


async def test_public_address_is_geocoded_persisted_and_not_claimed_as_gps() -> None:
    requests = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json=[
                {
                    "lat": "40.1",
                    "lon": "-4.2",
                    "display_name": "Plaza pública de prueba",
                    "addresstype": "square",
                }
            ],
        )

    settings = Settings(api_key="test", nominatim_demo_enabled=True, agent_autostart=False)
    app = create_app(settings)
    await app.state.rt.geocoder.close()
    app.state.rt.geocoder = NominatimGeocoder(
        settings, httpx.AsyncClient(transport=httpx.MockTransport(handle))
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as client:
            payload = report(
                location={
                    "raw_text": "Plaza pública de prueba",
                    "confirmed": True,
                    "public_search_allowed": True,
                }
            )
            response = await client.post("/api/v1/webhooks/happyrobot/inbound", json=payload)
            assert response.status_code == 202
            state = (await client.get("/api/v1/state")).json()
            incoming = state["incoming_calls"][0]
            assert incoming["location"]["lat"] is None
            assert incoming["resolution"]["provider"] == "nominatim"
            assert incoming["resolution"]["selected"]["lat"] == 40.1
            assert state["tasks"][0]["target_location"]["lat"] == 40.1
            assert state["tasks"][0]["status"] == "awaiting_approval"
            assert state["recent_actions"] == []
            await client.post("/api/v1/webhooks/happyrobot/inbound", json=payload)
            assert (await client.get("/api/v1/state")).json()["version"] == state["version"]
            assert len(requests) == 1
            corrected = await client.post(
                "/api/v1/control/incoming-calls/incoming-test-1/location",
                headers={"X-API-Key": "test"},
                json={
                    "expected_timestamp": payload["timestamp"],
                    "location": {
                        "lat": 40.2,
                        "lng": -4.3,
                        "label": "Destino revisado",
                        "kind": "manual",
                    },
                },
            )
            assert corrected.status_code == 200
            task = (await client.get("/api/v1/tasks")).json()[0]
            assert task["target_location"]["lat"] == 40.2
            assert task["status"] == "awaiting_approval"


async def test_geocoding_failure_does_not_drop_the_incoming_report() -> None:
    settings = Settings(nominatim_demo_enabled=True, agent_autostart=False)
    app = create_app(settings)
    await app.state.rt.geocoder.close()
    app.state.rt.geocoder = NominatimGeocoder(
        settings, httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/api/v1/webhooks/happyrobot/inbound",
                json=report(
                    location={
                        "raw_text": "Plaza pública",
                        "confirmed": True,
                        "public_search_allowed": True,
                    }
                ),
            )
            assert response.status_code == 202
            state = (await client.get("/api/v1/state")).json()
            assert state["incoming_calls"][0]["resolution"]["status"] == "unavailable"
            assert state["tasks"][0]["target_location"] is None
            assert state["recent_actions"] == []


async def test_geocoding_control_requires_public_consent_and_cannot_accept_caller_resolution(
    client: httpx.AsyncClient,
) -> None:
    payload = report()
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=payload)
    response = await client.post(
        "/api/v1/control/incoming-calls/incoming-test-1/geocode",
        headers={"X-API-Key": "test"},
        json={"expected_timestamp": payload["timestamp"]},
    )
    assert response.status_code == 422
    response = await client.post(
        "/api/v1/webhooks/happyrobot/inbound",
        json={**payload, "resolution": {"status": "confirmed"}},
    )
    assert response.status_code == 422


async def test_geocoder_result_cannot_overwrite_a_newer_report() -> None:
    started, release = asyncio.Event(), asyncio.Event()

    async def handle(request: httpx.Request) -> httpx.Response:
        started.set()
        await release.wait()
        return httpx.Response(
            200,
            json=[
                {"lat": "40", "lon": "-4", "display_name": "Plaza antigua", "addresstype": "square"}
            ],
        )

    settings = Settings(api_key="test", nominatim_demo_enabled=True, agent_autostart=False)
    app = create_app(settings)
    await app.state.rt.geocoder.close()
    app.state.rt.geocoder = NominatimGeocoder(
        settings, httpx.AsyncClient(transport=httpx.MockTransport(handle))
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as client:
            original = report(location={"raw_text": "Plaza pública", "confirmed": True})
            await client.post("/api/v1/webhooks/happyrobot/inbound", json=original)
            pending = asyncio.create_task(
                client.post(
                    "/api/v1/control/incoming-calls/incoming-test-1/geocode",
                    headers={"X-API-Key": "test"},
                    json={"expected_timestamp": original["timestamp"], "public_address": True},
                )
            )
            await asyncio.wait_for(started.wait(), timeout=1)
            await client.post(
                "/api/v1/webhooks/happyrobot/inbound",
                json=report(timestamp=(now() + timedelta(seconds=1)).isoformat()),
            )
            release.set()
            assert (await pending).status_code == 409
            state = (await client.get("/api/v1/state")).json()
            assert state["incoming_calls"][0]["resolution"]["selected"] is None
            assert state["tasks"][0]["target_location"]["lat"] == 40.6564


async def test_updated_report_does_not_send_previously_approved_destination(
    client: httpx.AsyncClient,
) -> None:
    headers = {"X-API-Key": "test"}
    await client.post("/api/v1/control/pause", headers=headers)
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report())
    task = (await client.get("/api/v1/tasks")).json()[0]
    await client.post(
        f"/api/v1/control/tasks/{task['id']}/approve",
        headers=headers,
        json={
            "approved": True,
            "confirm_location": True,
            "expected_updated_at": task["updated_at"],
        },
    )
    await client.post(
        "/api/v1/webhooks/happyrobot/inbound",
        json=report(location={"lat": 41, "lng": -5, "confirmed": True}),
    )
    await client.post("/api/v1/control/resume-simulated", headers=headers)
    state = (await client.get("/api/v1/state")).json()
    assert state["tasks"][0]["status"] == "cancelled"
    assert state["recent_actions"][0]["status"] == "skipped"
    assert not any(resource["assigned_task_id"] == task["id"] for resource in state["resources"])


async def test_simulated_resume_cannot_activate_live_communications() -> None:
    settings = Settings(
        api_key="test",
        agent_autostart=False,
        happyrobot_mode="live",
        happyrobot_api_key="test-key",
        happyrobot_webhook_secret="test-secret",
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as client:
            headers = {"X-API-Key": "test"}
            await client.post("/api/v1/control/pause", headers=headers)
            response = await client.post("/api/v1/control/resume-simulated", headers=headers)
            assert response.status_code == 409
            assert (await client.get("/api/v1/state")).json()["agent"]["mode"] == "paused"


async def test_corrected_emergency_reopens_only_an_unsent_unapproved_proposal(
    client: httpx.AsyncClient,
) -> None:
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report())
    original = (await client.get("/api/v1/tasks")).json()[0]
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report(severity="no_emergencia"))
    assert (await client.get("/api/v1/tasks")).json()[0]["status"] == "cancelled"
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report(severity="vital"))
    tasks = (await client.get("/api/v1/tasks")).json()
    assert len(tasks) == 1
    assert tasks[0]["id"] == original["id"]
    assert tasks[0]["status"] == "awaiting_approval"
    assert tasks[0]["priority"] == 100
    assert (await client.get("/api/v1/actions")).json() == []


async def test_future_intake_rejected_before_acknowledgement(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/api/v1/webhooks/happyrobot/inbound",
        json=report(timestamp=(now() + timedelta(hours=1)).isoformat()),
    )
    assert response.status_code == 422

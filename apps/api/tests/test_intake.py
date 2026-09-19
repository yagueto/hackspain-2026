import asyncio
from datetime import timedelta

import httpx
import pytest

from app.config import Settings
from app.domain.models import now
from app.integrations.geocoding import NominatimGeocoder
from app.main import create_app
from app.store.persistence import MemoryStore
from tests.conftest import runtime_of


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


async def test_inbound_call_reaches_snapshot_and_is_idempotent(
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
    # La orden se prepara sola, pero recibir el aviso no la envía.
    assert [a["status"] for a in snapshot["recent_actions"]] == ["pending"]
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


async def test_grave_intake_dispatches_without_operator_approval(
    client: httpx.AsyncClient,
) -> None:
    """Un aviso no crítico se decide, reserva y envía solo. Nadie pulsa nada."""
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report())
    state = (await client.get("/api/v1/state")).json()
    task = state["tasks"][0]
    assert task["incoming_call_id"] == "incoming-test-1"
    assert task["status"] == "dispatching"
    assert task["autonomous"] is True
    assert task["requires_approval"] is False
    assert task["resource_types"] == ["fire_engine"]
    assert task["target_location"]["lat"] == 40.6564
    assert "automáticamente" in task["priority_reason"]
    action = next(a for a in state["recent_actions"] if a["task_id"] == task["id"])
    assert action["status"] == "pending"
    assert action["hold_until"] is not None
    assert action["request"]["target_location"]["lat"] == 40.6564
    assert any("Decisión automática" in e["title"] for e in state["recent_events"])
    # La ventana solo retrasa el envío; al vencer sale sin intervención.
    rt = runtime_of(client)
    async with rt.orchestrator.edit() as s:
        s.actions[action["id"]].hold_until = now() - timedelta(seconds=1)
    await rt.orchestrator.dispatch_pending()
    state = (await client.get("/api/v1/state")).json()
    action = next(a for a in state["recent_actions"] if a["task_id"] == task["id"])
    assert action["status"] == "dispatched"
    assert action["happyrobot_run_id"].startswith("fake_")
    assert (
        next(r for r in state["resources"] if r["assigned_task_id"] == task["id"])["status"]
        == "reserved"
    )


async def test_vital_report_waits_for_human_confirmation(client: httpx.AsyncClient) -> None:
    headers = {"X-API-Key": "test"}
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report(severity="vital"))
    state = (await client.get("/api/v1/state")).json()
    task = state["tasks"][0]
    assert task["status"] == "awaiting_approval"
    assert task["requires_approval"] is True
    assert task["autonomous"] is False
    assert task["hold_until"] is None
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
    state = (await client.get("/api/v1/state")).json()
    action = next(a for a in state["recent_actions"] if a["task_id"] == task["id"])
    assert action["hold_until"] is None  # ya hay decisión humana: nada que retener
    assert action["status"] == "dispatched"  # confirmada, sale sin más espera


async def test_grace_window_delays_dispatch_and_operator_can_cancel(
    client: httpx.AsyncClient,
) -> None:
    headers = {"X-API-Key": "test"}
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report())
    task = (await client.get("/api/v1/tasks")).json()[0]
    rt = runtime_of(client)
    await rt.orchestrator.dispatch_pending()
    state = (await client.get("/api/v1/state")).json()
    assert state["recent_actions"][0]["status"] == "pending"  # retenida, no enviada
    response = await client.post(
        f"/api/v1/control/tasks/{task['id']}/status",
        headers=headers,
        json={"status": "cancelled", "outcome": "Anulada por el operador"},
    )
    assert response.status_code == 200
    state = (await client.get("/api/v1/state")).json()
    assert state["tasks"][0]["status"] == "cancelled"
    assert state["recent_actions"][0]["status"] == "skipped"
    assert not any(r["assigned_task_id"] == task["id"] for r in state["resources"])
    await rt.orchestrator.dispatch_pending()
    assert (await client.get("/api/v1/state")).json()["recent_actions"][0]["status"] == "skipped"


async def test_panic_button_stops_held_orders(client: httpx.AsyncClient) -> None:
    headers = {"X-API-Key": "test"}
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report())
    action_id = (await client.get("/api/v1/actions")).json()[0]["id"]
    assert (await client.post("/api/v1/control/pause", headers=headers)).status_code == 200
    rt = runtime_of(client)
    async with rt.orchestrator.edit() as s:
        s.actions[action_id].hold_until = now() - timedelta(seconds=1)
    await rt.orchestrator.dispatch_pending()
    state = (await client.get("/api/v1/state")).json()
    assert state["recent_actions"][0]["status"] == "pending"
    assert state["agent"]["mode"] == "paused"
    assert any("Parada de emergencia" in e["title"] for e in state["recent_events"])


async def test_unconfirmed_critical_escalates_by_telegram_exactly_once(
    client: httpx.AsyncClient,
) -> None:
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report(severity="vital"))
    rt = runtime_of(client)
    await rt.orchestrator.escalate_stale_approvals()
    assert (await client.get("/api/v1/actions")).json() == []  # aún dentro del plazo
    async with rt.orchestrator.edit() as s:
        task = next(iter(s.tasks.values()))
        task.updated_at = now() - timedelta(seconds=31)
    await rt.orchestrator.escalate_stale_approvals()
    await rt.orchestrator.escalate_stale_approvals()
    state = (await client.get("/api/v1/state")).json()
    avisos = [a for a in state["recent_actions"] if a["kind"] == "telegram"]
    assert len(avisos) == 1
    assert avisos[0]["workflow"] == "send_telegram"
    assert avisos[0]["task_id"] is None  # no es una misión: el outbox no debe cancelarla
    assert state["tasks"][0]["status"] == "awaiting_approval"
    assert state["tasks"][0]["escalated_at"] is not None
    assert sum("Escalado" in e["title"] for e in state["recent_events"]) == 1


async def test_evacuation_approval_does_not_require_location_confirmation(
    client: httpx.AsyncClient,
) -> None:
    """Una evacuación es crítica, pero no tiene aviso ciudadano cuya ubicación revisar."""
    headers = {"X-API-Key": "test"}
    response = await client.post(
        "/api/v1/control/tasks",
        headers=headers,
        json={
            "kind": "evacuate_zone",
            "title": "Evacuar zona de prueba",
            "zone_id": "zone_poyales",
        },
    )
    assert response.status_code == 201
    task = response.json()
    assert task["status"] == "awaiting_approval"
    approved = await client.post(
        f"/api/v1/control/tasks/{task['id']}/approve", headers=headers, json={"approved": True}
    )
    assert approved.status_code == 200
    assert approved.json()["approved_at"] is not None


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


async def test_address_without_gps_is_geocoded_and_dispatched_as_approximate() -> None:
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

    settings = Settings(api_key="test", agent_autostart=False)
    app = create_app(settings)
    await app.state.rt.geocoder.close()
    app.state.rt.geocoder = NominatimGeocoder(
        settings, httpx.AsyncClient(transport=httpx.MockTransport(handle))
    )
    rt = app.state.rt
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as client:
            payload = report(location={"raw_text": "Plaza pública de prueba", "confirmed": True})
            response = await client.post("/api/v1/webhooks/happyrobot/inbound", json=payload)
            assert response.status_code == 202
            # Recibir el aviso no bloquea a quien atiende al ciudadano: localiza después.
            assert requests == []
            await rt.orchestrator.locate_pending_reports()
            await rt.orchestrator.reconcile_intake()
            state = (await client.get("/api/v1/state")).json()
            incoming = state["incoming_calls"][0]
            assert incoming["location"]["lat"] is None  # nunca se atribuye como GPS
            assert incoming["resolution"]["provider"] == "nominatim"
            assert incoming["resolution"]["selected"]["lat"] == 40.1
            assert state["tasks"][0]["target_location"]["lat"] == 40.1
            assert state["tasks"][0]["status"] == "dispatching"
            await client.post("/api/v1/webhooks/happyrobot/inbound", json=payload)
            await rt.orchestrator.locate_pending_reports()
            assert (await client.get("/api/v1/state")).json()["version"] == state["version"]
            assert len(requests) == 1
            # Con una misión en curso, el destino no se cambia por detrás.
            corrected = await client.post(
                "/api/v1/control/incoming-calls/incoming-test-1/location",
                headers={"X-API-Key": "test"},
                json={
                    "expected_timestamp": payload["timestamp"],
                    "location": {"lat": 40.2, "lng": -4.3, "label": "Revisado", "kind": "manual"},
                },
            )
            assert corrected.status_code == 409


async def test_unresolvable_location_blocks_dispatch_without_cancelling() -> None:
    """Un fallo del proveedor no descarta el aviso ni moviliza a nadie a ciegas."""
    settings = Settings(agent_autostart=False)
    app = create_app(settings)
    await app.state.rt.geocoder.close()
    app.state.rt.geocoder = NominatimGeocoder(
        settings, httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    )
    rt = app.state.rt
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/api/v1/webhooks/happyrobot/inbound",
                json=report(location={"raw_text": "Plaza sin localizar", "confirmed": True}),
            )
            assert response.status_code == 202
            assert response.json()["requires_operator"] is True
            await rt.orchestrator.locate_pending_reports()
            await rt.orchestrator.reconcile_intake()
            await rt.orchestrator.dispatch_pending()
            state = (await client.get("/api/v1/state")).json()
            assert state["incoming_calls"][0]["resolution"]["status"] == "unavailable"
            task = state["tasks"][0]
            assert task["target_location"] is None
            assert task["status"] == "proposed"  # bloqueada, no cancelada
            assert task["blocked_reason"]
            assert state["recent_actions"] == []
            assert not any(r["assigned_task_id"] for r in state["resources"])


async def test_operator_geocoding_is_a_retry_and_rejects_a_caller_supplied_resolution(
    client: httpx.AsyncClient,
) -> None:
    payload = report()
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=payload)
    # Con el proveedor desactivado el reintento del operador no inventa un destino.
    response = await client.post(
        "/api/v1/control/incoming-calls/incoming-test-1/geocode",
        headers={"X-API-Key": "test"},
        json={"expected_timestamp": payload["timestamp"]},
    )
    assert response.status_code == 409
    # El parte entrante no puede declararse a sí mismo como ubicación confirmada.
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

    settings = Settings(api_key="test", agent_autostart=False)
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
                    json={"expected_timestamp": original["timestamp"]},
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


async def test_autonomous_mission_is_cancelled_when_the_report_location_changes(
    client: httpx.AsyncClient,
) -> None:
    """Una orden retenida cuyo aviso se corrige no sale hacia el destino viejo."""
    headers = {"X-API-Key": "test"}
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report())
    task = (await client.get("/api/v1/tasks")).json()[0]
    assert task["status"] == "dispatching"
    await client.post(
        "/api/v1/webhooks/happyrobot/inbound",
        json=report(location={"lat": 41, "lng": -5, "confirmed": True}),
    )
    await client.post("/api/v1/control/resume-simulated", headers=headers)
    state = (await client.get("/api/v1/state")).json()
    old = next(t for t in state["tasks"] if t["id"] == task["id"])
    assert old["status"] == "cancelled"
    assert state["recent_actions"][0]["status"] == "skipped"
    assert not any(r["assigned_task_id"] == task["id"] for r in state["resources"])


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


async def test_corrected_emergency_cancels_the_mission_and_escalates_to_confirmation(
    client: httpx.AsyncClient,
) -> None:
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report())
    original = (await client.get("/api/v1/tasks")).json()[0]
    assert original["status"] == "dispatching"
    # Deja de ser emergencia: la orden retenida se anula y la unidad se libera.
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report(severity="no_emergencia"))
    tasks = (await client.get("/api/v1/tasks")).json()
    assert tasks[0]["status"] == "cancelled"
    assert (await client.get("/api/v1/actions")).json()[0]["status"] == "skipped"
    # Se corrige a vital: ya no se decide solo, pasa a requerir confirmación.
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report(severity="vital"))
    tasks = (await client.get("/api/v1/tasks")).json()
    assert len(tasks) == 1
    assert tasks[0]["id"] == original["id"]
    assert tasks[0]["status"] == "awaiting_approval"
    assert tasks[0]["autonomous"] is False
    assert tasks[0]["priority"] == 100


async def test_future_intake_rejected_before_acknowledgement(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/api/v1/webhooks/happyrobot/inbound",
        json=report(timestamp=(now() + timedelta(hours=1)).isoformat()),
    )
    assert response.status_code == 422

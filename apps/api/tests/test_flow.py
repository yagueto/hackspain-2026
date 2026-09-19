from httpx import AsyncClient

from tests.conftest import HEADERS


async def test_healthz(client: AsyncClient) -> None:
    r = await client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["ok"] is True


async def test_state_seeded(client: AsyncClient) -> None:
    r = await client.get("/api/v1/state")
    assert r.status_code == 200
    body = r.json()
    assert body["incident"]["kind"] == "wildfire"
    assert len(body["zones"]) == 5
    assert len(body["resources"]) == 10


async def test_events_require_api_key(client: AsyncClient) -> None:
    r = await client.post("/api/v1/events", json={"kind": "note", "title": "x"})
    assert r.status_code == 401


async def test_tick_dispatches_fire_engines_and_calls(client: AsyncClient) -> None:
    r = await client.post("/api/v1/control/tick", headers=HEADERS)
    assert r.status_code == 200
    decision = r.json()
    assert decision["model"] == "heuristic"
    assert decision["priorities"]

    tasks = (await client.get("/api/v1/tasks")).json()
    kinds = {t["kind"] for t in tasks}
    assert "dispatch_resource" in kinds
    # Poyales está a 40 min con 600 personas: la evacuación requiere aprobación humana
    evac = [t for t in tasks if t["kind"] == "evacuate_zone"]
    assert evac and evac[0]["status"] == "awaiting_approval"

    actions = (await client.get("/api/v1/actions")).json()
    calls = [a for a in actions if a["kind"] == "call"]
    assert calls and all(a["status"] == "dispatched" for a in calls)
    assert all(a["happyrobot_run_id"].startswith("fake_") for a in calls)


async def test_webhook_updates_task_and_creates_events(client: AsyncClient) -> None:
    await client.post("/api/v1/control/tick", headers=HEADERS)
    task = next(
        t for t in (await client.get("/api/v1/tasks")).json() if t["status"] == "dispatched"
    )
    r = await client.post(
        "/api/v1/webhooks/happyrobot",
        json={
            "task_id": task["id"],
            "outcome": "accepted",
            "eta_minutes": 12,
            "injured_count": 2,
            "summary": "Salimos ahora",
        },
    )
    assert r.status_code == 202
    assert r.json()["derived_events"] == 1

    updated = (await client.get(f"/api/v1/tasks/{task['id']}")).json()
    assert updated["status"] == "accepted"

    events = (await client.get("/api/v1/events")).json()
    assert any(e["kind"] == "call_outcome" for e in events)
    assert any(e["kind"] == "injured_reported" for e in events)

    lessons = (await client.get("/api/v1/history/lessons")).json()
    assert task["assignee_contact_id"] in lessons["contact_reliability"]


async def test_replan_on_wind_change_and_road_block(client: AsyncClient) -> None:
    await client.post("/api/v1/control/tick", headers=HEADERS)
    for step in (1, 2, 3):
        await client.post(f"/api/v1/scenario/step/{step}", headers=HEADERS)
    r = await client.post("/api/v1/control/tick", headers=HEADERS)
    decision = r.json()
    assert decision["replan"] is True
    assert "viento" in decision["replan_reason"].lower() or "cortada" in decision["replan_reason"]

    state = (await client.get("/api/v1/state")).json()
    candeleda = next(z for z in state["zones"] if z["id"] == "zone_candeleda")
    assert candeleda["threat"] in ("high", "critical")
    assert not next(rd for rd in state["roads"] if rd["id"] == "road_av923")["open"]

    signals = [a for a in state["recent_actions"] if a["kind"] == "signal"]
    assert signals, "debe avisar a las llamadas activas del cambio"


async def test_noise_event_is_discarded(client: AsyncClient) -> None:
    await client.post("/api/v1/control/tick", headers=HEADERS)
    await client.post("/api/v1/scenario/step/8", headers=HEADERS)  # "huele a humo" sin cambios
    decision = (await client.post("/api/v1/control/tick", headers=HEADERS)).json()
    assert decision["discarded_events"]


async def test_approve_evacuation(client: AsyncClient) -> None:
    await client.post("/api/v1/control/tick", headers=HEADERS)
    evac = next(
        t for t in (await client.get("/api/v1/tasks")).json() if t["kind"] == "evacuate_zone"
    )
    r = await client.post(
        f"/api/v1/control/tasks/{evac['id']}/approve", headers=HEADERS, json={"approved": True}
    )
    assert r.status_code == 200
    assert r.json()["status"] in ("dispatched", "in_progress")
    state = (await client.get("/api/v1/state")).json()
    assert (
        next(z for z in state["zones"] if z["id"] == evac["zone_id"])["evacuation_status"]
        == "ordered"
    )


async def test_pause_blocks_nothing_but_marks_mode(client: AsyncClient) -> None:
    r = await client.post("/api/v1/control/pause", headers=HEADERS)
    assert r.json()["mode"] == "paused"
    r = await client.post("/api/v1/control/resume", headers=HEADERS)
    assert r.json()["mode"] == "running"


async def test_reset_scenario(client: AsyncClient) -> None:
    await client.post("/api/v1/control/tick", headers=HEADERS)
    r = await client.post(
        "/api/v1/scenario/reset",
        headers=HEADERS,
        json={"autostart_agent": False, "phones": {"firefighter": "+34611111111"}},
    )
    assert r.status_code == 200
    contacts = (await client.get("/api/v1/contacts")).json()
    assert any(c["phone"] == "+34611111111" for c in contacts)
    assert (await client.get("/api/v1/tasks")).json() == []

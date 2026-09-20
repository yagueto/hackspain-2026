from datetime import timedelta

import httpx

from app.domain.models import Location, ResourceStatus, TaskStatus, now
from app.runtime import Runtime
from tests.conftest import runtime_of
from tests.test_intake import report

BASE = Location(lat=40.0, lng=-4.0, label="Base")


async def accepted_mission(client: httpx.AsyncClient) -> tuple[Runtime, str, str]:
    """Aviso despachado cuya unidad ha aceptado la llamada, lista en su base."""
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report())
    rt = runtime_of(client)
    async with rt.orchestrator.edit() as s:
        task = next(t for t in s.tasks.values() if t.incoming_call_id and t.resource_ids)
        resource = s.resources[task.resource_ids[0]]
        resource.status = ResourceStatus.en_route
        resource.location = BASE.model_copy()
        resource.eta_minutes = None
    return rt, resource.id, task.id


async def test_accepted_unit_closes_in_and_arrival_does_not_close_the_mission(
    client: httpx.AsyncClient,
) -> None:
    rt, resource_id, task_id = await accepted_mission(client)
    target = rt.state.tasks[task_id].target_location
    assert target is not None

    await rt.orchestrator.advance_missions()  # primer paso: fija origen y duración
    resource = rt.state.resources[resource_id]
    assert resource.travel_from is not None
    assert resource.travel_minutes and resource.travel_minutes > 0
    assert resource.position_estimated is True
    assert resource.travel_progress == 0

    async with rt.orchestrator.edit() as s:
        minutes = s.resources[resource_id].travel_minutes or 1
        s.resources[resource_id].travel_started_at = now() - timedelta(minutes=minutes / 2)
    await rt.orchestrator.advance_missions()
    resource = rt.state.resources[resource_id]
    assert 0.4 < resource.travel_progress < 0.6
    assert min(BASE.lat, target.lat) < resource.location.lat < max(BASE.lat, target.lat)
    assert resource.status == ResourceStatus.en_route
    assert resource.eta_minutes and resource.eta_minutes > 0

    # Llegar deja la unidad en escena, pero nadie ha reportado el desenlace.
    async with rt.orchestrator.edit() as s:
        minutes = s.resources[resource_id].travel_minutes or 1
        s.resources[resource_id].travel_started_at = now() - timedelta(minutes=minutes + 1)
    await rt.orchestrator.advance_missions()
    resource = rt.state.resources[resource_id]
    assert resource.travel_progress == 1
    assert resource.status == ResourceStatus.on_scene
    assert resource.eta_minutes == 0
    assert (resource.location.lat, resource.location.lng) == (target.lat, target.lng)
    assert rt.state.tasks[task_id].status != TaskStatus.done


async def test_a_unit_that_never_accepted_stays_put(client: httpx.AsyncClient) -> None:
    """Una orden enviada no significa que nadie se haya puesto en marcha."""
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report())
    rt = runtime_of(client)
    task = next(t for t in rt.state.tasks.values() if t.resource_ids)
    resource_id = task.resource_ids[0]
    async with rt.orchestrator.edit() as s:
        s.resources[resource_id].status = ResourceStatus.reserved
        s.resources[resource_id].location = BASE.model_copy()
    settled = rt.state.version
    await rt.orchestrator.advance_missions()
    assert rt.state.version == settled
    assert rt.state.resources[resource_id].location.lat == BASE.lat
    assert rt.state.resources[resource_id].position_estimated is False


async def test_settled_positions_do_not_rewrite_the_world(client: httpx.AsyncClient) -> None:
    rt, _, _ = await accepted_mission(client)
    await rt.orchestrator.advance_missions()
    settled = rt.state.version
    for _ in range(4):
        await rt.orchestrator.advance_missions()
    assert rt.state.version == settled


async def test_a_field_report_overrides_the_estimated_position(
    client: httpx.AsyncClient,
) -> None:
    rt, resource_id, task_id = await accepted_mission(client)
    await rt.orchestrator.advance_missions()
    assert rt.state.resources[resource_id].position_estimated is True
    response = await client.post(
        "/api/v1/events",
        headers={"X-API-Key": "test"},
        json={
            "source": "field_report",
            "kind": "resource_status",
            "title": "La dotación informa de su posición",
            "payload": {
                "resource_id": resource_id,
                "status": "en_route",
                "location": {"lat": 41.5, "lng": -5.5, "label": "Cruce de la N-502"},
            },
        },
    )
    assert response.status_code == 202
    resource = rt.state.resources[resource_id]
    assert (resource.location.lat, resource.location.lng) == (41.5, -5.5)
    assert resource.position_estimated is False
    # La estimación se reanuda desde donde lo dijo el campo, no desde la base.
    await rt.orchestrator.advance_missions()
    assert rt.state.resources[resource_id].travel_from == Location(
        lat=41.5, lng=-5.5, label="Cruce de la N-502"
    )

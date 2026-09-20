from datetime import timedelta

import httpx
import pytest

from app.domain.intake import prepare_intake_tasks, service_requirements
from app.domain.models import (
    IncomingCall,
    ResourceStatus,
    ResourceType,
    Task,
    TaskKind,
    now,
)
from tests.conftest import HEADERS, runtime_of
from tests.test_intake import report


@pytest.mark.parametrize("severity", ["grave", "vital"])
async def test_fire_with_victims_coordinates_all_services_autonomously(
    client: httpx.AsyncClient, severity: str
) -> None:
    await client.post(
        "/api/v1/webhooks/happyrobot/inbound",
        json=report(severity=severity, victims={"count": 2, "trapped": True}),
    )
    state = (await client.get("/api/v1/state")).json()
    tasks = state["tasks"]
    assert {kind for task in tasks for kind in task["resource_types"]} == {
        "fire_engine",
        "ambulance",
        "police_unit",
    }
    assert all(task["status"] == "dispatching" for task in tasks)
    assert all(task["autonomous"] and not task["requires_approval"] for task in tasks)
    assert all(task["priority_reason"] for task in tasks)
    assert len({rid for task in tasks for rid in task["resource_ids"]}) == len(tasks)
    rt = runtime_of(client)
    async with rt.orchestrator.edit() as s:
        for action in s.actions.values():
            action.hold_until = None
    await rt.orchestrator.dispatch_pending()
    assert all(action.status == "dispatched" for action in rt.state.actions.values())
    assert all(resource.status != "en_route" for resource in rt.state.resources.values())


@pytest.mark.parametrize(
    ("emergency_type", "victims", "expected"),
    [
        ("trafico", {"count": 1, "trapped": True}, {"fire_engine", "ambulance", "police_unit"}),
        ("sanitaria", {"count": 1, "breathing": True}, {"ambulance"}),
        ("incendio", {"count": 0}, {"fire_engine"}),
        ("rescate", {"trapped": True}, {"fire_engine", "ambulance"}),
        ("seguridad", {"count": 1}, {"police_unit", "ambulance"}),
    ],
)
async def test_services_follow_the_situation_not_just_the_category(
    client: httpx.AsyncClient, emergency_type: str, victims: dict, expected: set[str]
) -> None:
    await client.post(
        "/api/v1/webhooks/happyrobot/inbound",
        json=report(emergency_type=emergency_type, severity="leve", victims=victims, notes=None),
    )
    assert {
        kind for task in runtime_of(client).state.tasks.values() for kind in task.resource_types
    } == expected


async def scarce_ambulance(client: httpx.AsyncClient, *, sent: bool = False) -> tuple[str, str]:
    rt = runtime_of(client)
    async with rt.orchestrator.edit() as s:
        for resource in s.resources.values():
            if resource.type == ResourceType.ambulance and resource.id != "res_amb1":
                resource.status = ResourceStatus.out_of_service
    for run_id in ("first", "second"):
        await client.post(
            "/api/v1/webhooks/happyrobot/inbound",
            json=report(run_id=run_id, emergency_type="sanitaria", severity="vital", victims={}),
        )
        if run_id == "first" and sent:
            async with rt.orchestrator.edit() as s:
                for action in s.actions.values():
                    action.hold_until = None
            await rt.orchestrator.dispatch_pending()
    tasks = {task.incoming_call_id: task.id for task in rt.state.tasks.values()}
    return tasks["first"], tasks["second"]


async def test_scarcity_asks_operator_and_never_decides_on_timeout(
    client: httpx.AsyncClient,
) -> None:
    first, second = await scarce_ambulance(client)
    rt = runtime_of(client)
    questions = list(rt.state.coordination_questions.values())
    assert len(questions) == 1
    question = questions[0]
    assert question.urgency == "critical"
    assert question.expires_at is None
    assert set(question.allocation_task_ids) == {first, second}
    assert {o.action.task_id for o in question.options if o.action.type == "allocate-resource"} == {
        first,
        second,
    }
    settled = rt.state.version
    for _ in range(3):
        await rt.orchestrator.reconcile_intake()
        await rt.orchestrator.resolve_due_questions()
    assert rt.state.version == settled
    async with rt.orchestrator.edit() as s:
        for action in s.actions.values():
            action.hold_until = now() - timedelta(hours=1)
            action.expires_at = now() - timedelta(minutes=30)
    await rt.orchestrator.dispatch_pending()
    assert all(action.status == "pending" for action in rt.state.actions.values())
    assert rt.state.coordination_questions[question.id].status == "pending"


@pytest.mark.parametrize("sent", [False, True])
async def test_operator_can_choose_other_incident_idempotently(
    client: httpx.AsyncClient, sent: bool
) -> None:
    first, second = await scarce_ambulance(client, sent=sent)
    rt = runtime_of(client)
    question = next(iter(rt.state.coordination_questions.values()))
    option = next(o for o in question.options if o.action.task_id == second)
    url = f"/api/v1/control/questions/{question.id}/answer"
    body = {"optionIds": [option.id]}
    assert (await client.post(url, json=body)).status_code == 401
    response = await client.post(url, json=body, headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["resolution"]["applied"] is True
    assert rt.state.resources["res_amb1"].assigned_task_id == second
    assert rt.state.resources["res_amb1"].status == ResourceStatus.reserved
    assert rt.state.tasks[first].status == "proposed"
    assert not rt.state.tasks[first].resource_ids
    actions = len(rt.state.actions)
    assert (await client.post(url, json=body, headers=HEADERS)).json() == response.json()
    await rt.orchestrator.reconcile_intake()
    assert len(rt.state.actions) == actions
    assert not any(q.status == "pending" for q in rt.state.coordination_questions.values())
    assert rt.state.tasks[second].status in ("dispatching", "dispatched")


async def test_stale_allocation_cannot_redirect_a_resource(client: httpx.AsyncClient) -> None:
    first, second = await scarce_ambulance(client)
    rt = runtime_of(client)
    question = next(iter(rt.state.coordination_questions.values()))
    option = next(o for o in question.options if o.action.task_id == second)
    async with rt.orchestrator.edit() as s:
        s.resources["res_amb1"].status = ResourceStatus.out_of_service
    result = await client.post(
        f"/api/v1/control/questions/{question.id}/answer",
        json={"optionIds": [option.id]},
        headers=HEADERS,
    )
    assert result.json()["resolution"]["applied"] is False
    assert rt.state.resources["res_amb1"].assigned_task_id == first


async def test_available_reinforcement_resolves_conflict_without_operator(
    client: httpx.AsyncClient,
) -> None:
    await scarce_ambulance(client)
    rt = runtime_of(client)
    async with rt.orchestrator.edit() as s:
        s.resources["res_amb2"].status = ResourceStatus.available
    await rt.orchestrator.reconcile_intake()
    assert all(task.status == "dispatching" for task in rt.state.tasks.values())
    assert not any(q.status == "pending" for q in rt.state.coordination_questions.values())
    assert (
        rt.state.resources["res_amb1"].assigned_task_id
        != rt.state.resources["res_amb2"].assigned_task_id
    )


async def test_simultaneous_incidents_do_not_assign_last_unit_by_iteration_order(
    client: httpx.AsyncClient,
) -> None:
    rt = runtime_of(client)
    async with rt.orchestrator.edit() as s:
        s.resources["res_amb2"].status = ResourceStatus.out_of_service
        for run_id in ("first", "second", "third"):
            incoming = IncomingCall.model_validate(
                report(run_id=run_id, emergency_type="sanitaria", victims={}, severity="vital")
            )
            s.incoming_calls[run_id] = incoming
            prepare_intake_tasks(s, incoming)
    await rt.orchestrator.reconcile_intake()
    question = next(q for q in rt.state.coordination_questions.values() if q.status == "pending")
    assert len(question.allocation_task_ids) == 3
    assert not rt.state.actions
    assert rt.state.resources["res_amb1"].assigned_task_id is None
    chosen = next(t for t in rt.state.tasks.values() if t.incoming_call_id == "third")
    response = await client.post(
        f"/api/v1/control/questions/{question.id}/answer",
        headers=HEADERS,
        json={"optionIds": [chosen.id]},
    )
    assert response.json()["resolution"]["applied"]
    await rt.orchestrator.reconcile_intake()
    assert rt.state.resources["res_amb1"].assigned_task_id == chosen.id
    assert not any(q.status == "pending" for q in rt.state.coordination_questions.values())


async def test_third_incident_updates_pending_choice_instead_of_silently_waiting(
    client: httpx.AsyncClient,
) -> None:
    await scarce_ambulance(client)
    rt = runtime_of(client)
    await client.post(
        "/api/v1/webhooks/happyrobot/inbound",
        json=report(run_id="third", emergency_type="sanitaria", victims={}, severity="vital"),
    )
    questions = [q for q in rt.state.coordination_questions.values() if q.status == "pending"]
    assert len(questions) == 1
    assert len(questions[0].allocation_task_ids) == 3
    version = rt.state.version
    await rt.orchestrator.reconcile_intake()
    assert rt.state.version == version


async def test_operator_can_keep_original_assignment(client: httpx.AsyncClient) -> None:
    first, second = await scarce_ambulance(client)
    rt = runtime_of(client)
    question = next(iter(rt.state.coordination_questions.values()))
    response = await client.post(
        f"/api/v1/control/questions/{question.id}/answer",
        headers=HEADERS,
        json={"optionIds": [first]},
    )
    assert response.json()["resolution"]["applied"]
    await rt.orchestrator.reconcile_intake()
    assert rt.state.resources["res_amb1"].assigned_task_id == first
    assert not rt.state.tasks[second].resource_ids
    assert len(rt.state.coordination_questions) == 1


async def test_reassignment_rejection_and_old_callbacks_never_free_or_move_the_unit(
    client: httpx.AsyncClient,
) -> None:
    first, second = await scarce_ambulance(client, sent=True)
    rt = runtime_of(client)
    old_action = next(a for a in rt.state.actions.values() if a.task_id == first)
    question = next(iter(rt.state.coordination_questions.values()))
    await client.post(
        f"/api/v1/control/questions/{question.id}/answer",
        headers=HEADERS,
        json={"optionIds": [second]},
    )
    await rt.orchestrator.dispatch_pending()
    new_action = next(a for a in rt.state.actions.values() if a.task_id == second)
    assert "reasignar" in new_action.request["instructions"]
    assert not rt.state.tasks[second].autonomous
    for action, outcome in ((old_action, "accepted"), (new_action, "rejected")):
        response = await client.post(
            "/api/v1/webhooks/happyrobot",
            json={"command_id": action.id, "outcome": outcome, "observed_at": now().isoformat()},
        )
        assert response.status_code == 202
    assert rt.state.tasks[first].status == "proposed"
    assert rt.state.tasks[second].status == "failed"
    assert rt.state.resources["res_amb1"].assigned_task_id == second
    assert rt.state.resources["res_amb1"].status == ResourceStatus.reserved


async def test_reassignment_requires_fresh_acceptance_before_movement(
    client: httpx.AsyncClient,
) -> None:
    first, second = await scarce_ambulance(client, sent=True)
    rt = runtime_of(client)
    old_action = next(a for a in rt.state.actions.values() if a.task_id == first)
    await client.post(
        "/api/v1/webhooks/happyrobot",
        json={"command_id": old_action.id, "outcome": "accepted", "observed_at": now().isoformat()},
    )
    await rt.orchestrator.reconcile_intake()
    assert rt.state.resources["res_amb1"].status == ResourceStatus.en_route
    question = next(q for q in rt.state.coordination_questions.values() if q.status == "pending")
    result = await client.post(
        f"/api/v1/control/questions/{question.id}/answer",
        headers=HEADERS,
        json={"optionIds": [second]},
    )
    assert result.json()["resolution"]["applied"]
    assert rt.state.resources["res_amb1"].status == ResourceStatus.reserved
    await rt.orchestrator.dispatch_pending()
    action = next(a for a in rt.state.actions.values() if a.task_id == second)
    await client.post(
        "/api/v1/webhooks/happyrobot",
        json={"command_id": action.id, "outcome": "accepted", "observed_at": now().isoformat()},
    )
    assert rt.state.resources["res_amb1"].status == ResourceStatus.en_route
    assert rt.state.tasks[second].status == "accepted"


async def test_scarcity_of_one_service_does_not_hold_other_services(
    client: httpx.AsyncClient,
) -> None:
    await scarce_ambulance(client)
    rt = runtime_of(client)
    await client.post(
        "/api/v1/webhooks/happyrobot/inbound",
        json=report(run_id="fire", severity="grave", victims={"count": 1}),
    )
    fire_tasks = [t for t in rt.state.tasks.values() if t.incoming_call_id == "fire"]
    assert {t.resource_types[0] for t in fire_tasks if t.status == "dispatching"} == {
        ResourceType.fire_engine,
        ResourceType.police_unit,
    }
    assert (
        next(t for t in fire_tasks if t.resource_types == [ResourceType.ambulance]).status
        == "proposed"
    )


async def test_matching_uses_alternative_services_without_false_shortage(
    client: httpx.AsyncClient,
) -> None:
    rt = runtime_of(client)
    async with rt.orchestrator.edit() as s:
        for resource in s.resources.values():
            if resource.id not in ("res_bus1", "res_pol1"):
                resource.status = ResourceStatus.out_of_service
        for id_, types in (
            ("flexible", [ResourceType.police_unit, ResourceType.evacuation_bus]),
            ("police", [ResourceType.police_unit]),
        ):
            s.upsert_task(
                Task(
                    id=id_,
                    kind=TaskKind.dispatch_resource,
                    title=id_,
                    autonomous=True,
                    resource_types=types,
                )
            )
    await rt.orchestrator.reconcile_intake()
    assert not rt.state.coordination_questions
    assert rt.state.tasks["flexible"].resource_ids == ["res_bus1"]
    assert rt.state.tasks["police"].resource_ids == ["res_pol1"]


async def test_restart_preserves_conflict_and_does_not_restore_severity_gate(
    client: httpx.AsyncClient,
) -> None:
    await scarce_ambulance(client)
    rt = runtime_of(client)
    async with rt.orchestrator.edit() as s:
        s.agent.approval_required_severities = ["vital"]
        s.agent.approval_required_for = [TaskKind.evacuate_zone]
    await rt.orchestrator.recover()
    await rt.orchestrator.reconcile_intake()
    snapshot = await rt.store.load(rt.orchestrator.incident_id)
    assert snapshot is not None
    questions = [q for q in snapshot.coordination_questions if q.status == "pending"]
    assert len(questions) == 1
    assert questions[0].expires_at is None
    assert all(not t.requires_approval for t in snapshot.tasks)


@pytest.mark.parametrize(
    ("hazards", "expected"),
    [
        ("fuga de gas; tráfico bloqueado", {"fire_engine", "police_unit"}),
        ("sin fuego; no hay armas", set()),
        ("alarma en gasolinera", set()),
        ("fuego no controlado", {"fire_engine"}),
        ("no se descarta fuga de gas", {"fire_engine"}),
    ],
)
def test_risks_add_services_without_substring_or_negation_false_positives(
    hazards: str, expected: set[str]
) -> None:
    incoming = IncomingCall.model_validate(
        report(emergency_type="otra", severity="moderada", victims={}, active_hazards=hazards)
    )
    assert set(service_requirements(incoming)) == expected


async def test_held_order_remains_sendable_after_a_long_operator_decision(
    client: httpx.AsyncClient,
) -> None:
    first, _ = await scarce_ambulance(client)
    rt = runtime_of(client)
    async with rt.orchestrator.edit() as s:
        for order in s.actions.values():
            order.expires_at = now() - timedelta(hours=1)
    await rt.orchestrator.dispatch_pending()
    question = next(q for q in rt.state.coordination_questions.values() if q.status == "pending")
    response = await client.post(
        f"/api/v1/control/questions/{question.id}/answer",
        headers=HEADERS,
        json={"optionIds": [first]},
    )
    assert response.json()["resolution"]["applied"]
    await rt.orchestrator.dispatch_pending()
    assert rt.state.tasks[first].status == "dispatched"


async def test_conflict_cannot_override_pause_or_dispatch_through_manual_call(
    client: httpx.AsyncClient,
) -> None:
    first, second = await scarce_ambulance(client)
    rt = runtime_of(client)
    await client.post("/api/v1/control/pause", headers=HEADERS)
    task = rt.state.tasks[first]
    response = await client.post(
        "/api/v1/control/call",
        headers=HEADERS,
        json={
            "task_id": first,
            "contact_id": task.assignee_contact_id,
            "instructions": "Continuar",
        },
    )
    assert response.status_code == 409
    question = next(iter(rt.state.coordination_questions.values()))
    response = await client.post(
        f"/api/v1/control/questions/{question.id}/answer",
        headers=HEADERS,
        json={"optionIds": [second]},
    )
    assert response.json()["resolution"]["applied"]
    await rt.orchestrator.dispatch_pending()
    assert rt.state.tasks[second].status == "dispatching"
    assert all(a.status in ("pending", "skipped") for a in rt.state.actions.values())

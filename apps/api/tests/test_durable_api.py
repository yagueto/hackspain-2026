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


def test_live_requires_api_key_and_webhook_secret() -> None:
    with pytest.raises(ValueError, match="modo live"):
        create_app(
            Settings(
                happyrobot_mode="live",
                happyrobot_api_key="test",
                happyrobot_webhook_secret="",
            )
        )
    with pytest.raises(ValueError, match="modo live"):
        create_app(
            Settings(
                happyrobot_mode="live",
                happyrobot_api_key="",
                happyrobot_webhook_secret="s",
            )
        )


async def test_external_http_is_blocked_in_tests() -> None:
    async with AsyncClient() as client:
        with pytest.raises(AssertionError, match="HTTP externo bloqueado"):
            await client.post("https://must-not-be-contacted.invalid", json={})


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


def coordination_question(question_id: str = "question-test") -> dict:
    return {
        "id": question_id,
        "incidentId": "zone_camping",
        "prompt": "¿Cómo continuar la coordinación?",
        "urgency": "high",
        "input": "mixed",
        "options": [
            {"id": "maintain", "label": "Mantener", "action": {"type": "none"}},
            {"id": "note", "label": "Revisar accesos", "action": {"type": "note"}},
        ],
        "textAction": {"type": "note"},
        "defaultAnswer": {"optionIds": ["maintain"], "text": "", "custom": False},
        "timeoutSeconds": 120,
    }


async def test_questions_are_authenticated_persistent_and_idempotent(client: AsyncClient) -> None:
    from tests.conftest import runtime_of

    body = coordination_question()
    assert (await client.post("/api/v1/control/questions", json=body)).status_code == 401
    created = await client.post("/api/v1/control/questions", headers=HEADERS, json=body)
    assert created.status_code == 201
    question = created.json()
    assert question["status"] == "pending"
    assert question["expiresAt"] > question["receivedAt"]
    duplicate = await client.post("/api/v1/control/questions", headers=HEADERS, json=body)
    assert duplicate.json() == question
    conflict = await client.post(
        "/api/v1/control/questions", headers=HEADERS, json={**body, "prompt": "Otra pregunta"}
    )
    assert conflict.status_code == 409
    answer = {"optionIds": [], "text": "Revisar el acceso norte", "custom": True}
    path = f"/api/v1/control/questions/{question['id']}/answer"
    assert (await client.post(path, json=answer)).status_code == 401
    result = await client.post(path, headers=HEADERS, json=answer)
    assert result.status_code == 200
    assert result.json()["resolution"]["source"] == "human"
    assert result.json()["resolution"]["applied"] is True
    assert (await client.post(path, headers=HEADERS, json=answer)).json() == result.json()
    rt = runtime_of(client)
    saved = await rt.store.load(rt.orchestrator.incident_id)
    restored = WorldState()
    restored.restore(saved)
    assert restored.snapshot().model_dump(mode="json")["coordination_questions"] == [result.json()]
    events = [event for event in restored.events if event.payload.get("question_id") == body["id"]]
    assert len(events) == 2
    assert rt.hr.calls == []


async def test_question_deadlines_are_enforced_without_a_browser(client: AsyncClient) -> None:
    from datetime import timedelta

    from tests.conftest import runtime_of

    rt = runtime_of(client)
    await rt.orchestrator.stop()
    body = coordination_question("expired-question")
    body["expiresAt"] = (now() - timedelta(seconds=1)).isoformat()
    body["urgency"] = "critical"
    response = await client.post("/api/v1/control/questions", headers=HEADERS, json=body)
    assert response.status_code == 201
    await client.post("/api/v1/control/pause", headers=HEADERS)
    await rt.orchestrator.resolve_due_questions()
    await rt.orchestrator.resolve_due_questions()
    state = (await client.get("/api/v1/state")).json()
    question = state["coordination_questions"][0]
    assert question["resolution"]["source"] == "timeout"
    assert question["resolution"]["answerLabel"] == "Mantener"
    assert rt.hr.calls == []
    assert state["agent"]["mode"] == "paused"


async def test_question_cannot_auto_dispatch_or_apply_a_stale_task_change(
    client: AsyncClient,
) -> None:
    from tests.conftest import runtime_of

    task_response = await client.post(
        "/api/v1/control/tasks",
        headers=HEADERS,
        json={"title": "Evacuación crítica", "kind": "evacuate_zone", "zone_id": "zone_poyales"},
    )
    task = task_response.json()
    body = coordination_question("task-question")
    body["incidentId"] = "zone_poyales"
    body["options"].append(
        {
            "id": "cancel",
            "label": "Cancelar propuesta",
            "action": {
                "type": "set-status",
                "taskId": task["id"],
                "status": "cancelled",
                "expectedStatus": task["status"],
                "expectedUpdatedAt": task["updated_at"],
            },
        }
    )
    dangerous = {**body, "defaultAnswer": {"optionIds": ["cancel"], "text": "", "custom": False}}
    assert (
        await client.post("/api/v1/control/questions", headers=HEADERS, json=dangerous)
    ).status_code == 422
    assert (
        await client.post("/api/v1/control/questions", headers=HEADERS, json=body)
    ).status_code == 201
    await client.post(
        f"/api/v1/control/tasks/{task['id']}/priority", headers=HEADERS, json={"priority": 99}
    )
    result = await client.post(
        "/api/v1/control/questions/task-question/answer",
        headers=HEADERS,
        json={"optionIds": ["cancel"], "text": "", "custom": False},
    )
    assert result.status_code == 200
    assert result.json()["resolution"]["applied"] is False
    rt = runtime_of(client)
    assert rt.state.tasks[task["id"]].status == "awaiting_approval"
    assert rt.hr.calls == []


async def test_stale_controls_cannot_cancel_or_complete_unapproved_missions(
    client: AsyncClient,
) -> None:
    response = await client.post(
        "/api/v1/control/tasks",
        headers=HEADERS,
        json={"title": "Evacuación crítica", "kind": "evacuate_zone", "zone_id": "zone_poyales"},
    )
    task = response.json()
    path = f"/api/v1/control/tasks/{task['id']}/status"
    assert (await client.post(path, headers=HEADERS, json={"status": "done"})).status_code == 409
    await client.post(
        f"/api/v1/control/tasks/{task['id']}/priority", headers=HEADERS, json={"priority": 99}
    )
    result = await client.post(
        path,
        headers=HEADERS,
        json={
            "status": "cancelled",
            "expected_updated_at": task["updated_at"],
        },
    )
    assert result.status_code == 409


async def test_disabling_autonomy_revalidates_held_orders(client: AsyncClient) -> None:
    from tests.conftest import runtime_of
    from tests.test_intake import report

    rt = runtime_of(client)
    await rt.orchestrator.stop()
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report())
    task = next(task for task in rt.state.tasks.values() if task.incoming_call_id)
    assert task.status == "dispatching"
    response = await client.patch(
        "/api/v1/control/agent", headers=HEADERS, json={"autonomous": False}
    )
    assert response.status_code == 200
    current = rt.state.tasks[task.id]
    assert current.status == "awaiting_approval"
    assert current.requires_approval is True
    assert current.resource_ids == []
    await rt.orchestrator.dispatch_pending()
    assert rt.hr.calls == []
    assert all(action.status == "skipped" for action in rt.state.actions.values())


async def test_linked_notes_and_manual_contact_instructions_reach_the_snapshot(
    client: AsyncClient,
) -> None:
    from app.domain.models import Task, TaskKind
    from tests.conftest import runtime_of
    from tests.test_intake import report

    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report())
    response = await client.post(
        "/api/v1/control/note",
        headers=HEADERS,
        json={
            "title": "Acceso revisado por el operador",
            "incident_id": "call:incoming-test-1",
        },
    )
    assert response.status_code == 202
    assert response.json()["payload"]["incident_id"] == "call:incoming-test-1"
    rt = runtime_of(client)
    task = Task(
        kind=TaskKind.other,
        title="Seguimiento",
        description="Instrucción anterior",
        assignee_contact_id="ct_camping",
    )
    async with rt.orchestrator.edit() as state:
        state.upsert_task(task)
    response = await client.post(
        "/api/v1/control/call",
        headers=HEADERS,
        json={
            "contact_id": "ct_camping",
            "task_id": task.id,
            "instructions": "Nueva instrucción confirmada",
        },
    )
    assert response.status_code == 200
    assert response.json()["request"]["instructions"] == "Nueva instrucción confirmada"


async def test_question_demo_is_opt_in_and_invalid_answers_do_not_resolve(
    client: AsyncClient,
) -> None:
    from tests.conftest import runtime_of

    assert (await client.post("/api/v1/control/questions/demo")).status_code == 401
    response = await client.post("/api/v1/control/questions/demo", headers=HEADERS)
    assert response.status_code == 201
    question = response.json()
    result = await client.post(
        f"/api/v1/control/questions/{question['id']}/answer",
        headers=HEADERS,
        json={
            "optionIds": ["unknown"],
            "text": "",
            "custom": False,
        },
    )
    assert result.status_code == 409
    assert runtime_of(client).state.coordination_questions[question["id"]].status == "pending"
    runtime_of(client).settings.seed_demo = False
    assert (await client.post("/api/v1/control/questions/demo", headers=HEADERS)).status_code == 409


async def test_explicit_resume_restarts_automatic_cycles_after_manual_start(
    client: AsyncClient,
) -> None:
    from tests.conftest import runtime_of

    rt = runtime_of(client)
    assert rt.orchestrator._autoplan is False
    response = await client.post("/api/v1/control/resume", headers=HEADERS)
    assert response.status_code == 200
    assert rt.orchestrator._autoplan is True
    await client.post("/api/v1/control/pause", headers=HEADERS)
    assert rt.state.agent.mode == "paused"


async def test_coordinator_resource_choice_preserves_critical_approval(client: AsyncClient) -> None:
    from tests.conftest import runtime_of
    from tests.test_intake import report

    rt = runtime_of(client)
    await rt.orchestrator.stop()
    await client.post("/api/v1/webhooks/happyrobot/inbound", json=report(severity="vital"))
    task = next(task for task in rt.state.tasks.values() if task.incoming_call_id)
    resource = next(
        resource for resource in rt.state.resources.values() if resource.type == "fire_engine"
    )
    body = coordination_question("resource-choice")
    body["incidentId"] = f"call:{task.incoming_call_id}"
    body["options"].append(
        {
            "id": "assign",
            "label": "Proponer este recurso",
            "action": {
                "type": "assign-resource",
                "resourceId": resource.id,
                "expectedIncidentId": None,
                "taskId": task.id,
                "expectedStatus": task.status,
                "expectedUpdatedAt": task.updated_at.isoformat(),
            },
        }
    )
    assert (
        await client.post("/api/v1/control/questions", headers=HEADERS, json=body)
    ).status_code == 201
    response = await client.post(
        "/api/v1/control/questions/resource-choice/answer",
        headers=HEADERS,
        json={"custom": False, "text": "", "optionIds": ["assign"]},
    )
    assert response.status_code == 200
    assert response.json()["resolution"]["applied"] is True
    current = rt.state.tasks[task.id]
    assert current.preferred_resource_id == resource.id
    assert current.status == "awaiting_approval"
    assert current.resource_ids == []
    assert rt.state.resources[resource.id].assigned_task_id is None
    assert rt.hr.calls == []

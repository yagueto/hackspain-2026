import asyncio
import os
import uuid
from collections.abc import AsyncIterator
from datetime import timedelta

import httpx
import psycopg
import pytest
from psycopg.conninfo import make_conninfo
from psycopg.sql import SQL, Identifier

from app.config import Settings
from app.domain.models import (
    Action,
    ActionKind,
    ActionStatus,
    EventKind,
    Observation,
    ObservationRow,
    Receipt,
    ResourceStatus,
    WorldSnapshot,
    now,
)
from app.domain.scenario import seed_wildfire
from app.domain.state import WorldState
from app.main import build_runtime, create_app
from app.store.persistence import (
    MemoryStore,
    ObservationConflict,
    Store,
    StoreError,
    VersionConflict,
)
from app.store.postgres import PostgresStore, json_literal, literal


@pytest.fixture
async def pg() -> AsyncIterator[PostgresStore]:
    dsn = os.environ.get("TEST_POSTGRES_DSN")
    if not dsn:
        pytest.skip("TEST_POSTGRES_DSN no configurado")
    schema = f"test_{uuid.uuid4().hex}"
    async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as conn:
        await conn.execute(SQL("CREATE SCHEMA {}").format(Identifier(schema)))
    store = PostgresStore(
        Settings(database_url=make_conninfo(dsn, options=f"-c search_path={schema}"))
    )
    await store.migrate()
    await store.open()
    try:
        yield store
    finally:
        await store.close()
        async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as conn:
            await conn.execute(SQL("DROP SCHEMA {} CASCADE").format(Identifier(schema)))


def snapshot() -> WorldSnapshot:
    state = WorldState()
    seed_wildfire(state)
    return state.snapshot(full=True)


async def test_migration_idempotent_and_schema_version_guard(pg: PostgresStore) -> None:
    await pg.migrate()
    await pg.query("INSERT INTO crisis_schema_version(version) VALUES (2)")
    with pytest.raises(StoreError):
        await pg.open()
    with pytest.raises(StoreError):
        await pg.migrate()


async def test_open_bootstraps_an_empty_database_but_never_a_partial_schema() -> None:
    dsn = os.environ.get("TEST_POSTGRES_DSN")
    if not dsn:
        pytest.skip("TEST_POSTGRES_DSN no configurado")

    async def store_on(schema: str) -> PostgresStore:
        async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as conn:
            await conn.execute(SQL("CREATE SCHEMA {}").format(Identifier(schema)))
        return PostgresStore(
            Settings(database_url=make_conninfo(dsn, options=f"-c search_path={schema}"))
        )

    async def drop(schema: str) -> None:
        async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as conn:
            await conn.execute(SQL("DROP SCHEMA {} CASCADE").format(Identifier(schema)))

    empty, partial = f"test_{uuid.uuid4().hex}", f"test_{uuid.uuid4().hex}"
    try:
        # Base recién creada: arranca el esquema sin exigir el comando manual.
        fresh = await store_on(empty)
        await fresh.open()
        assert await fresh.query("SELECT version FROM crisis_schema_version") == [{"version": 1}]
        await fresh.open()  # idempotente

        # Esquema a medias: podría ser una base ajena o una migración interrumpida.
        half = await store_on(partial)
        await half.query("CREATE TABLE crisis_world (incident_id text PRIMARY KEY)")
        with pytest.raises(StoreError, match="incompleto"):
            await half.open()
        tables = {t.name for t in await half.inspect_schema()}
        assert tables == {"crisis_world"}  # no se ha creado nada por su cuenta
    finally:
        for schema in (empty, partial):
            await drop(schema)


async def test_atomic_snapshot_receipt_assignment_outbox_and_cas(pg: PostgresStore) -> None:
    initial = snapshot()
    await pg.create(initial)
    obs = Observation(
        incident_id=initial.incident.id,
        kind=EventKind.note,
        title="novedad",
    )
    await pg.observe(obs)
    updated = initial.model_copy(deep=True)
    updated.version = 1
    updated.resources[0].assigned_task_id = "task_a"
    updated.resources[0].status = ResourceStatus.reserved
    updated.recent_actions = [Action(kind=ActionKind.call, summary="orden pendiente")]
    await pg.save(updated, 0, [Receipt(observation_id=obs.observation_id, status="applied")])
    assert (await pg.load(initial.incident.id)).version == 1
    assert await pg.pending(initial.incident.id, 20) == []
    assert (await pg.query("SELECT status FROM crisis_commands")) == [{"status": "pending"}]
    assert any(
        row["task_id"] == "task_a"
        for row in await pg.query("SELECT task_id FROM crisis_assignments")
    )
    with pytest.raises(VersionConflict):
        await pg.save(updated, 0, [])
    assert len(await pg.query("SELECT * FROM crisis_commands")) == 1


async def test_constraint_failure_rolls_back_all_writes(pg: PostgresStore) -> None:
    initial = snapshot()
    await pg.create(initial)
    updated = initial.model_copy(deep=True)
    updated.version = 1
    updated.recent_actions = [Action(kind=ActionKind.call, summary="no debe persistir")]
    with pytest.raises(StoreError):
        await pg.save(updated, 0, [Receipt(observation_id="missing", status="applied")])
    assert (await pg.load(initial.incident.id)).version == 0
    assert await pg.query("SELECT * FROM crisis_commands") == []
    assert await pg.query("SELECT * FROM crisis_assignments") == []


async def test_pending_observations_block_atomic_send_claim(pg: PostgresStore) -> None:
    initial = snapshot()
    await pg.create(initial)
    await pg.observe(
        Observation(
            incident_id=initial.incident.id, kind=EventKind.note, title="cambio concurrente"
        )
    )
    updated = initial.model_copy(deep=True)
    updated.version = 1
    updated.recent_actions = [
        Action(kind=ActionKind.call, summary="orden", status=ActionStatus.sending)
    ]
    with pytest.raises(VersionConflict):
        await pg.save(updated, 0, [], require_synced=True)
    assert (await pg.load(initial.incident.id)).version == 0
    assert await pg.query("SELECT * FROM crisis_commands") == []


async def test_two_writers_only_one_commits(pg: PostgresStore) -> None:
    initial = snapshot()
    await pg.create(initial)
    left, right = initial.model_copy(deep=True), initial.model_copy(deep=True)
    left.version = right.version = 1
    left.resources[0].assigned_task_id = "left"
    right.resources[0].assigned_task_id = "right"
    results = await asyncio.gather(
        pg.save(left, 0, []),
        pg.save(right, 0, []),
        return_exceptions=True,
    )
    assert sum(isinstance(result, VersionConflict) for result in results) == 1
    assert sum(result is None for result in results) == 1
    stored = await pg.load(initial.incident.id)
    assert stored.resources[0].assigned_task_id in ("left", "right")


async def test_polling_pages_quarantine_and_late_insertion(pg: PostgresStore) -> None:
    initial = snapshot()
    await pg.create(initial)
    rt = build_runtime(Settings(agent_autostart=False), store=pg)
    rt.state.restore(initial)
    rt.orchestrator.batch_size = 2
    for index in range(5):
        await pg.observe(
            Observation(
                observation_id=f"observation_{index}",
                incident_id=initial.incident.id,
                kind=EventKind.note,
                title=f"nota {index}",
            )
        )
    await pg.query(
        "INSERT INTO crisis_observations(observation_id,incident_id,body) VALUES "
        f"('invalid',{literal(initial.incident.id)}, '{'{}'}'::jsonb)"
    )
    await rt.orchestrator.synchronize()
    receipts = await pg.receipts(initial.incident.id)
    assert len(receipts) == 6
    assert next(r for r in receipts if r.observation_id == "invalid").status == "invalid"
    obs = Observation(
        observation_id="late",
        incident_id=initial.incident.id,
        kind=EventKind.note,
        title="insertada después con fecha anterior",
        observed_at=now() - timedelta(days=1),
    )
    await pg.query(
        "INSERT INTO crisis_observations(observation_id,incident_id,received_at,body) VALUES "
        f"('late',{literal(initial.incident.id)},'2000-01-01',{json_literal(obs.model_dump(mode='json'))})"
    )
    await rt.orchestrator.synchronize()
    assert len(await pg.receipts(initial.incident.id)) == 7
    assert await pg.pending(initial.incident.id, 2) == []
    await rt.hr.aclose()


async def test_idempotency_and_sql_escaping(pg: PostgresStore) -> None:
    initial = snapshot()
    await pg.create(initial)
    obs = Observation(
        observation_id="obs'; DROP TABLE crisis_world; -- $crisis$",
        incident_id=initial.incident.id,
        kind=EventKind.note,
        title="' \\ $crisis$ $crisis_$ ¿fuego?",
    )
    await pg.observe(obs)
    await pg.observe(obs)
    assert len(await pg.pending(initial.incident.id, 20)) == 1
    with pytest.raises(StoreError):
        await pg.observe(obs.model_copy(update={"title": "otro contenido"}))
    assert (await pg.pending(initial.incident.id, 20))[0].body == obs.model_dump(mode="json")
    assert await pg.load(initial.incident.id)


async def test_conflicting_observation_is_not_a_transient_store_error(pg: PostgresStore) -> None:
    initial = snapshot()
    await pg.create(initial)
    obs = Observation(incident_id=initial.incident.id, kind=EventKind.note, title="aviso original")
    await pg.observe(obs)
    with pytest.raises(ObservationConflict):
        await pg.observe(obs.model_copy(update={"title": "contenido diferente"}))
    assert (await pg.pending(initial.incident.id, 10))[0].body == obs.model_dump(mode="json")


async def test_store_requires_dsn_and_fails_closed_when_unreachable() -> None:
    with pytest.raises(ValueError):
        PostgresStore(Settings())
    unreachable = PostgresStore(Settings(database_url="postgresql://crisis@127.0.0.1:1/crisis"))
    with pytest.raises(StoreError):
        await unreachable.load("incident")


async def test_restart_restores_all_actions_and_pending_commands(pg: PostgresStore) -> None:
    initial = snapshot()
    initial.recent_actions = [
        Action(kind=ActionKind.call, summary=f"anterior {i}", status=ActionStatus.completed)
        for i in range(60)
    ]
    pending = Action(
        kind=ActionKind.call, summary="pendiente", workflow="call_civilian", request={}
    )
    sending = Action(
        kind=ActionKind.call,
        summary="incierta",
        workflow="call_civilian",
        status=ActionStatus.sending,
    )
    initial.recent_actions.extend([pending, sending])
    await pg.create(initial)
    rt = build_runtime(Settings(agent_autostart=False), store=pg)
    rt.state.restore(await pg.load(initial.incident.id))
    await rt.orchestrator.recover()
    assert len(rt.state.actions) == 62
    assert rt.state.actions[sending.id].status == ActionStatus.unknown
    await rt.orchestrator.dispatch_pending()
    assert rt.state.actions[pending.id].status == ActionStatus.dispatched
    assert rt.state.actions[sending.id].attempts == 0
    restored = await pg.load(initial.incident.id)
    assert len(restored.recent_actions) == 62
    await rt.hr.aclose()


async def test_restart_api_on_postgres_without_happyrobot_key(pg: PostgresStore) -> None:
    settings = Settings(
        storage_backend="postgres",
        database_url=pg._dsn,
        agent_autostart=False,
        happyrobot_api_key="",
        api_key="test",
    )
    app = create_app(settings)
    headers = {"X-API-Key": "test"}
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as client:
            assert (await client.post("/api/v1/control/tick", headers=headers)).status_code == 200
            action = (await client.get("/api/v1/actions")).json()[0]
            response = await client.post(
                "/api/v1/webhooks/happyrobot",
                json={
                    "command_id": action["id"],
                    "observation_id": "persisted-callback",
                    "outcome": "accepted",
                    "eta_minutes": "12",
                },
            )
            assert response.status_code == 202
            await client.post("/api/v1/control/pause", headers=headers)
            saved = (await client.get("/api/v1/state")).json()
    restarted = create_app(settings)
    async with restarted.router.lifespan_context(restarted):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(restarted), base_url="http://test"
        ) as client:
            restored = (await client.get("/api/v1/state")).json()
            assert restored["version"] == saved["version"]
            assert restored["tasks"] == saved["tasks"]
            assert restored["recent_actions"] == saved["recent_actions"]
            assert restored["resources"] == saved["resources"]
            assert restored["agent"]["mode"] == "paused"
            assert (await client.get("/api/v1/receipts", headers=headers)).json() == [
                {"observation_id": "persisted-callback", "status": "applied", "reason": ""}
            ]
            health = (await client.get("/healthz")).json()
            assert health["storage"] == "postgres"
            assert health["synchronized"]


async def test_chatbot_location_persists_in_postgres_and_emits_snapshot(pg: PostgresStore) -> None:
    settings = Settings(
        storage_backend="postgres",
        database_url=pg._dsn,
        agent_autostart=False,
        happyrobot_webhook_secret="intake-test",
    )
    payload = {
        "run_id": "chat-postgres",
        "timestamp": now().isoformat(),
        "emergency_type": "incendio",
        "severity": "grave",
        "location": {
            "raw_text": "Ubicación de prueba",
            "lat": 40.1,
            "lng": -4.2,
            "confirmed": True,
        },
    }
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        changes = app.state.rt.state.subscribe()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/api/v1/webhooks/happyrobot/inbound",
                json=payload,
                headers={"X-Webhook-Secret": "intake-test"},
            )
            assert response.status_code == 202
            change = await asyncio.wait_for(changes.get(), timeout=1)
            assert change.type == "snapshot"
            assert change.data["incoming_calls"][0]["location"]["lat"] == 40.1
            saved = (await client.get("/api/v1/state")).json()
        app.state.rt.state.unsubscribe(changes)
    restarted = create_app(settings)
    async with restarted.router.lifespan_context(restarted):
        restored = restarted.state.rt.state.snapshot()
        assert len(restored.incoming_calls) == 1
        assert restored.incoming_calls[0].location.lng == -4.2
        assert restored.version == saved["version"]
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(restarted), base_url="http://test"
        ) as client:
            response = await client.post(
                "/api/v1/webhooks/happyrobot/inbound",
                json=payload,
                headers={"X-Webhook-Secret": "intake-test"},
            )
            assert response.status_code == 202
            assert restarted.state.rt.state.version == restored.version
            assert len(restarted.state.rt.state.incoming_calls) == 1


class InvalidRowStore(MemoryStore):
    async def pending(self, incident_id: str, limit: int) -> list[ObservationRow]:
        if "bad" not in self.processed:
            return [
                ObservationRow(
                    observation_id="bad",
                    body={
                        "observation_id": "bad",
                        "incident_id": incident_id,
                        "kind": "fire_spread",
                        "title": "invalid",
                        "payload": {"front_id": "front_sur", "threatens": {"missing": -20}},
                    },
                )
            ]
        return []


async def test_invalid_observation_cannot_partially_mutate_snapshot() -> None:
    store: Store = InvalidRowStore()
    initial = snapshot()
    await store.create(initial)
    rt = build_runtime(Settings(), store=store)
    rt.state.restore(initial)
    await rt.orchestrator.synchronize()
    assert rt.state.fronts["front_sur"] == next(f for f in initial.fronts if f.id == "front_sur")
    await rt.hr.aclose()


async def test_coordination_survives_sql_restore_and_concurrent_answers(pg: PostgresStore) -> None:
    from app.domain.models import CoordinationAnswer, CoordinationQuestionIn
    from tests.test_durable_api import coordination_question

    initial = snapshot()
    await pg.create(initial)
    settings = Settings(agent_autostart=False, geocoding_enabled=False)
    left = build_runtime(settings, store=pg)
    right = build_runtime(settings, store=pg)
    try:
        left.state.restore(initial)
        question = await left.orchestrator.create_question(
            CoordinationQuestionIn.model_validate(coordination_question("sql-question"))
        )
        stored = await pg.load(initial.incident.id)
        right.state.restore(stored)
        assert right.state.coordination_questions[question.id] == question
        answers = [
            CoordinationAnswer(option_ids=["note"]),
            CoordinationAnswer(option_ids=["maintain"]),
        ]
        results = await asyncio.gather(
            left.orchestrator.answer_question(question.id, answers[0]),
            right.orchestrator.answer_question(question.id, answers[1]),
            return_exceptions=True,
        )
        assert all(
            not isinstance(result, Exception) or isinstance(result, VersionConflict)
            for result in results
        )
        stored = await pg.load(initial.incident.id)
        saved = stored.coordination_questions[0]
        assert saved.status == "resolved"
        assert saved.resolution.answer in answers
        response_events = [
            event
            for event in stored.recent_events
            if event.payload.get("question_id") == question.id
            and event.payload.get("log_kind") == "answer"
        ]
        assert len(response_events) == 1
        replay = await right.orchestrator.answer_question(question.id, answers[1])
        assert replay == saved
        assert len((await pg.load(initial.incident.id)).coordination_questions) == 1
    finally:
        await left.hr.aclose()
        await right.hr.aclose()
        await left.geocoder.close()
        await right.geocoder.close()

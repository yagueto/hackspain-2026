import asyncio
import os
import uuid
from collections.abc import AsyncIterator
from datetime import timedelta

import httpx
import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.sql import SQL, Identifier
from pydantic import BaseModel

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
from app.main import build_runtime
from app.store.persistence import MemoryStore, Store, StoreError, VersionConflict
from app.store.twin import TwinStore, json_literal, literal


class SQLBody(BaseModel):
    sql: str


@pytest.fixture
async def twin() -> AsyncIterator[TwinStore]:
    dsn = os.environ.get("TEST_POSTGRES_DSN")
    if not dsn:
        pytest.skip("TEST_POSTGRES_DSN no configurado")
    schema = f"test_{uuid.uuid4().hex}"
    async with await psycopg.AsyncConnection.connect(dsn, autocommit=True) as conn:
        await conn.execute(SQL("CREATE SCHEMA {}").format(Identifier(schema)))

    async def handle(request: httpx.Request) -> httpx.Response:
        async with await psycopg.AsyncConnection.connect(
            dsn, autocommit=True, row_factory=dict_row
        ) as connection:
            await connection.execute(SQL("SET search_path TO {}").format(Identifier(schema)))
            if request.method == "GET":
                assert request.url.path == "/api/v2/twin/schema"
                cursor = await connection.execute(
                    "SELECT table_name, column_name, data_type FROM information_schema.columns "
                    "WHERE table_schema = %s",
                    (schema,),
                )
                columns = await cursor.fetchall()
                return httpx.Response(
                    200,
                    json=[
                        {
                            "name": table,
                            "kind": "table",
                            "columns": [
                                {
                                    "name": c["column_name"],
                                    "type": c["data_type"],
                                    "isPrimary": False,
                                }
                                for c in columns
                                if c["table_name"] == table
                            ],
                        }
                        for table in sorted({c["table_name"] for c in columns})
                    ],
                )
            assert request.url.path == "/api/v2/twin/sql"
            assert request.method == "POST"
            body = SQLBody.model_validate_json(request.content)
            try:
                cursor = await connection.execute(SQL(body.sql))
                rows = await cursor.fetchall() if cursor.description else []
                return httpx.Response(200, json={"rows": rows, "truncated": False})
            except psycopg.Error as exc:
                return httpx.Response(400, json={"error": str(exc)})

    client = httpx.AsyncClient(
        base_url="https://twin.test/api/v2", transport=httpx.MockTransport(handle)
    )
    store = TwinStore(Settings(), client)
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


async def test_migration_idempotent_and_schema_version_guard(twin: TwinStore) -> None:
    await twin.migrate()
    await twin.query("INSERT INTO crisis_schema_version(version) VALUES (2)")
    with pytest.raises(StoreError):
        await twin.open()
    with pytest.raises(StoreError):
        await twin.migrate()


async def test_atomic_snapshot_receipt_assignment_outbox_and_cas(twin: TwinStore) -> None:
    initial = snapshot()
    await twin.create(initial)
    obs = Observation(
        incident_id=initial.incident.id,
        kind=EventKind.note,
        title="novedad",
    )
    await twin.observe(obs)
    updated = initial.model_copy(deep=True)
    updated.version = 1
    updated.resources[0].assigned_task_id = "task_a"
    updated.resources[0].status = ResourceStatus.reserved
    updated.recent_actions = [Action(kind=ActionKind.call, summary="orden pendiente")]
    await twin.save(updated, 0, [Receipt(observation_id=obs.observation_id, status="applied")])
    assert (await twin.load(initial.incident.id)).version == 1
    assert await twin.pending(initial.incident.id, 20) == []
    assert (await twin.query("SELECT status FROM crisis_commands")) == [{"status": "pending"}]
    assert any(
        row["task_id"] == "task_a"
        for row in await twin.query("SELECT task_id FROM crisis_assignments")
    )
    with pytest.raises(VersionConflict):
        await twin.save(updated, 0, [])
    assert len(await twin.query("SELECT * FROM crisis_commands")) == 1


async def test_constraint_failure_rolls_back_all_writes(twin: TwinStore) -> None:
    initial = snapshot()
    await twin.create(initial)
    updated = initial.model_copy(deep=True)
    updated.version = 1
    updated.recent_actions = [Action(kind=ActionKind.call, summary="no debe persistir")]
    with pytest.raises(StoreError):
        await twin.save(updated, 0, [Receipt(observation_id="missing", status="applied")])
    assert (await twin.load(initial.incident.id)).version == 0
    assert await twin.query("SELECT * FROM crisis_commands") == []
    assert await twin.query("SELECT * FROM crisis_assignments") == []


async def test_pending_observations_block_atomic_send_claim(twin: TwinStore) -> None:
    initial = snapshot()
    await twin.create(initial)
    await twin.observe(
        Observation(
            incident_id=initial.incident.id, kind=EventKind.note, title="cambio concurrente"
        )
    )
    updated = initial.model_copy(deep=True)
    updated.version = 1
    updated.recent_actions = [
        Action(kind=ActionKind.sms, summary="orden", status=ActionStatus.sending)
    ]
    with pytest.raises(VersionConflict):
        await twin.save(updated, 0, [], require_synced=True)
    assert (await twin.load(initial.incident.id)).version == 0
    assert await twin.query("SELECT * FROM crisis_commands") == []


async def test_two_writers_only_one_commits(twin: TwinStore) -> None:
    initial = snapshot()
    await twin.create(initial)
    left, right = initial.model_copy(deep=True), initial.model_copy(deep=True)
    left.version = right.version = 1
    left.resources[0].assigned_task_id = "left"
    right.resources[0].assigned_task_id = "right"
    results = await asyncio.gather(
        twin.save(left, 0, []),
        twin.save(right, 0, []),
        return_exceptions=True,
    )
    assert sum(isinstance(result, VersionConflict) for result in results) == 1
    assert sum(result is None for result in results) == 1
    stored = await twin.load(initial.incident.id)
    assert stored.resources[0].assigned_task_id in ("left", "right")


async def test_polling_pages_quarantine_and_late_insertion(twin: TwinStore) -> None:
    initial = snapshot()
    await twin.create(initial)
    rt = build_runtime(Settings(agent_autostart=False), store=twin)
    rt.state.restore(initial)
    rt.orchestrator.batch_size = 2
    for index in range(5):
        await twin.observe(
            Observation(
                observation_id=f"observation_{index}",
                incident_id=initial.incident.id,
                kind=EventKind.note,
                title=f"nota {index}",
            )
        )
    await twin.query(
        "INSERT INTO crisis_observations(observation_id,incident_id,body) VALUES "
        f"('invalid',{literal(initial.incident.id)}, '{'{}'}'::jsonb)"
    )
    await rt.orchestrator.synchronize()
    receipts = await twin.receipts(initial.incident.id)
    assert len(receipts) == 6
    assert next(r for r in receipts if r.observation_id == "invalid").status == "invalid"
    obs = Observation(
        observation_id="late",
        incident_id=initial.incident.id,
        kind=EventKind.note,
        title="insertada después con fecha anterior",
        observed_at=now() - timedelta(days=1),
    )
    await twin.query(
        "INSERT INTO crisis_observations(observation_id,incident_id,received_at,body) VALUES "
        f"('late',{literal(initial.incident.id)},'2000-01-01',{json_literal(obs.model_dump(mode='json'))})"
    )
    await rt.orchestrator.synchronize()
    assert len(await twin.receipts(initial.incident.id)) == 7
    assert await twin.pending(initial.incident.id, 2) == []
    await rt.hr.aclose()


async def test_idempotency_and_sql_escaping(twin: TwinStore) -> None:
    initial = snapshot()
    await twin.create(initial)
    obs = Observation(
        observation_id="obs'; DROP TABLE crisis_world; -- $crisis$",
        incident_id=initial.incident.id,
        kind=EventKind.note,
        title="' \\ $crisis$ $crisis_$ ¿fuego?",
    )
    await twin.observe(obs)
    await twin.observe(obs)
    assert len(await twin.pending(initial.incident.id, 20)) == 1
    with pytest.raises(StoreError):
        await twin.observe(obs.model_copy(update={"title": "otro contenido"}))
    assert (await twin.pending(initial.incident.id, 20))[0].body == obs.model_dump(mode="json")
    assert await twin.load(initial.incident.id)


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, json={"rows": [{}], "truncated": True}),
        httpx.Response(200, json={}),
        httpx.Response(401, json={"error": "unauthorized"}),
        httpx.Response(503, json={"error": "unavailable"}),
    ],
)
async def test_twin_contract_fails_closed(response: httpx.Response) -> None:
    async with httpx.AsyncClient(
        base_url="https://twin.test", transport=httpx.MockTransport(lambda request: response)
    ) as client:
        store = TwinStore(Settings(), client)
        with pytest.raises(StoreError):
            await store.load("incident")


async def test_restart_restores_all_actions_and_pending_commands(twin: TwinStore) -> None:
    initial = snapshot()
    initial.recent_actions = [
        Action(kind=ActionKind.sms, summary=f"anterior {i}", status=ActionStatus.completed)
        for i in range(60)
    ]
    pending = Action(kind=ActionKind.sms, summary="pendiente", workflow="sms", request={})
    sending = Action(
        kind=ActionKind.sms, summary="incierta", workflow="sms", status=ActionStatus.sending
    )
    initial.recent_actions.extend([pending, sending])
    await twin.create(initial)
    rt = build_runtime(Settings(agent_autostart=False), store=twin)
    rt.state.restore(await twin.load(initial.incident.id))
    await rt.orchestrator.recover()
    assert len(rt.state.actions) == 62
    assert rt.state.actions[sending.id].status == ActionStatus.unknown
    await rt.orchestrator.dispatch_pending()
    assert rt.state.actions[pending.id].status == ActionStatus.dispatched
    assert rt.state.actions[sending.id].attempts == 0
    restored = await twin.load(initial.incident.id)
    assert len(restored.recent_actions) == 62
    await rt.hr.aclose()


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

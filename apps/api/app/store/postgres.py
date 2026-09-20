from __future__ import annotations

import json
import logging
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.sql import SQL
from pydantic import BaseModel, JsonValue

from app.config import Settings
from app.domain.models import Observation, ObservationRow, Receipt, WorldSnapshot
from app.store.persistence import Store, StoreError, VersionConflict

log = logging.getLogger(__name__)


def literal(value: str) -> str:
    delimiter = "$crisis$"
    while delimiter in value:
        delimiter = delimiter[:-1] + "_$"
    return f"{delimiter}{value}{delimiter}"


def json_literal(value: JsonValue) -> str:
    return f"{literal(json.dumps(value, ensure_ascii=False))}::jsonb"


class Column(BaseModel):
    name: str
    type: str


class Table(BaseModel):
    name: str
    kind: str
    columns: list[Column]


EXPECTED_COLUMNS = {
    "crisis_schema_version": {"version"},
    "crisis_world": {"incident_id", "version", "snapshot", "updated_at"},
    "crisis_observations": {"observation_id", "incident_id", "received_at", "body"},
    "crisis_receipts": {"observation_id", "incident_id", "status", "reason", "processed_at"},
    "crisis_assignments": {"incident_id", "resource_id", "task_id", "status"},
    "crisis_commands": {"command_id", "incident_id", "status", "body"},
    "crisis_journal": {"incident_id", "kind", "object_id", "body"},
}


class PostgresStore(Store):
    def __init__(self, settings: Settings) -> None:
        self._dsn = settings.database_url.get_secret_value()
        if not self._dsn:
            raise ValueError("PostgreSQL requiere DATABASE_URL")

    async def query(self, sql: str) -> list[dict[str, JsonValue]]:
        try:
            async with await psycopg.AsyncConnection.connect(
                self._dsn, autocommit=True, row_factory=dict_row, connect_timeout=5
            ) as connection:
                await connection.execute("SET statement_timeout = '15s'")
                cursor = await connection.execute(SQL(sql))
                return await cursor.fetchall() if cursor.description else []
        except psycopg.Error:
            raise StoreError("PostgreSQL no disponible o consulta rechazada") from None

    async def inspect_schema(self) -> list[Table]:
        rows = await self.query("""
            SELECT t.table_name AS name,
                CASE WHEN t.table_type = 'BASE TABLE' THEN 'table' ELSE 'view' END AS kind,
                jsonb_agg(jsonb_build_object(
                    'name', c.column_name, 'type', c.data_type
                ) ORDER BY c.ordinal_position) AS columns
            FROM information_schema.tables t
            JOIN information_schema.columns c
                ON c.table_schema = t.table_schema AND c.table_name = t.table_name
            WHERE t.table_schema = current_schema()
            GROUP BY t.table_name, t.table_type
            ORDER BY t.table_name
        """)
        return [Table.model_validate(row) for row in rows]

    async def migrate(self) -> None:
        tables = await self.inspect_schema()
        for table in tables:
            expected = EXPECTED_COLUMNS.get(table.name)
            if expected and (table.kind != "table" or {c.name for c in table.columns} != expected):
                raise StoreError(
                    f"tabla incompatible: {table.name}; revisa el schema antes de migrar"
                )
        if any(t.name == "crisis_schema_version" for t in tables):
            versions = await self.query("SELECT version FROM crisis_schema_version")
            if any(v["version"] != 1 for v in versions):
                raise StoreError("versión de esquema no soportada")
        schema = Path(__file__).with_name("schema.sql").read_text()
        for statement in schema.split(";"):
            if statement.strip():
                await self.query(statement)

    async def open(self) -> None:
        tables = {t.name for t in await self.inspect_schema()}
        if not tables & set(EXPECTED_COLUMNS):
            # Base recién creada: arrancar el esquema es más útil que fallar en el caso más
            # inocente. Con tablas a medias no se toca nada: podría ser una base ajena por un
            # DATABASE_URL equivocado, o una migración interrumpida que hay que revisar.
            log.info("PostgreSQL sin esquema crisis; aplicando el esquema v1")
            await self.migrate()
            tables = {t.name for t in await self.inspect_schema()}
        if "crisis_schema_version" not in tables:
            missing = ", ".join(sorted(set(EXPECTED_COLUMNS) - tables))
            raise StoreError(
                f"esquema crisis incompleto (faltan: {missing}); "
                "revísalo y ejecuta `python -m app.store.migrate --apply`"
            )
        versions = await self.query("SELECT version FROM crisis_schema_version")
        if versions != [{"version": 1}]:
            raise StoreError(
                "versión de esquema no soportada; revisa `python -m app.store.migrate`"
            )

    async def close(self) -> None:
        pass

    async def load(self, incident_id: str) -> WorldSnapshot | None:
        rows = await self.query(
            f"SELECT snapshot FROM crisis_world WHERE incident_id = {literal(incident_id)}"
        )
        return WorldSnapshot.model_validate(rows[0]["snapshot"]) if rows else None

    async def create(self, snapshot: WorldSnapshot) -> WorldSnapshot:
        await self.query(
            "INSERT INTO crisis_world(incident_id, version, snapshot) VALUES "
            f"({literal(snapshot.incident.id)}, {snapshot.version}, "
            f"{json_literal(snapshot.model_dump(mode='json'))}) ON CONFLICT DO NOTHING"
        )
        result = await self.load(snapshot.incident.id)
        if result is None:
            raise StoreError("no se pudo inicializar el incidente")
        return result

    async def save(
        self,
        snapshot: WorldSnapshot,
        expected_version: int,
        receipts: list[Receipt],
        *,
        require_synced: bool = False,
    ) -> None:
        if snapshot.version != expected_version + 1:
            raise StoreError("incremento de versión inválido")
        payload = json_literal(snapshot.model_dump(mode="json"))
        receipt_data = json_literal([r.model_dump(mode="json") for r in receipts])
        incident = literal(snapshot.incident.id)
        sync_guard = (
            " AND NOT EXISTS (SELECT 1 FROM crisis_observations o"
            f" WHERE o.incident_id = {incident} AND NOT EXISTS "
            "(SELECT 1 FROM crisis_receipts r WHERE r.observation_id = o.observation_id))"
            if require_synced
            else ""
        )
        rows = await self.query(f"""
            WITH saved AS (
                UPDATE crisis_world SET snapshot = {payload}, version = {snapshot.version},
                    updated_at = clock_timestamp()
                WHERE incident_id = {incident} AND version = {expected_version}
                {sync_guard}
                RETURNING incident_id, snapshot
            ), receipts AS (
                INSERT INTO crisis_receipts(observation_id, incident_id, status, reason)
                SELECT r->>'observation_id', s.incident_id, r->>'status', r->>'reason'
                FROM saved s, jsonb_array_elements({receipt_data}) r
                ON CONFLICT (observation_id) DO NOTHING
            ), assignments AS (
                INSERT INTO crisis_assignments(incident_id, resource_id, task_id, status)
                SELECT s.incident_id, r->>'id', r->>'assigned_task_id', r->>'status'
                FROM saved s, jsonb_array_elements(s.snapshot->'resources') r
                ON CONFLICT (incident_id, resource_id) DO UPDATE
                SET task_id = EXCLUDED.task_id, status = EXCLUDED.status
            ), commands AS (
                INSERT INTO crisis_commands(command_id, incident_id, status, body)
                SELECT a->>'id', s.incident_id, a->>'status', a
                FROM saved s, jsonb_array_elements(s.snapshot->'recent_actions') a
                ON CONFLICT (command_id) DO UPDATE
                SET status = EXCLUDED.status, body = EXCLUDED.body
            ), journal AS (
                INSERT INTO crisis_journal(incident_id, kind, object_id, body)
                SELECT s.incident_id, v.kind, a->>'id', a
                FROM saved s,
                    (VALUES ('event', 'recent_events'), ('decision', 'recent_decisions'),
                            ('action', 'recent_actions')) v(kind, field),
                    LATERAL jsonb_array_elements(s.snapshot->v.field) a
                ON CONFLICT (incident_id, kind, object_id) DO UPDATE SET body = EXCLUDED.body
            )
            SELECT incident_id FROM saved
        """)
        if not rows:
            raise VersionConflict("world state modificado; vuelve a sincronizar")

    async def observe(self, observation: Observation) -> None:
        body = json_literal(observation.model_dump(mode="json"))
        rows = await self.query(
            "INSERT INTO crisis_observations(observation_id, incident_id, body) VALUES "
            f"({literal(observation.observation_id)}, {literal(observation.incident_id)}, {body})"
            " ON CONFLICT (observation_id) DO UPDATE SET body = crisis_observations.body"
            f" WHERE crisis_observations.body = {body} RETURNING observation_id"
        )
        if not rows:
            raise StoreError("observation_id reutilizado con otro contenido")

    async def pending(self, incident_id: str, limit: int) -> list[ObservationRow]:
        rows = await self.query(
            "SELECT o.observation_id, o.body FROM crisis_observations o"
            f" WHERE o.incident_id = {literal(incident_id)} AND NOT EXISTS "
            "(SELECT 1 FROM crisis_receipts r WHERE r.observation_id = o.observation_id)"
            f" ORDER BY o.received_at, o.observation_id LIMIT {max(1, min(limit, 250))}"
        )
        return [ObservationRow.model_validate(row) for row in rows]

    async def receipts(self, incident_id: str) -> list[Receipt]:
        rows = await self.query(
            "SELECT observation_id, status, reason FROM crisis_receipts"
            f" WHERE incident_id = {literal(incident_id)} ORDER BY processed_at DESC LIMIT 250"
        )
        return [Receipt.model_validate(row) for row in rows]

    async def past_runs(self) -> list[dict[str, JsonValue]]:
        return await self.query(
            "SELECT incident_id AS id, version, snapshot->'incident'->>'name' AS scenario"
            " FROM crisis_world ORDER BY updated_at DESC LIMIT 50"
        )

    async def journal_for_run(
        self, run_id: str, kind: str | None = None
    ) -> list[dict[str, JsonValue]]:
        condition = f" AND kind = {literal(kind)}" if kind else ""
        return await self.query(
            "SELECT kind, body AS data FROM crisis_journal"
            f" WHERE incident_id = {literal(run_id)}{condition}"
            " ORDER BY body->>'ts' DESC, object_id LIMIT 250"
        )

    async def lessons_summary(self, limit: int = 20) -> list[dict[str, JsonValue]]:
        return await self.query(
            "SELECT body->>'summary' AS summary, body->'result' AS result FROM crisis_journal"
            " WHERE kind = 'action' AND body->>'status' IN ('completed', 'failed')"
            f" ORDER BY body->>'ts' DESC LIMIT {max(1, min(limit, 100))}"
        )

from __future__ import annotations

import psycopg
from psycopg.rows import dict_row
from psycopg.sql import SQL
from pydantic import JsonValue

from app.config import Settings
from app.store.persistence import StoreError
from app.store.twin import Table, TwinStore


class PostgresStore(TwinStore):
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
                    'name', c.column_name, 'type', c.data_type, 'isPrimary', false
                ) ORDER BY c.ordinal_position) AS columns
            FROM information_schema.tables t
            JOIN information_schema.columns c
                ON c.table_schema = t.table_schema AND c.table_name = t.table_name
            WHERE t.table_schema = current_schema()
            GROUP BY t.table_name, t.table_type
            ORDER BY t.table_name
        """)
        return [Table.model_validate(row) for row in rows]

    async def close(self) -> None:
        pass

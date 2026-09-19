"""Persistencia SQLite de eventos, decisiones y acciones.

El estado vivo está en memoria; aquí se guarda el histórico de todas las ejecuciones
para poder revisar qué funcionó (bonus "aprende de interacciones pasadas").
"""

from __future__ import annotations

import json
from typing import Any

import aiosqlite
from pydantic import BaseModel

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL, scenario TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL, kind TEXT NOT NULL, obj_id TEXT NOT NULL,
  ts TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS journal_kind ON journal(kind, obj_id);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL, ts TEXT NOT NULL, contact_id TEXT, role TEXT,
  action_kind TEXT NOT NULL, success INTEGER NOT NULL, detail TEXT NOT NULL
);
"""


class Store:
    def __init__(self, path: str) -> None:
        self.path = path
        self._db: aiosqlite.Connection | None = None
        self.run_id: str = ""

    async def open(self) -> None:
        self._db = await aiosqlite.connect(self.path)
        self._db.row_factory = aiosqlite.Row
        await self._db.executescript(SCHEMA)
        await self._db.commit()

    async def close(self) -> None:
        if self._db:
            await self._db.close()
            self._db = None

    @property
    def db(self) -> aiosqlite.Connection:
        if self._db is None:
            raise RuntimeError("store not open")
        return self._db

    async def start_run(self, run_id: str, started_at: str, scenario: str) -> None:
        self.run_id = run_id
        await self.db.execute(
            "INSERT OR REPLACE INTO runs(id, started_at, scenario) VALUES (?,?,?)",
            (run_id, started_at, scenario),
        )
        await self.db.commit()

    async def journal(self, kind: str, obj: BaseModel, ts: str) -> None:
        obj_id = str(getattr(obj, "id", ""))
        await self.db.execute(
            "INSERT INTO journal(run_id, kind, obj_id, ts, data) VALUES (?,?,?,?,?)",
            (self.run_id, kind, obj_id, ts, obj.model_dump_json()),
        )
        await self.db.commit()

    async def add_lesson(
        self,
        *,
        ts: str,
        action_kind: str,
        success: bool,
        detail: str,
        contact_id: str | None = None,
        role: str | None = None,
    ) -> None:
        await self.db.execute(
            "INSERT INTO lessons(run_id, ts, contact_id, role, action_kind, success, detail)"
            " VALUES (?,?,?,?,?,?,?)",
            (self.run_id, ts, contact_id, role, action_kind, int(success), detail),
        )
        await self.db.commit()

    async def contact_reliability(self) -> dict[str, float]:
        """Ratio de éxito por contacto en TODAS las ejecuciones (incluidas anteriores)."""
        cur = await self.db.execute(
            "SELECT contact_id, AVG(success) AS r, COUNT(*) AS n FROM lessons"
            " WHERE contact_id IS NOT NULL GROUP BY contact_id"
        )
        rows = await cur.fetchall()
        return {str(r["contact_id"]): float(r["r"]) for r in rows if int(r["n"]) > 0}

    async def lessons_summary(self, limit: int = 20) -> list[dict[str, Any]]:
        cur = await self.db.execute(
            "SELECT run_id, ts, contact_id, role, action_kind, success, detail FROM lessons"
            " WHERE run_id != ? ORDER BY id DESC LIMIT ?",
            (self.run_id, limit),
        )
        return [dict(r) for r in await cur.fetchall()]

    async def past_runs(self) -> list[dict[str, Any]]:
        cur = await self.db.execute(
            "SELECT r.id, r.started_at, r.scenario,"
            " (SELECT COUNT(*) FROM journal j WHERE j.run_id=r.id AND j.kind='decision')"
            " AS decisions,"
            " (SELECT COUNT(*) FROM journal j WHERE j.run_id=r.id AND j.kind='action') AS actions,"
            " (SELECT AVG(success) FROM lessons l WHERE l.run_id=r.id) AS success_rate"
            " FROM runs r ORDER BY started_at DESC LIMIT 50"
        )
        return [dict(r) for r in await cur.fetchall()]

    async def journal_for_run(self, run_id: str, kind: str | None = None) -> list[dict[str, Any]]:
        if kind:
            cur = await self.db.execute(
                "SELECT kind, ts, data FROM journal WHERE run_id=? AND kind=? ORDER BY seq",
                (run_id, kind),
            )
        else:
            cur = await self.db.execute(
                "SELECT kind, ts, data FROM journal WHERE run_id=? ORDER BY seq", (run_id,)
            )
        return [
            {"kind": r["kind"], "ts": r["ts"], "data": json.loads(r["data"])}
            for r in await cur.fetchall()
        ]


store: Store | None = None


def get_store() -> Store:
    if store is None:
        raise RuntimeError("store not initialised")
    return store

from __future__ import annotations

from abc import ABC, abstractmethod

from pydantic import JsonValue

from app.domain.models import Observation, ObservationRow, Receipt, WorldSnapshot


class StoreError(RuntimeError):
    pass


class VersionConflict(StoreError):
    pass


class ObservationConflict(StoreError):
    pass


class Store(ABC):
    @abstractmethod
    async def open(self) -> None: ...

    @abstractmethod
    async def close(self) -> None: ...

    @abstractmethod
    async def load(self, incident_id: str) -> WorldSnapshot | None: ...

    @abstractmethod
    async def create(self, snapshot: WorldSnapshot) -> WorldSnapshot: ...

    @abstractmethod
    async def save(
        self,
        snapshot: WorldSnapshot,
        expected_version: int,
        receipts: list[Receipt],
        *,
        require_synced: bool = False,
    ) -> None: ...

    @abstractmethod
    async def observe(self, observation: Observation) -> None: ...

    @abstractmethod
    async def pending(self, incident_id: str, limit: int) -> list[ObservationRow]: ...

    @abstractmethod
    async def receipts(self, incident_id: str) -> list[Receipt]: ...

    @abstractmethod
    async def past_runs(self) -> list[dict[str, JsonValue]]: ...

    @abstractmethod
    async def journal_for_run(
        self, run_id: str, kind: str | None = None
    ) -> list[dict[str, JsonValue]]: ...

    async def lessons_summary(self, limit: int = 20) -> list[dict[str, JsonValue]]:
        return []

    async def contact_reliability(self, incident_id: str) -> dict[str, float]:
        snapshot = await self.load(incident_id)
        return {c.id: c.reliability for c in snapshot.contacts} if snapshot else {}


class MemoryStore(Store):
    def __init__(self) -> None:
        self.worlds: dict[str, WorldSnapshot] = {}
        self.observations: dict[str, Observation] = {}
        self.processed: dict[str, Receipt] = {}

    async def open(self) -> None:
        pass

    async def close(self) -> None:
        pass

    async def load(self, incident_id: str) -> WorldSnapshot | None:
        snapshot = self.worlds.get(incident_id)
        return snapshot.model_copy(deep=True) if snapshot else None

    async def create(self, snapshot: WorldSnapshot) -> WorldSnapshot:
        self.worlds.setdefault(snapshot.incident.id, snapshot.model_copy(deep=True))
        return self.worlds[snapshot.incident.id].model_copy(deep=True)

    async def save(
        self,
        snapshot: WorldSnapshot,
        expected_version: int,
        receipts: list[Receipt],
        *,
        require_synced: bool = False,
    ) -> None:
        current = self.worlds.get(snapshot.incident.id)
        if current is None or current.version != expected_version:
            raise VersionConflict("world state modificado; vuelve a sincronizar")
        if require_synced and any(
            o.incident_id == snapshot.incident.id and oid not in self.processed
            for oid, o in self.observations.items()
        ):
            raise VersionConflict("observaciones nuevas; vuelve a sincronizar")
        if snapshot.version != expected_version + 1:
            raise StoreError("incremento de versión inválido")
        self.worlds[snapshot.incident.id] = snapshot.model_copy(deep=True)
        self.processed.update({r.observation_id: r.model_copy(deep=True) for r in receipts})

    async def observe(self, observation: Observation) -> None:
        existing = self.observations.get(observation.observation_id)
        if existing and existing != observation:
            raise ObservationConflict("observation_id reutilizado con otro contenido")
        self.observations[observation.observation_id] = observation.model_copy(deep=True)

    async def pending(self, incident_id: str, limit: int) -> list[ObservationRow]:
        return [
            ObservationRow(observation_id=o.observation_id, body=o.model_dump(mode="json"))
            for o in self.observations.values()
            if o.incident_id == incident_id and o.observation_id not in self.processed
        ][:limit]

    async def receipts(self, incident_id: str) -> list[Receipt]:
        return [
            r
            for oid, r in self.processed.items()
            if oid in self.observations and self.observations[oid].incident_id == incident_id
        ]

    async def past_runs(self) -> list[dict[str, JsonValue]]:
        return [
            {"id": s.incident.id, "scenario": s.incident.name, "version": s.version}
            for s in self.worlds.values()
        ]

    async def journal_for_run(
        self, run_id: str, kind: str | None = None
    ) -> list[dict[str, JsonValue]]:
        s = await self.load(run_id)
        if s is None:
            return []
        entries: list[dict[str, JsonValue]] = []
        for name, objects in (
            ("event", s.recent_events),
            ("decision", s.recent_decisions),
            ("action", s.recent_actions),
        ):
            if kind is None or kind == name:
                entries.extend(
                    {"kind": name, "data": obj.model_dump(mode="json")} for obj in objects
                )
        return entries

"""Estado global en memoria + bus de cambios para el SSE."""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import Iterable
from datetime import datetime
from typing import Any

from pydantic import BaseModel

from app.domain.models import (
    Action,
    AgentConfig,
    Contact,
    Decision,
    Event,
    FireFront,
    Incident,
    Resource,
    Road,
    Task,
    TaskStatus,
    Weather,
    WorldSnapshot,
    Zone,
    now,
)


class Change(BaseModel):
    type: str  # event | task | resource | zone | front | road | decision | action | agent | reset
    data: dict[str, Any]
    version: int = 0


class WorldState:
    def __init__(self) -> None:
        self.incident: Incident | None = None
        self.weather: Weather | None = None
        self.zones: dict[str, Zone] = {}
        self.fronts: dict[str, FireFront] = {}
        self.roads: dict[str, Road] = {}
        self.resources: dict[str, Resource] = {}
        self.contacts: dict[str, Contact] = {}
        self.tasks: dict[str, Task] = {}
        self.events: deque[Event] = deque(maxlen=2000)
        self.decisions: deque[Decision] = deque(maxlen=500)
        self.actions: dict[str, Action] = {}
        self.agent = AgentConfig()
        self.integrations: dict[str, bool] = {"happyrobot": True, "llm": True}
        self.version = 0
        self.last_synced_at: datetime | None = None
        self.field_clocks: dict[str, datetime] = {}
        self.event_facts: dict[str, list[str]] = {}
        self._subscribers: set[asyncio.Queue[Change]] = set()
        self.lock = asyncio.Lock()
        self.dirty = asyncio.Event()  # el orquestador se despierta cuando hay algo nuevo

    # ------------------------------------------------------------- pub/sub

    def subscribe(self) -> asyncio.Queue[Change]:
        q: asyncio.Queue[Change] = asyncio.Queue(maxsize=500)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[Change]) -> None:
        self._subscribers.discard(q)

    def _emit(self, type_: str, obj: BaseModel | dict[str, Any]) -> None:
        data = obj.model_dump(mode="json") if isinstance(obj, BaseModel) else obj
        change = Change(type=type_, data=data, version=self.version)
        for q in list(self._subscribers):
            try:
                q.put_nowait(change)
            except asyncio.QueueFull:
                q.get_nowait()
                q.put_nowait(Change(type="resync", data={}, version=self.version))

    # ------------------------------------------------------------- mutations

    def reset(self) -> None:
        subscribers = self._subscribers
        lock, dirty = self.lock, self.dirty
        self.__init__()  # type: ignore[misc]
        self._subscribers = subscribers
        self.lock, self.dirty = lock, dirty
        self._emit("reset", {})

    def restore(self, snapshot: WorldSnapshot, *, emit: bool = False) -> None:
        self.incident = snapshot.incident.model_copy(deep=True)
        self.weather = snapshot.weather.model_copy(deep=True)
        self.zones = {z.id: z.model_copy(deep=True) for z in snapshot.zones}
        self.fronts = {f.id: f.model_copy(deep=True) for f in snapshot.fronts}
        self.roads = {r.id: r.model_copy(deep=True) for r in snapshot.roads}
        self.resources = {r.id: r.model_copy(deep=True) for r in snapshot.resources}
        self.contacts = {c.id: c.model_copy(deep=True) for c in snapshot.contacts}
        self.tasks = {t.id: t.model_copy(deep=True) for t in snapshot.tasks}
        self.actions = {a.id: a.model_copy(deep=True) for a in snapshot.recent_actions}
        self.events = deque(reversed(snapshot.recent_events), maxlen=2000)
        self.decisions = deque(reversed(snapshot.recent_decisions), maxlen=500)
        self.agent = snapshot.agent.model_copy(deep=True)
        self.integrations = dict(snapshot.integrations)
        self.version = snapshot.version
        self.last_synced_at = snapshot.last_synced_at
        self.field_clocks = dict(snapshot.field_clocks)
        self.event_facts = {k: list(v) for k, v in snapshot.event_facts.items()}
        if emit:
            self._emit("snapshot", self.snapshot())

    def copy(self) -> WorldState:
        result = WorldState()
        result.restore(self.snapshot(full=True))
        return result

    def add_event(self, event: Event) -> Event:
        self.events.append(event)
        self.dirty.set()
        self._emit("event", event)
        return event

    def mark_event(self, event_id: str, relevant: bool, reason: str = "") -> None:
        for e in self.events:
            if e.id == event_id:
                e.relevant = relevant
                e.relevance_reason = reason
                e.processed = True
                self._emit("event", e)
                return

    def upsert_zone(self, zone: Zone) -> Zone:
        self.zones[zone.id] = zone
        self._emit("zone", zone)
        return zone

    def upsert_front(self, front: FireFront) -> FireFront:
        self.fronts[front.id] = front
        self._emit("front", front)
        return front

    def upsert_road(self, road: Road) -> Road:
        self.roads[road.id] = road
        self._emit("road", road)
        return road

    def upsert_resource(self, res: Resource) -> Resource:
        self.resources[res.id] = res
        self._emit("resource", res)
        return res

    def upsert_contact(self, contact: Contact) -> Contact:
        self.contacts[contact.id] = contact
        self._emit("contact", contact)
        return contact

    def upsert_task(self, task: Task) -> Task:
        task.updated_at = now()
        self.tasks[task.id] = task
        self._emit("task", task)
        return task

    def set_task_status(self, task_id: str, status: TaskStatus, outcome: str = "") -> Task:
        task = self.tasks[task_id]
        task.status = status
        if outcome:
            task.outcome = outcome
        return self.upsert_task(task)

    def add_decision(self, decision: Decision) -> Decision:
        self.decisions.append(decision)
        self._emit("decision", decision)
        return decision

    def upsert_action(self, action: Action) -> Action:
        self.actions[action.id] = action
        self._emit("action", action)
        return action

    def set_agent(self, agent: AgentConfig) -> AgentConfig:
        self.agent = agent
        self._emit("agent", agent)
        return agent

    def set_integration(self, name: str, up: bool) -> None:
        self.integrations[name] = up
        self._emit("integration", {"name": name, "up": up})

    # ------------------------------------------------------------- queries

    def unprocessed_events(self) -> list[Event]:
        return [e for e in self.events if not e.processed]

    def open_tasks(self) -> list[Task]:
        closed = {TaskStatus.done, TaskStatus.cancelled, TaskStatus.failed, TaskStatus.rejected}
        return sorted(
            (t for t in self.tasks.values() if t.status not in closed),
            key=lambda t: -t.priority,
        )

    def available_resources(self, types: Iterable[str] | None = None) -> list[Resource]:
        wanted = set(types) if types else None
        return [
            r
            for r in self.resources.values()
            if r.status == "available"
            and (wanted is None or r.type in wanted)
            and r.assigned_task_id is None
        ]

    def contact_for_resource(self, resource_id: str) -> Contact | None:
        return next((c for c in self.contacts.values() if c.resource_id == resource_id), None)

    def snapshot(self, recent: int = 50, *, full: bool = False) -> WorldSnapshot:
        if self.incident is None or self.weather is None:
            raise RuntimeError("scenario not seeded")
        actions = sorted(self.actions.values(), key=lambda a: a.ts, reverse=True)
        return WorldSnapshot(
            incident=self.incident,
            weather=self.weather,
            zones=list(self.zones.values()),
            fronts=list(self.fronts.values()),
            roads=list(self.roads.values()),
            resources=list(self.resources.values()),
            contacts=list(self.contacts.values()),
            tasks=sorted(self.tasks.values(), key=lambda t: -t.priority),
            recent_events=list(self.events)[::-1] if full else list(self.events)[-recent:][::-1],
            recent_decisions=list(self.decisions)[::-1]
            if full
            else list(self.decisions)[-10:][::-1],
            recent_actions=actions if full else actions[:recent],
            agent=self.agent,
            integrations=dict(self.integrations),
            version=self.version,
            last_synced_at=self.last_synced_at,
            field_clocks=self.field_clocks,
            event_facts=self.event_facts if full else {},
        )


state = WorldState()

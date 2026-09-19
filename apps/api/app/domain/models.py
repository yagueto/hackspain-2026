"""Modelo de dominio de la crisis.

Todo lo que el agente ve y toca vive aquí. Los modelos son pydantic para poder
serializarlos tal cual al dashboard y al LLM.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


def now() -> datetime:
    return datetime.now(UTC)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


# --------------------------------------------------------------------------- enums


class Severity(StrEnum):
    low = "low"
    medium = "medium"
    high = "high"
    critical = "critical"


class EventSource(StrEnum):
    sensor = "sensor"
    call_112 = "call_112"
    field_report = "field_report"
    weather = "weather"
    happyrobot = "happyrobot"
    simulator = "simulator"
    operator = "operator"
    system = "system"


class EventKind(StrEnum):
    fire_spread = "fire_spread"
    wind_change = "wind_change"
    road_blocked = "road_blocked"
    road_open = "road_open"
    civilians_reported = "civilians_reported"
    injured_reported = "injured_reported"
    resource_status = "resource_status"
    call_outcome = "call_outcome"
    message_outcome = "message_outcome"
    integration_down = "integration_down"
    integration_up = "integration_up"
    note = "note"


class ResourceType(StrEnum):
    fire_engine = "fire_engine"
    ambulance = "ambulance"
    police_unit = "police_unit"
    helicopter = "helicopter"
    bulldozer = "bulldozer"
    evacuation_bus = "evacuation_bus"


class ResourceStatus(StrEnum):
    available = "available"
    dispatched = "dispatched"
    on_scene = "on_scene"
    returning = "returning"
    out_of_service = "out_of_service"


class TaskStatus(StrEnum):
    proposed = "proposed"
    awaiting_approval = "awaiting_approval"
    dispatching = "dispatching"
    dispatched = "dispatched"
    accepted = "accepted"
    rejected = "rejected"
    in_progress = "in_progress"
    done = "done"
    cancelled = "cancelled"
    failed = "failed"


class TaskKind(StrEnum):
    dispatch_resource = "dispatch_resource"
    evacuate_zone = "evacuate_zone"
    warn_civilian = "warn_civilian"
    close_road = "close_road"
    open_shelter = "open_shelter"
    brief_authority = "brief_authority"
    medical_triage = "medical_triage"
    other = "other"


class ContactRole(StrEnum):
    firefighter = "firefighter"
    ambulance = "ambulance"
    police = "police"
    civil_protection = "civil_protection"
    mayor = "mayor"
    civilian = "civilian"
    shelter = "shelter"


class ActionKind(StrEnum):
    call = "call"
    sms = "sms"
    signal = "signal"
    assign = "assign"
    internal = "internal"


class ActionStatus(StrEnum):
    pending = "pending"
    dispatched = "dispatched"
    completed = "completed"
    failed = "failed"
    skipped = "skipped"


class AgentMode(StrEnum):
    running = "running"
    paused = "paused"


# ------------------------------------------------------------------------ entities


class Location(BaseModel):
    lat: float
    lng: float
    label: str = ""


class Zone(BaseModel):
    """Zona geográfica relevante: un pueblo, una urbanización, un sector del monte."""

    id: str = Field(default_factory=lambda: new_id("zone"))
    name: str
    location: Location
    population: int = 0
    threat: Severity = Severity.low
    evacuation_status: str = "none"  # none | advised | ordered | in_progress | completed
    civilians_present: int = 0
    injured: int = 0
    shelter_capacity: int = 0
    notes: list[str] = Field(default_factory=list)


class FireFront(BaseModel):
    id: str = Field(default_factory=lambda: new_id("front"))
    name: str
    location: Location
    heading_deg: float
    speed_kmh: float
    intensity: Severity = Severity.medium
    contained_pct: float = 0.0
    threatens_zone_ids: list[str] = Field(default_factory=list)
    eta_minutes_to_zone: dict[str, float] = Field(default_factory=dict)


class Road(BaseModel):
    id: str = Field(default_factory=lambda: new_id("road"))
    name: str
    connects: list[str]  # zone ids
    open: bool = True
    reason: str = ""


class Resource(BaseModel):
    id: str = Field(default_factory=lambda: new_id("res"))
    name: str
    type: ResourceType
    status: ResourceStatus = ResourceStatus.available
    location: Location
    capacity: int = 0
    assigned_task_id: str | None = None
    assigned_zone_id: str | None = None
    contact_id: str | None = None
    eta_minutes: float | None = None
    notes: list[str] = Field(default_factory=list)


class Contact(BaseModel):
    id: str = Field(default_factory=lambda: new_id("ct"))
    name: str
    role: ContactRole
    phone: str
    zone_id: str | None = None
    resource_id: str | None = None
    language: str = "es"
    happyrobot_contact_id: str | None = None
    last_contacted_at: datetime | None = None
    reliability: float = 1.0  # 0..1, aprendido de interacciones pasadas


class Weather(BaseModel):
    wind_from_deg: float
    wind_kmh: float
    temperature_c: float
    humidity_pct: float
    forecast: str = ""


class Event(BaseModel):
    id: str = Field(default_factory=lambda: new_id("evt"))
    ts: datetime = Field(default_factory=now)
    source: EventSource
    kind: EventKind
    severity: Severity = Severity.medium
    title: str
    payload: dict[str, Any] = Field(default_factory=dict)
    zone_id: str | None = None
    relevant: bool | None = None  # decidido por el agente
    relevance_reason: str = ""
    processed: bool = False


class Action(BaseModel):
    """Una interacción concreta con el mundo exterior (HappyRobot, asignación, ...)."""

    id: str = Field(default_factory=lambda: new_id("act"))
    ts: datetime = Field(default_factory=now)
    kind: ActionKind
    status: ActionStatus = ActionStatus.pending
    task_id: str | None = None
    contact_id: str | None = None
    summary: str
    request: dict[str, Any] = Field(default_factory=dict)
    result: dict[str, Any] = Field(default_factory=dict)
    happyrobot_run_id: str | None = None
    error: str = ""


class Task(BaseModel):
    id: str = Field(default_factory=lambda: new_id("task"))
    created_at: datetime = Field(default_factory=now)
    updated_at: datetime = Field(default_factory=now)
    kind: TaskKind
    title: str
    description: str = ""
    priority: int = 50  # 0..100, más alto = más urgente
    priority_reason: str = ""
    status: TaskStatus = TaskStatus.proposed
    zone_id: str | None = None
    resource_ids: list[str] = Field(default_factory=list)
    assignee_contact_id: str | None = None
    requires_approval: bool = False
    action_ids: list[str] = Field(default_factory=list)
    decision_id: str | None = None
    outcome: str = ""


class Decision(BaseModel):
    """Una vuelta del orquestador: qué vio, qué decidió y por qué."""

    id: str = Field(default_factory=lambda: new_id("dec"))
    ts: datetime = Field(default_factory=now)
    trigger: str
    situation_summary: str
    priorities: list[str]
    actions_taken: list[str]
    discarded_events: list[str] = Field(default_factory=list)
    replan: bool = False
    replan_reason: str = ""
    model: str = "heuristic"
    raw: dict[str, Any] = Field(default_factory=dict)


class Incident(BaseModel):
    id: str = Field(default_factory=lambda: new_id("inc"))
    name: str
    kind: str = "wildfire"
    started_at: datetime = Field(default_factory=now)
    status: str = "active"
    command_post: Location
    summary: str = ""


class AgentConfig(BaseModel):
    mode: AgentMode = AgentMode.running
    approval_required_for: list[TaskKind] = Field(default_factory=lambda: [TaskKind.evacuate_zone])
    tick_seconds: float = 10.0


class WorldSnapshot(BaseModel):
    """Lo que el dashboard pinta y lo que el LLM recibe como contexto."""

    incident: Incident
    weather: Weather
    zones: list[Zone]
    fronts: list[FireFront]
    roads: list[Road]
    resources: list[Resource]
    contacts: list[Contact]
    tasks: list[Task]
    recent_events: list[Event]
    recent_decisions: list[Decision]
    recent_actions: list[Action]
    agent: AgentConfig
    integrations: dict[str, bool]
    generated_at: datetime = Field(default_factory=now)

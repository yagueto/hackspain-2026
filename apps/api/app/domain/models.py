"""Modelo de dominio de la crisis.

Todo lo que el agente ve y toca vive aquí. Los modelos son pydantic para poder
serializarlos tal cual al dashboard y al LLM.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel


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
    incoming_call = "incoming_call"
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
    reserved = "reserved"
    en_route = "en_route"
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
    telegram = "telegram"
    signal = "signal"
    assign = "assign"
    internal = "internal"


class ActionStatus(StrEnum):
    pending = "pending"
    sending = "sending"
    unknown = "unknown"
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
    reported_status: ResourceStatus | None = None
    reported_at: datetime | None = None
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
    attempts: int = 0
    next_attempt_at: datetime | None = None
    state_version: int = 0
    workflow: str | None = None
    decision_id: str | None = None
    expires_at: datetime | None = None
    hold_until: datetime | None = None


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
    resource_types: list[ResourceType] = Field(default_factory=list)
    contact_roles: list[ContactRole] = Field(default_factory=list)
    preferred_resource_id: str | None = None
    approved_at: datetime | None = None
    cancellation_requested: bool = False
    incoming_call_id: str | None = None
    incoming_call_timestamp: datetime | None = None
    target_location: Location | None = None
    autonomous: bool = False  # la decidió el agente, no un operador
    hold_until: datetime | None = None  # margen para anular antes de enviar
    blocked_reason: str = ""  # por qué no puede despacharse todavía
    escalated_at: datetime | None = None


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
    """Frontera entre lo que el agente decide solo y lo que somete a un humano.

    Todo es autónomo salvo lo crítico: las evacuaciones masivas y los avisos cuya
    severidad figura en `approval_required_severities`. Lo autónomo se retiene
    `hold_seconds` antes de enviarse para que el operador pueda anularlo.
    """

    mode: AgentMode = AgentMode.running
    autonomous: bool = True
    approval_required_for: list[TaskKind] = Field(default_factory=lambda: [TaskKind.evacuate_zone])
    approval_required_severities: list[str] = Field(default_factory=lambda: ["vital"])
    tick_seconds: float = 10.0
    hold_seconds: float = Field(default=10.0, ge=0)
    escalate_after_seconds: float = Field(default=30.0, ge=0)


class IntakeFields(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, str_strip_whitespace=True)

    @field_validator("*", mode="before")
    @classmethod
    def normalize_unknown(cls, value: object) -> object:
        if isinstance(value, str) and value.strip().lower() in ("", "null", "none"):
            return None
        return value


class ReportedLocation(IntakeFields):
    raw_text: str | None = Field(default=None, max_length=2000)
    street: str | None = None
    number: str | None = None
    floor_door: str | None = None
    city: str | None = None
    road: str | None = None
    kilometer: str | None = None
    direction: str | None = None
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    confirmed: bool = False
    # Ya no condiciona la búsqueda: el agente localiza cualquier aviso sin GPS. Se conserva
    # porque el workflow de intake lo sigue enviando y borrarlo rompería sus referencias.
    public_search_allowed: bool = False
    accuracy_m: float | None = Field(default=None, gt=0)

    @field_validator("lat", "lng", "accuracy_m", mode="before")
    @classmethod
    def reject_boolean_coordinate(cls, value: object) -> object:
        if isinstance(value, bool):
            raise ValueError("una coordenada/precisión debe ser numérica, no booleana")
        return value

    @model_validator(mode="after")
    def coordinate_pair(self) -> ReportedLocation:
        if (self.lat is None) != (self.lng is None):
            raise ValueError("lat y lng deben proporcionarse juntas")
        return self


class ReportedVictims(IntakeFields):
    count: int | None = Field(default=None, ge=0)
    conscious: bool | None = None
    breathing: bool | None = None
    trapped: bool | None = None
    minors_involved: bool | None = None


class Caller(IntakeFields):
    name: str | None = None
    phone: str | None = None
    is_victim: bool | None = None


class GeocodedPlace(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    lat: float = Field(ge=-90, le=90, strict=True)
    lng: float = Field(ge=-180, le=180, strict=True)
    label: str = Field(min_length=1, max_length=2000)
    kind: str = ""


class LocationResolution(BaseModel):
    status: Literal[
        "not_requested", "resolved", "ambiguous", "not_found", "unavailable", "confirmed"
    ] = "not_requested"
    candidates: list[GeocodedPlace] = Field(default_factory=list)
    selected: GeocodedPlace | None = None
    provider: Literal["nominatim", "operator"] = "nominatim"
    error: str = ""


class IncomingCallIn(IntakeFields):
    run_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_:-]+$")
    timestamp: AwareDatetime
    emergency_type: Literal[
        "sanitaria", "incendio", "seguridad", "trafico", "rescate", "otra", "desconocida"
    ]
    severity: Literal["vital", "grave", "moderada", "leve", "no_emergencia"]
    escalation_required: bool = True
    location: ReportedLocation = Field(default_factory=ReportedLocation)
    victims: ReportedVictims = Field(default_factory=ReportedVictims)
    caller: Caller = Field(default_factory=Caller)
    active_hazards: str | None = None
    notes: str | None = Field(default=None, max_length=10000)


class IncomingCall(IncomingCallIn):
    resolution: LocationResolution = Field(default_factory=LocationResolution)


class CoordinationFields(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        allow_inf_nan=False,
        str_strip_whitespace=True,
        populate_by_name=True,
        alias_generator=to_camel,
        serialize_by_alias=True,
    )


class CoordinationAction(CoordinationFields):
    type: Literal["none", "note", "set-status", "assign-resource"] = "none"
    task_id: str | None = None
    status: Literal["done", "cancelled"] | None = None
    expected_status: TaskStatus | None = None
    expected_updated_at: AwareDatetime | None = None
    resource_id: str | None = None
    expected_incident_id: str | None = None

    @model_validator(mode="after")
    def require_target(self) -> CoordinationAction:
        if self.type in ("set-status", "assign-resource") and (
            not self.task_id or not self.expected_status or not self.expected_updated_at
        ):
            raise ValueError("la acción requiere tarea y versión esperada")
        if self.type == "set-status" and not self.status:
            raise ValueError("falta el estado de destino")
        if self.type == "assign-resource" and not self.resource_id:
            raise ValueError("falta el recurso")
        return self


class CoordinationAnswer(CoordinationFields):
    option_ids: list[str] = Field(default_factory=list, max_length=12)
    text: str = Field(default="", max_length=1000)
    custom: bool = False


class CoordinationOption(CoordinationFields):
    id: str = Field(min_length=1, max_length=100)
    label: str = Field(min_length=1, max_length=200)
    action: CoordinationAction = Field(default_factory=CoordinationAction)


class CoordinationQuestionIn(CoordinationFields):
    id: str = Field(
        default_factory=lambda: new_id("question"),
        min_length=1,
        max_length=100,
        pattern=r"^[A-Za-z0-9_:-]+$",
    )
    incident_id: str = Field(min_length=1, max_length=160)
    prompt: str = Field(min_length=1, max_length=2000)
    urgency: Literal["critical", "high", "moderate"] = "moderate"
    input: Literal["text", "options", "mixed"] = "options"
    options: list[CoordinationOption] = Field(default_factory=list, max_length=12)
    multiple: bool = False
    text_action: CoordinationAction = Field(default_factory=lambda: CoordinationAction(type="note"))
    default_answer: CoordinationAnswer
    expires_at: AwareDatetime | None = None
    timeout_seconds: float | None = Field(default=None, gt=0, le=86400)

    def accepts(self, answer: CoordinationAnswer) -> bool:
        if answer.custom:
            return self.input != "options" and not answer.option_ids and bool(answer.text)
        return (
            self.input != "text"
            and not answer.text
            and bool(answer.option_ids)
            and (self.multiple or len(answer.option_ids) == 1)
            and len(set(answer.option_ids)) == len(answer.option_ids)
            and set(answer.option_ids) <= {option.id for option in self.options}
        )

    def actions_for(self, answer: CoordinationAnswer) -> list[CoordinationAction]:
        return (
            [self.text_action]
            if answer.custom
            else [option.action for option in self.options if option.id in answer.option_ids]
        )

    @model_validator(mode="after")
    def validate_question(self) -> CoordinationQuestionIn:
        if self.id in ("__proto__", "constructor", "prototype"):
            raise ValueError("identificador reservado")
        if len({option.id for option in self.options}) != len(self.options):
            raise ValueError("opciones duplicadas")
        if self.input != "text" and not self.options:
            raise ValueError("faltan opciones")
        if not self.accepts(self.default_answer):
            raise ValueError("respuesta por defecto inválida")
        if any(
            action.type not in ("none", "note") for action in self.actions_for(self.default_answer)
        ):
            raise ValueError("un vencimiento no puede confirmar, cancelar ni movilizar recursos")
        return self


class CoordinationResolution(CoordinationFields):
    question_id: str
    incident_id: str
    idempotency_key: str
    answer: CoordinationAnswer
    answer_label: str
    source: Literal["human", "timeout"]
    answered_at: AwareDatetime = Field(default_factory=now)
    outcome: str
    applied: bool


class CoordinationQuestion(CoordinationQuestionIn):
    received_at: AwareDatetime = Field(default_factory=now)
    expires_at: AwareDatetime = Field(default_factory=now)
    sequence: int
    status: Literal["pending", "resolved"] = "pending"
    resolution: CoordinationResolution | None = None
    request_hash: str = ""


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
    incoming_calls: list[IncomingCall] = Field(default_factory=list)
    coordination_questions: list[CoordinationQuestion] = Field(default_factory=list)
    agent: AgentConfig
    integrations: dict[str, bool]
    generated_at: datetime = Field(default_factory=now)
    version: int = 0
    last_synced_at: datetime | None = None
    field_clocks: dict[str, datetime] = Field(default_factory=dict)
    event_facts: dict[str, list[str]] = Field(default_factory=dict)


class Observation(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    observation_id: str = Field(default_factory=lambda: new_id("obs"))
    schema_version: Literal[1] = 1
    incident_id: str
    kind: EventKind
    entity_id: str | None = None
    zone_id: str | None = None
    observed_at: AwareDatetime = Field(default_factory=now)
    source: EventSource = EventSource.happyrobot
    source_run_id: str | None = None
    command_id: str | None = None
    title: str
    severity: Severity = Severity.medium
    payload: dict[str, JsonValue] = Field(default_factory=dict)

    def event(self) -> Event:
        return Event(
            id=self.observation_id,
            ts=self.observed_at,
            source=self.source,
            kind=self.kind,
            title=self.title,
            severity=self.severity,
            zone_id=self.zone_id,
            payload={
                **self.payload,
                "command_id": self.command_id,
                "source_run_id": self.source_run_id,
            },
        )


class ObservationRow(BaseModel):
    observation_id: str
    body: JsonValue


class Receipt(BaseModel):
    observation_id: str
    status: Literal["applied", "ignored", "invalid"]
    reason: str = ""


class CallOutcome(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    observation_id: str | None = None
    observed_at: AwareDatetime | None = None
    task_id: str | None = None
    action_id: str | None = None
    command_id: str | None = None
    run_id: str | None = None
    session_id: str | None = None
    contact_id: str | None = None
    phone: str | None = None
    outcome: Literal["accepted", "rejected", "no_answer", "voicemail", "busy", "failed", "info"] = (
        "info"
    )
    eta_minutes: float | None = Field(default=None, ge=0)
    injured_count: int | None = Field(default=None, ge=0)
    civilians_count: int | None = Field(default=None, ge=0)
    road_blocked: str | None = None
    needs_medical: bool | None = None
    evacuation_confirmed: bool | None = None
    shelter_capacity: int | None = Field(default=None, ge=0)
    resource_status: ResourceStatus | None = None
    summary: str = ""
    transcript: str = ""
    extra: dict[str, JsonValue] = Field(default_factory=dict)

    @field_validator(
        "observation_id",
        "task_id",
        "action_id",
        "command_id",
        "run_id",
        "session_id",
        "contact_id",
        "phone",
        "eta_minutes",
        "injured_count",
        "civilians_count",
        "road_blocked",
        "needs_medical",
        "evacuation_confirmed",
        "shelter_capacity",
        "resource_status",
        mode="before",
    )
    @classmethod
    def _blank_to_none(cls, v: object) -> object:
        if isinstance(v, str) and not v.strip():
            return None
        return v

from datetime import timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.domain.apply import apply_event
from app.domain.models import (
    Action,
    ActionKind,
    ActionStatus,
    CallOutcome,
    EventKind,
    Observation,
    Receipt,
    ResourceStatus,
    Severity,
    TaskStatus,
    now,
)
from app.domain.state import WorldState


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class FirePayload(Payload):
    front_id: str
    heading_deg: float | None = Field(default=None, ge=0, le=360)
    speed_kmh: float | None = Field(default=None, ge=0)
    intensity: Severity | None = None
    contained_pct: float | None = Field(default=None, ge=0, le=100)
    threatens: dict[str, float] | None = None


class WindPayload(Payload):
    wind_from_deg: float = Field(ge=0, le=360)
    wind_kmh: float = Field(ge=0)


class RoadPayload(Payload):
    road_id: str
    reason: str = ""


class CountPayload(Payload):
    count: int = Field(ge=0)
    zone_id: str | None = None


class ResourcePayload(Payload):
    resource_id: str
    status: ResourceStatus
    eta_minutes: float | None = Field(default=None, ge=0)
    task_id: str | None = None


class IntegrationPayload(Payload):
    name: Literal["happyrobot", "llm"]


PAYLOADS: dict[EventKind, type[BaseModel]] = {
    EventKind.fire_spread: FirePayload,
    EventKind.wind_change: WindPayload,
    EventKind.road_blocked: RoadPayload,
    EventKind.road_open: RoadPayload,
    EventKind.civilians_reported: CountPayload,
    EventKind.injured_reported: CountPayload,
    EventKind.resource_status: ResourcePayload,
    EventKind.integration_down: IntegrationPayload,
    EventKind.integration_up: IntegrationPayload,
    EventKind.call_outcome: CallOutcome,
    EventKind.message_outcome: CallOutcome,
}


def resolve_action(state: WorldState, body: CallOutcome) -> Action:
    if body.command_id and body.action_id and body.command_id != body.action_id:
        raise ValueError("command_id y action_id no coinciden")
    action_id = body.command_id or body.action_id
    action = state.actions.get(action_id or "")
    if action is None and body.run_id and not action_id:
        action = next(
            (a for a in state.actions.values() if a.happyrobot_run_id == body.run_id), None
        )
    if action is None and body.task_id and not action_id and not body.run_id:
        candidates = [
            a
            for a in state.actions.values()
            if a.task_id == body.task_id and a.kind in ("call", "sms")
        ]
        action = candidates[0] if len(candidates) == 1 else None
    if action is None:
        raise ValueError("orden desconocida o correlación ambigua")
    if body.task_id and action.task_id != body.task_id:
        raise ValueError("task_id no coincide con la orden")
    if body.run_id and action.happyrobot_run_id not in (None, body.run_id):
        raise ValueError("run_id no coincide con la orden")
    if body.contact_id and action.contact_id != body.contact_id:
        raise ValueError("contact_id no coincide con la orden")
    if action.status in (ActionStatus.pending, ActionStatus.skipped):
        raise ValueError("resultado de una orden que no se ha enviado")
    return action


def outcome(state: WorldState, obs: Observation) -> list[str]:
    body = CallOutcome.model_validate(
        {
            **obs.payload,
            "command_id": obs.command_id or obs.payload.get("command_id"),
            "run_id": obs.source_run_id or obs.payload.get("run_id"),
        }
    )
    action = resolve_action(state, body)
    task = state.tasks.get(action.task_id or "")
    success = body.outcome in ("accepted", "info")
    terminal = action.status in (ActionStatus.completed, ActionStatus.failed)
    if terminal and (action.status == ActionStatus.failed or body.outcome != "info"):
        return []
    action.status = ActionStatus.completed if success else ActionStatus.failed
    action.happyrobot_run_id = action.happyrobot_run_id or body.run_id
    action.result["webhook"] = body.model_dump(mode="json")
    contact = state.contacts.get(action.contact_id or "")
    if contact and not terminal and action.kind == ActionKind.call:
        # La entrega de un aviso escrito no dice nada de si la persona responde: solo las
        # llamadas mueven la fiabilidad, que a su vez pondera la selección de medios.
        contact.reliability = round(0.7 * contact.reliability + 0.3 * int(success), 3)
    if task:
        if task.status not in (TaskStatus.done, TaskStatus.cancelled):
            if body.outcome == "accepted":
                task.status = TaskStatus.accepted
            elif not success:
                task.status = TaskStatus.failed
            task.outcome = body.summary or body.outcome
        for rid in task.resource_ids:
            resource = state.resources[rid]
            if resource.assigned_task_id != task.id:
                continue
            resource_clock = state.field_clocks.get(f"resource:{rid}")
            if resource_clock and resource_clock > obs.observed_at:
                continue
            if body.outcome == "accepted" and resource.status == ResourceStatus.reserved:
                resource.status = ResourceStatus.en_route
            if body.eta_minutes is not None:
                resource.eta_minutes = body.eta_minutes
            if body.outcome == "rejected" and resource.status == ResourceStatus.reserved:
                resource.status = ResourceStatus.available
                resource.assigned_task_id = None
                resource.assigned_zone_id = None
            if body.resource_status is None:
                state.field_clocks[f"resource:{rid}"] = obs.observed_at
    zone_id = task.zone_id if task else contact.zone_id if contact else None
    zone = state.zones.get(zone_id or "")
    facts = [obs.title]
    if zone:
        if body.evacuation_confirmed:
            zone.evacuation_status = "in_progress"
        if body.shelter_capacity is not None:
            zone.shelter_capacity = body.shelter_capacity
    derived: list[Observation] = []
    for kind, count in (
        (EventKind.injured_reported, body.injured_count),
        (EventKind.civilians_reported, body.civilians_count),
    ):
        if count is not None and not zone:
            event = obs.event()
            event.id = f"{obs.observation_id}:{kind}"
            event.kind = kind
            event.payload = {"count": count, "location_unconfirmed": True}
            event.zone_id = None
            state.add_event(event)
            state.event_facts[event.id] = [f"{count} personas: ubicación pendiente de confirmar"]
        elif count is not None and zone:
            derived.append(
                obs.model_copy(
                    update={
                        "observation_id": f"{obs.observation_id}:{kind}",
                        "kind": kind,
                        "zone_id": zone.id,
                        "payload": {"count": count},
                    }
                )
            )
    if body.road_blocked:
        road_id = body.road_blocked
        if road_id not in state.roads:
            name = road_id.strip().lower()
            matches = [r for r in state.roads.values() if r.name.lower() == name]
            if not matches:
                matches = [r for r in state.roads.values() if name and name in r.name.lower()]
            if len(matches) != 1:
                raise ValueError("road_blocked debe ser un id o nombre de carretera conocido")
            road_id = matches[0].id
        derived.append(
            obs.model_copy(
                update={
                    "observation_id": f"{obs.observation_id}:road",
                    "kind": EventKind.road_blocked,
                    "payload": {"road_id": road_id, "reason": body.summary},
                }
            )
        )
    if task and body.resource_status:
        for rid in task.resource_ids:
            derived.append(
                obs.model_copy(
                    update={
                        "observation_id": f"{obs.observation_id}:{rid}",
                        "kind": EventKind.resource_status,
                        "payload": {
                            "resource_id": rid,
                            "status": body.resource_status,
                            "task_id": task.id,
                        },
                    }
                )
            )
    for child in derived:
        receipt = apply_observation(state, child)
        if receipt.status == "applied":
            facts.extend(state.event_facts[child.observation_id])
    return facts


def apply_observation(state: WorldState, obs: Observation) -> Receipt:
    if state.incident is None or obs.incident_id != state.incident.id:
        raise ValueError("incident_id desconocido")
    if obs.observed_at > now() + timedelta(minutes=5):
        raise ValueError("observed_at está en el futuro")
    validator = PAYLOADS.get(obs.kind)
    if validator:
        obs = obs.model_copy(
            update={
                "payload": validator.model_validate(obs.payload).model_dump(
                    mode="json", exclude_none=True
                )
            }
        )
    event = obs.event()
    p = event.payload
    key = f"{obs.kind}:{obs.zone_id or obs.entity_id or ''}"
    if obs.kind == EventKind.fire_spread:
        entity = str(p["front_id"])
        if entity not in state.fronts:
            raise ValueError("front_id desconocido")
        for zid, eta in p.get("threatens", {}).items():
            if zid not in state.zones or eta < 0:
                raise ValueError("zona/ETA de frente inválida")
        key = f"front:{entity}"
    elif obs.kind in (EventKind.road_blocked, EventKind.road_open):
        entity = str(p["road_id"])
        if entity not in state.roads:
            raise ValueError("road_id desconocido")
        key = f"road:{entity}"
    elif obs.kind == EventKind.resource_status:
        entity = str(p["resource_id"])
        if entity not in state.resources:
            raise ValueError("resource_id desconocido")
        resource = state.resources[entity]
        if p["status"] == ResourceStatus.reserved:
            raise ValueError("las reservas solo las crea el orquestador")
        if p.get("task_id") and resource.assigned_task_id != p["task_id"]:
            return Receipt(
                observation_id=obs.observation_id, status="ignored", reason="informe de otra misión"
            )
        key = f"resource:{entity}"
    elif obs.kind in (EventKind.injured_reported, EventKind.civilians_reported):
        entity = obs.zone_id or str(p.get("zone_id", ""))
        if entity not in state.zones:
            raise ValueError("zone_id desconocido")
        key = f"{obs.kind}:{entity}"
    elif obs.kind in (EventKind.integration_down, EventKind.integration_up):
        key = f"integration:{p['name']}"
    elif obs.kind in (EventKind.call_outcome, EventKind.message_outcome):
        body = CallOutcome.model_validate(
            {
                **obs.payload,
                "command_id": obs.command_id or p.get("command_id"),
                "run_id": obs.source_run_id or p.get("run_id"),
            }
        )
        key = f"outcome:{resolve_action(state, body).id}"
    elif obs.kind != EventKind.note and obs.kind != EventKind.wind_change:
        raise ValueError("tipo de observación no soportado")

    if obs.kind != EventKind.note and obs.observed_at <= state.field_clocks.get(
        key, obs.observed_at - timedelta(seconds=1)
    ):
        return Receipt(observation_id=obs.observation_id, status="ignored", reason="dato atrasado")
    if obs.kind in (EventKind.call_outcome, EventKind.message_outcome):
        facts = outcome(state, obs)
    else:
        protected = {
            fid: front.model_copy(deep=True)
            for fid, front in state.fronts.items()
            if obs.kind == EventKind.wind_change
            and state.field_clocks.get(f"front:{fid}", obs.observed_at) > obs.observed_at
        }
        facts = apply_event(state, event)
        if obs.kind == EventKind.wind_change:
            state.fronts.update(protected)
            for fid in state.fronts:
                if fid not in protected:
                    state.field_clocks[f"front:{fid}"] = obs.observed_at
    if obs.kind != EventKind.note:
        state.field_clocks[key] = obs.observed_at
    state.event_facts[event.id] = facts
    state.add_event(event)
    return Receipt(observation_id=obs.observation_id, status="applied")

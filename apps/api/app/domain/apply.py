"""Aplica un evento entrante al estado del mundo (percepción)."""

from __future__ import annotations

from app.domain.models import Event, EventKind, Location, ResourceStatus, Severity, TaskStatus
from app.domain.movement import clear_travel
from app.domain.state import WorldState

_SEV_ORDER = [Severity.low, Severity.medium, Severity.high, Severity.critical]


def bump(sev: Severity, steps: int = 1) -> Severity:
    i = min(len(_SEV_ORDER) - 1, max(0, _SEV_ORDER.index(sev) + steps))
    return _SEV_ORDER[i]


def apply_event(state: WorldState, e: Event) -> list[str]:
    """Muta el estado y devuelve una lista de "hechos" (strings) que cambiaron.

    Si la lista está vacía el evento no aportó nada nuevo (ruido).
    """
    p = e.payload
    facts: list[str] = []

    if e.kind == EventKind.fire_spread:
        front = state.fronts.get(str(p.get("front_id", "")))
        if front:
            if "heading_deg" in p:
                front.heading_deg = float(p["heading_deg"])
            if "speed_kmh" in p:
                front.speed_kmh = float(p["speed_kmh"])
            if "intensity" in p:
                front.intensity = Severity(p["intensity"])
            if "contained_pct" in p:
                front.contained_pct = float(p["contained_pct"])
            if "threatens" in p:
                front.threatens_zone_ids = list(p["threatens"].keys())
                front.eta_minutes_to_zone = {k: float(v) for k, v in p["threatens"].items()}
                for zid, eta in front.eta_minutes_to_zone.items():
                    z = state.zones.get(zid)
                    if z:
                        new = (
                            Severity.critical
                            if eta <= 30
                            else Severity.high
                            if eta <= 90
                            else Severity.medium
                        )
                        if _SEV_ORDER.index(new) > _SEV_ORDER.index(z.threat):
                            z.threat = new
                            state.upsert_zone(z)
                            facts.append(f"{z.name} pasa a amenaza {new} (ETA {eta:.0f} min)")
            state.upsert_front(front)
            facts.append(f"{front.name}: rumbo {front.heading_deg:.0f}°, {front.speed_kmh} km/h")

    elif e.kind == EventKind.wind_change and state.weather:
        w = state.weather
        w.wind_from_deg = float(p.get("wind_from_deg", w.wind_from_deg))
        w.wind_kmh = float(p.get("wind_kmh", w.wind_kmh))
        facts.append(f"Viento ahora de {w.wind_from_deg:.0f}° a {w.wind_kmh:.0f} km/h")
        for front in state.fronts.values():
            front.heading_deg = (w.wind_from_deg + 180) % 360
            if w.wind_kmh >= 35:
                front.speed_kmh = round(front.speed_kmh * 1.5, 2)
                front.intensity = bump(front.intensity)
            state.upsert_front(front)

    elif e.kind in (EventKind.road_blocked, EventKind.road_open):
        road = state.roads.get(str(p.get("road_id", "")))
        if road:
            was_open = road.open
            road.open = e.kind == EventKind.road_open
            road.reason = str(p.get("reason", ""))
            state.upsert_road(road)
            if was_open != road.open:
                facts.append(
                    f"{road.name} {'cortada' if not road.open else 'reabierta'}: {road.reason}"
                )

    elif e.kind == EventKind.civilians_reported:
        z = state.zones.get(str(e.zone_id or p.get("zone_id", "")))
        if z:
            count = int(p.get("count", 0))
            if count != z.civilians_present:
                z.civilians_present = count
                state.upsert_zone(z)
                facts.append(f"{z.name}: {count} personas presentes")

    elif e.kind == EventKind.injured_reported:
        z = state.zones.get(str(e.zone_id or p.get("zone_id", "")))
        if z:
            count = int(p.get("count", 1))
            z.injured += count
            z.threat = bump(z.threat)
            state.upsert_zone(z)
            facts.append(f"{z.name}: {count} heridos nuevos (total {z.injured})")

    elif e.kind == EventKind.resource_status:
        r = state.resources.get(str(p.get("resource_id", "")))
        if r:
            new_status = ResourceStatus(p.get("status", r.status))
            r.reported_status = new_status
            r.reported_at = e.ts
            if "eta_minutes" in p:
                r.eta_minutes = float(p["eta_minutes"])
            if r.assigned_task_id and new_status == ResourceStatus.available:
                if p.get("task_id") == r.assigned_task_id:
                    state.set_task_status(r.assigned_task_id, TaskStatus.done, e.title)
                    r.assigned_task_id = None
                    r.assigned_zone_id = None
                    r.status = new_status
                    clear_travel(r)
            else:
                r.status = new_status
            # Un parte de campo con posición manda sobre la estimación del agente.
            reported = p.get("location")
            if isinstance(reported, dict) and {"lat", "lng"} <= reported.keys():
                r.location = Location.model_validate(reported)
                r.position_estimated = False
                r.travel_from = None
                r.travel_started_at = None
            state.upsert_resource(r)
            facts.append(f"{r.name} -> {new_status}")

    elif e.kind == EventKind.integration_down:
        state.set_integration(str(p.get("name", "unknown")), False)
        facts.append(f"Integración caída: {p.get('name')}")

    elif e.kind == EventKind.integration_up:
        state.set_integration(str(p.get("name", "unknown")), True)
        facts.append(f"Integración recuperada: {p.get('name')}")

    elif e.kind in (EventKind.call_outcome, EventKind.message_outcome):
        facts.append(e.title)  # lo procesa el webhook; aquí solo cuenta como relevante

    return facts

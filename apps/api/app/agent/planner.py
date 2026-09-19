"""Motor de prioridades determinista.

Propone tareas a partir del estado actual contando con los medios que quedan.
Es el plan base; el LLM (si está) lo revisa, reordena y añade matices.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.domain.models import (
    ContactRole,
    ResourceStatus,
    ResourceType,
    Severity,
    Task,
    TaskKind,
    TaskStatus,
)
from app.domain.state import WorldState

OPEN = {
    TaskStatus.proposed,
    TaskStatus.awaiting_approval,
    TaskStatus.dispatching,
    TaskStatus.dispatched,
    TaskStatus.accepted,
    TaskStatus.in_progress,
}

SEV_SCORE = {Severity.low: 10, Severity.medium: 35, Severity.high: 65, Severity.critical: 90}


@dataclass
class Proposal:
    task: Task
    wants_resource_types: list[ResourceType] = field(default_factory=list)
    contact_roles: list[ContactRole] = field(default_factory=list)


def _has_open(state: WorldState, kind: TaskKind, zone_id: str | None) -> bool:
    return any(
        t.kind == kind and t.zone_id == zone_id and t.status in (OPEN | {TaskStatus.rejected})
        for t in state.tasks.values()
    )


def _assigned(state: WorldState, zone_id: str, rtype: ResourceType) -> int:
    return sum(
        1
        for r in state.resources.values()
        if r.type == rtype
        and r.assigned_zone_id == zone_id
        and r.status in (ResourceStatus.dispatched, ResourceStatus.on_scene)
    )


def zone_eta(state: WorldState, zone_id: str) -> float | None:
    etas = [
        f.eta_minutes_to_zone[zone_id]
        for f in state.fronts.values()
        if zone_id in f.eta_minutes_to_zone and f.contained_pct < 100
    ]
    return min(etas) if etas else None


def propose(state: WorldState) -> list[Proposal]:
    out: list[Proposal] = []

    for z in state.zones.values():
        eta = zone_eta(state, z.id)
        threat = SEV_SCORE[z.threat]
        people = z.civilians_present

        # 1. Heridos -> ambulancia. Lo más urgente de todo.
        if z.injured > 0 and _assigned(state, z.id, ResourceType.ambulance) == 0:
            if not _has_open(state, TaskKind.medical_triage, z.id):
                out.append(
                    Proposal(
                        Task(
                            kind=TaskKind.medical_triage,
                            title=f"Enviar ambulancia a {z.name}",
                            description=f"{z.injured} heridos reportados en {z.name}.",
                            priority=min(100, 85 + z.injured * 2),
                            priority_reason="Hay heridos y ningún medio sanitario asignado.",
                            zone_id=z.id,
                        ),
                        [ResourceType.ambulance],
                        [ContactRole.ambulance],
                    )
                )

        # 2. Evacuación si el fuego llega en < 60 min y hay gente.
        if eta is not None and eta <= 60 and people > 0 and z.evacuation_status == "none":
            if not _has_open(state, TaskKind.evacuate_zone, z.id):
                prio = min(100, int(70 + (60 - eta) / 2 + min(people, 5000) / 250))
                out.append(
                    Proposal(
                        Task(
                            kind=TaskKind.evacuate_zone,
                            title=f"Ordenar evacuación de {z.name}",
                            description=(
                                f"Frente a {eta:.0f} min. {people} personas. "
                                "Coordinar con policía y autobuses."
                            ),
                            priority=prio,
                            priority_reason=f"ETA del frente {eta:.0f} min con {people} personas.",
                            zone_id=z.id,
                            requires_approval=True,
                        ),
                        [ResourceType.police_unit, ResourceType.evacuation_bus],
                        [ContactRole.police, ContactRole.civil_protection],
                    )
                )

        # 3. Aviso preventivo a vecinos / camping si amenaza alta pero aún no evacuación.
        if (
            z.threat in (Severity.high, Severity.critical)
            and people > 0
            and z.evacuation_status == "none"
            and not _has_open(state, TaskKind.warn_civilian, z.id)
        ):
            civ = [
                c
                for c in state.contacts.values()
                if c.zone_id == z.id and c.role == ContactRole.civilian
            ]
            if civ:
                out.append(
                    Proposal(
                        Task(
                            kind=TaskKind.warn_civilian,
                            title=f"Avisar a población de {z.name}",
                            description="Aviso: preparar evacuación, cerrar ventanas, rutas.",
                            priority=int(threat * 0.8),
                            priority_reason=f"Amenaza {z.threat} sobre {people} personas.",
                            zone_id=z.id,
                        ),
                        [],
                        [ContactRole.civilian],
                    )
                )

        # 4. Informar al responsable municipal cuando la amenaza es crítica.
        if z.threat == Severity.critical and not _has_open(state, TaskKind.brief_authority, z.id):
            if any(
                c.zone_id == z.id and c.role == ContactRole.mayor for c in state.contacts.values()
            ):
                out.append(
                    Proposal(
                        Task(
                            kind=TaskKind.brief_authority,
                            title=f"Informar a alcaldía de {z.name}",
                            description="Situación crítica: frente, ETA, medios, evacuación.",
                            priority=60,
                            priority_reason="Amenaza crítica; el responsable debe activar el plan.",
                            zone_id=z.id,
                        ),
                        [],
                        [ContactRole.mayor],
                    )
                )

        # 5. Albergue en zonas seguras con capacidad si hay evacuación en curso en otra zona.
        evacuating = [
            o for o in state.zones.values() if o.evacuation_status in ("ordered", "in_progress")
        ]
        if (
            evacuating
            and z.shelter_capacity > 0
            and z.threat in (Severity.low, Severity.medium)
            and not _has_open(state, TaskKind.open_shelter, z.id)
        ):
            out.append(
                Proposal(
                    Task(
                        kind=TaskKind.open_shelter,
                        title=f"Abrir albergue en {z.name}",
                        description=f"Capacidad {z.shelter_capacity}. Evacuados de "
                        + ", ".join(o.name for o in evacuating),
                        priority=55,
                        priority_reason="Hay evacuación en curso y esta zona es segura.",
                        zone_id=z.id,
                    ),
                    [],
                    [ContactRole.shelter],
                )
            )

    # 6. Medios de extinción por frente: mínimo 1 dotación por frente activo, 2 si alto/crítico.
    for f in state.fronts.values():
        if f.contained_pct >= 100:
            continue
        target = 2 if f.intensity in (Severity.high, Severity.critical) else 1
        assigned = sum(
            1
            for r in state.resources.values()
            if r.type in (ResourceType.fire_engine, ResourceType.helicopter)
            and r.assigned_zone_id == f.id
            and r.status in (ResourceStatus.dispatched, ResourceStatus.on_scene)
        )
        open_for_front = sum(
            1
            for t in state.tasks.values()
            if t.kind == TaskKind.dispatch_resource and t.zone_id == f.id and t.status in OPEN
        )
        missing = target - assigned - open_for_front
        for _ in range(max(0, missing)):
            out.append(
                Proposal(
                    Task(
                        kind=TaskKind.dispatch_resource,
                        title=f"Dotación de extinción a {f.name}",
                        description=f"Intensidad {f.intensity}, rumbo {f.heading_deg:.0f}°.",
                        priority=SEV_SCORE[f.intensity],
                        priority_reason=f"{assigned}/{target} dotaciones en el frente.",
                        zone_id=f.id,
                    ),
                    [ResourceType.fire_engine, ResourceType.helicopter],
                    [ContactRole.firefighter],
                )
            )

    # 7. Carreteras cortadas que afectan a zonas amenazadas -> policía regula tráfico.
    for road in state.roads.values():
        if road.open:
            continue
        affected = [state.zones[z] for z in road.connects if z in state.zones]
        if any(z.threat in (Severity.high, Severity.critical) for z in affected):
            if not _has_open(state, TaskKind.close_road, road.id):
                out.append(
                    Proposal(
                        Task(
                            kind=TaskKind.close_road,
                            title=f"Regular tráfico y ruta alternativa: {road.name}",
                            description=f"Cortada ({road.reason}). Desviar evacuación.",
                            priority=58,
                            priority_reason="Ruta de evacuación cortada.",
                            zone_id=road.id,
                        ),
                        [ResourceType.police_unit],
                        [ContactRole.police],
                    )
                )

    out.sort(key=lambda p: -p.task.priority)
    return out


def replan_needed(state: WorldState, facts: list[str]) -> str:
    """Detecta si los cambios invalidan tareas en curso. Devuelve el motivo o ''."""
    reasons: list[str] = []
    for t in state.open_tasks():
        if t.kind == TaskKind.dispatch_resource and t.zone_id in state.fronts:
            if state.fronts[t.zone_id].contained_pct >= 100:
                reasons.append(f"{t.title}: frente contenido")
        if t.kind == TaskKind.evacuate_zone and t.zone_id in state.zones:
            eta = zone_eta(state, t.zone_id)
            if eta is None or eta > 180:
                reasons.append(f"{t.title}: el frente ya no amenaza la zona")
        for rid in t.resource_ids:
            r = state.resources.get(rid)
            if r and r.status == ResourceStatus.out_of_service:
                reasons.append(f"{t.title}: {r.name} fuera de servicio")
    if any("cortada" in f for f in facts):
        reasons.append("ruta de evacuación cortada")
    if any("Viento" in f for f in facts):
        reasons.append("cambio de viento: los frentes giran")
    return "; ".join(reasons)

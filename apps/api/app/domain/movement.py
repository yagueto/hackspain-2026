"""Avance de las unidades hacia su destino.

La posición que se publica aquí es una **estimación** derivada del tiempo transcurrido y la
distancia al destino, no telemetría: nadie nos manda GPS. Por eso cada recurso movido queda
marcado con `position_estimated` y un parte de campo siempre la sobrescribe.

Solo avanzan las unidades en `en_route`, es decir, las que han aceptado la llamada. Una orden
enviada no significa que nadie se haya puesto en marcha.
"""

from __future__ import annotations

from datetime import datetime

from app.domain.models import Location, Resource, ResourceStatus, ResourceType

# Velocidades de crucero aproximadas, en km/h, con urgencia y sin optimismo.
CRUISE_KMH: dict[ResourceType, float] = {
    ResourceType.fire_engine: 55,
    ResourceType.ambulance: 65,
    ResourceType.police_unit: 70,
    ResourceType.helicopter: 180,
    ResourceType.bulldozer: 25,
    ResourceType.evacuation_bus: 45,
}

MIN_TRAVEL_MINUTES = 0.5


def distance_km(a: Location, b: Location) -> float:
    import math

    lat1, lat2 = math.radians(a.lat), math.radians(b.lat)
    dlat, dlon = lat2 - lat1, math.radians(b.lng - a.lng)
    hav = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371 * 2 * math.asin(min(1, math.sqrt(hav)))


def estimated_minutes(origin: Location, target: Location, kind: ResourceType) -> float:
    """Tiempo por carretera aproximado: distancia recta con un recargo por trazado real."""
    straight = distance_km(origin, target)
    speed = CRUISE_KMH.get(kind, 50)
    return max(MIN_TRAVEL_MINUTES, (straight * 1.3) / speed * 60)


def between(origin: Location, target: Location, fraction: float) -> Location:
    share = min(1.0, max(0.0, fraction))
    return Location(
        lat=origin.lat + (target.lat - origin.lat) * share,
        lng=origin.lng + (target.lng - origin.lng) * share,
        label=target.label if share >= 1 else origin.label,
    )


def clear_travel(resource: Resource) -> None:
    """Al soltar la unidad, su recorrido deja de tener sentido."""
    resource.travel_from = None
    resource.travel_started_at = None
    resource.travel_minutes = None
    resource.travel_progress = 0.0
    resource.position_estimated = False


def advance(resource: Resource, target: Location, at: datetime) -> bool:
    """Acerca la unidad a su destino. Devuelve si algo cambió lo bastante para publicarlo."""
    if resource.status != ResourceStatus.en_route:
        return False
    if resource.travel_started_at is None or resource.travel_from is None:
        resource.travel_from = resource.location.model_copy()
        resource.travel_started_at = at
        resource.travel_minutes = (
            resource.eta_minutes
            if resource.eta_minutes and resource.eta_minutes > 0
            else estimated_minutes(resource.location, target, resource.type)
        )
        resource.eta_minutes = round(resource.travel_minutes, 1)
        resource.position_estimated = True
        return True
    total = resource.travel_minutes or MIN_TRAVEL_MINUTES
    elapsed = (at - resource.travel_started_at).total_seconds() / 60
    progress = min(1.0, max(0.0, elapsed / total))
    # Un avance imperceptible no merece una escritura ni un refresco del panel.
    if progress - resource.travel_progress < 0.01 and progress < 1:
        return False
    resource.travel_progress = progress
    resource.location = between(resource.travel_from, target, progress)
    resource.position_estimated = True
    resource.eta_minutes = round(total * (1 - progress), 1)
    if progress >= 1:
        # Llegar no cierra la misión: eso lo dice un parte de campo, no un cronómetro.
        resource.status = ResourceStatus.on_scene
        resource.eta_minutes = 0
    return True

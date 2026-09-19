"""Escenario semilla: incendio forestal en la Sierra de Gredos (ficticio)."""

from __future__ import annotations

from app.domain.models import (
    Contact,
    ContactRole,
    FireFront,
    Incident,
    Location,
    Resource,
    ResourceType,
    Road,
    Severity,
    Weather,
    Zone,
)
from app.domain.state import WorldState


def seed_wildfire(state: WorldState, phones: dict[str, str] | None = None) -> None:
    """Carga el escenario base. `phones` permite mapear rol -> teléfono real para la demo."""
    phones = phones or {}
    state.incident = Incident(
        id="inc_gredos",
        name="Incendio forestal Sierra de Gredos",
        command_post=Location(lat=40.29, lng=-5.12, label="Puesto de mando - Arenas de San Pedro"),
        summary="Fuego declarado a las 11:40 en la ladera sur. Viento del SO 25 km/h.",
    )
    state.weather = Weather(
        wind_from_deg=225,
        wind_kmh=25,
        temperature_c=34,
        humidity_pct=18,
        forecast="Racheado por la tarde",
    )

    zones = [
        Zone(
            id="zone_candeleda",
            name="Candeleda",
            location=Location(lat=40.155, lng=-5.24),
            population=5000,
            threat=Severity.high,
            civilians_present=5000,
            shelter_capacity=800,
        ),
        Zone(
            id="zone_poyales",
            name="Poyales del Hoyo",
            location=Location(lat=40.17, lng=-5.17),
            population=600,
            threat=Severity.critical,
            civilians_present=600,
        ),
        Zone(
            id="zone_arenas",
            name="Arenas de San Pedro",
            location=Location(lat=40.21, lng=-5.09),
            population=6500,
            threat=Severity.medium,
            civilians_present=6500,
            shelter_capacity=1500,
        ),
        Zone(
            id="zone_camping",
            name="Camping El Raso",
            location=Location(lat=40.19, lng=-5.28),
            population=0,
            threat=Severity.high,
            civilians_present=120,
        ),
        Zone(
            id="zone_guisando",
            name="Guisando",
            location=Location(lat=40.22, lng=-5.14),
            population=500,
            threat=Severity.low,
            civilians_present=500,
        ),
    ]
    for z in zones:
        state.upsert_zone(z)

    state.upsert_front(
        FireFront(
            id="front_sur",
            name="Frente Sur",
            location=Location(lat=40.18, lng=-5.20),
            heading_deg=45,
            speed_kmh=1.8,
            intensity=Severity.high,
            threatens_zone_ids=["zone_poyales", "zone_camping"],
            eta_minutes_to_zone={"zone_poyales": 40, "zone_camping": 25},
        )
    )
    state.upsert_front(
        FireFront(
            id="front_este",
            name="Frente Este",
            location=Location(lat=40.20, lng=-5.13),
            heading_deg=90,
            speed_kmh=0.6,
            intensity=Severity.medium,
            threatens_zone_ids=["zone_arenas"],
            eta_minutes_to_zone={"zone_arenas": 120},
        )
    )

    for r in [
        Road(
            id="road_av924",
            name="AV-924 Candeleda-Arenas",
            connects=["zone_candeleda", "zone_arenas"],
        ),
        Road(
            id="road_av923",
            name="AV-923 Poyales-Candeleda",
            connects=["zone_poyales", "zone_candeleda"],
        ),
        Road(
            id="road_raso",
            name="Pista Camping El Raso",
            connects=["zone_camping", "zone_candeleda"],
        ),
        Road(
            id="road_guisando",
            name="AV-921 Guisando-Arenas",
            connects=["zone_guisando", "zone_arenas"],
        ),
    ]:
        state.upsert_road(r)

    resources = [
        Resource(
            id="res_bomb1",
            name="Bomberos Arenas 1",
            type=ResourceType.fire_engine,
            location=Location(lat=40.21, lng=-5.09),
            capacity=6,
        ),
        Resource(
            id="res_bomb2",
            name="Bomberos Arenas 2",
            type=ResourceType.fire_engine,
            location=Location(lat=40.21, lng=-5.09),
            capacity=6,
        ),
        Resource(
            id="res_bomb3",
            name="BRIF Candeleda",
            type=ResourceType.fire_engine,
            location=Location(lat=40.155, lng=-5.24),
            capacity=8,
        ),
        Resource(
            id="res_amb1",
            name="Ambulancia SVB Candeleda",
            type=ResourceType.ambulance,
            location=Location(lat=40.155, lng=-5.24),
            capacity=2,
        ),
        Resource(
            id="res_amb2",
            name="Ambulancia SVA Arenas",
            type=ResourceType.ambulance,
            location=Location(lat=40.21, lng=-5.09),
            capacity=1,
        ),
        Resource(
            id="res_pol1",
            name="Guardia Civil Arenas",
            type=ResourceType.police_unit,
            location=Location(lat=40.21, lng=-5.09),
            capacity=4,
        ),
        Resource(
            id="res_pol2",
            name="Policía Local Candeleda",
            type=ResourceType.police_unit,
            location=Location(lat=40.155, lng=-5.24),
            capacity=2,
        ),
        Resource(
            id="res_heli1",
            name="Helicóptero Kamov",
            type=ResourceType.helicopter,
            location=Location(lat=40.29, lng=-5.12),
            capacity=4500,
        ),
        Resource(
            id="res_bus1",
            name="Autobús evacuación 1",
            type=ResourceType.evacuation_bus,
            location=Location(lat=40.21, lng=-5.09),
            capacity=55,
        ),
        Resource(
            id="res_bus2",
            name="Autobús evacuación 2",
            type=ResourceType.evacuation_bus,
            location=Location(lat=40.155, lng=-5.24),
            capacity=55,
        ),
    ]
    for res in resources:
        state.upsert_resource(res)

    contacts = [
        Contact(
            id="ct_bomb1",
            name="Sgto. Ruiz (Bomberos Arenas 1)",
            role=ContactRole.firefighter,
            phone=phones.get("firefighter", "+34600000001"),
            resource_id="res_bomb1",
        ),
        Contact(
            id="ct_bomb2",
            name="Cabo Martín (Bomberos Arenas 2)",
            role=ContactRole.firefighter,
            phone=phones.get("firefighter", "+34600000002"),
            resource_id="res_bomb2",
        ),
        Contact(
            id="ct_bomb3",
            name="Jefe BRIF Candeleda",
            role=ContactRole.firefighter,
            phone=phones.get("firefighter", "+34600000003"),
            resource_id="res_bomb3",
        ),
        Contact(
            id="ct_amb1",
            name="SVB Candeleda",
            role=ContactRole.ambulance,
            phone=phones.get("ambulance", "+34600000011"),
            resource_id="res_amb1",
        ),
        Contact(
            id="ct_amb2",
            name="SVA Arenas",
            role=ContactRole.ambulance,
            phone=phones.get("ambulance", "+34600000012"),
            resource_id="res_amb2",
        ),
        Contact(
            id="ct_pol1",
            name="Guardia Civil Arenas",
            role=ContactRole.police,
            phone=phones.get("police", "+34600000021"),
            resource_id="res_pol1",
        ),
        Contact(
            id="ct_pol2",
            name="Policía Local Candeleda",
            role=ContactRole.police,
            phone=phones.get("police", "+34600000022"),
            resource_id="res_pol2",
        ),
        Contact(
            id="ct_bus1",
            name="Conductor bus 1",
            role=ContactRole.civil_protection,
            phone=phones.get("civil_protection", "+34600000031"),
            resource_id="res_bus1",
        ),
        Contact(
            id="ct_bus2",
            name="Conductor bus 2",
            role=ContactRole.civil_protection,
            phone=phones.get("civil_protection", "+34600000032"),
            resource_id="res_bus2",
        ),
        Contact(
            id="ct_mayor_poyales",
            name="Alcaldesa de Poyales",
            role=ContactRole.mayor,
            phone=phones.get("mayor", "+34600000041"),
            zone_id="zone_poyales",
        ),
        Contact(
            id="ct_mayor_candeleda",
            name="Alcalde de Candeleda",
            role=ContactRole.mayor,
            phone=phones.get("mayor", "+34600000042"),
            zone_id="zone_candeleda",
        ),
        Contact(
            id="ct_camping",
            name="Recepción Camping El Raso",
            role=ContactRole.civilian,
            phone=phones.get("civilian", "+34600000051"),
            zone_id="zone_camping",
        ),
        Contact(
            id="ct_shelter_arenas",
            name="Polideportivo Arenas (albergue)",
            role=ContactRole.shelter,
            phone=phones.get("shelter", "+34600000061"),
            zone_id="zone_arenas",
        ),
    ]
    for c in contacts:
        state.upsert_contact(c)

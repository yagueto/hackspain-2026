"""Control del escenario para la demo: reset, semilla y guion de eventos."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import require_api_key
from app.domain.models import Event, EventSource, new_id
from app.domain.scenario import seed_wildfire
from app.domain.state import WorldState
from app.runtime import Runtime, get_runtime

router = APIRouter(prefix="/scenario", tags=["scenario"], dependencies=[Depends(require_api_key)])


class SeedIn(BaseModel):
    phones: dict[str, str] = Field(
        default_factory=dict,
        description="rol -> teléfono real para la demo (firefighter, ambulance, police, mayor...)",
    )
    autostart_agent: bool = True


@router.post("/reset")
async def reset(body: SeedIn | None = None, rt: Runtime = Depends(get_runtime)) -> dict[str, str]:
    body = body or SeedIn()
    if not rt.settings.seed_demo or rt.settings.happyrobot_mode == "live":
        raise HTTPException(409, "reset solo disponible en modo demo simulado")
    await rt.orchestrator.stop()
    state = WorldState()
    seed_wildfire(state, body.phones)
    run_id = new_id("demo")
    if state.incident:
        state.incident.id = run_id
    snapshot = await rt.store.create(state.snapshot(full=True))
    rt.state.restore(snapshot, emit=True)
    rt.orchestrator.start(body.autostart_agent)
    return {"run_id": run_id, "incident": rt.state.incident.name if rt.state.incident else ""}


# Guion de la demo: una secuencia de eventos que "mueve" la crisis.
SCRIPT: list[dict[str, object]] = [
    {
        "kind": "civilians_reported",
        "title": "112: 120 personas en Camping El Raso, sin coche muchos",
        "zone_id": "zone_camping",
        "payload": {"count": 120},
        "severity": "high",
    },
    {
        "kind": "wind_change",
        "title": "AEMET: el viento rola a NO y sube a 40 km/h",
        "payload": {"wind_from_deg": 315, "wind_kmh": 40},
        "severity": "critical",
    },
    {
        "kind": "fire_spread",
        "title": "Frente Sur gira hacia Candeleda",
        "payload": {
            "front_id": "front_sur",
            "heading_deg": 135,
            "speed_kmh": 2.7,
            "intensity": "critical",
            "threatens": {"zone_candeleda": 35, "zone_camping": 15},
        },
        "severity": "critical",
    },
    {
        "kind": "road_blocked",
        "title": "Guardia Civil: AV-923 cortada por el fuego",
        "payload": {"road_id": "road_av923", "reason": "fuego en la calzada"},
        "severity": "high",
    },
    {
        "kind": "injured_reported",
        "title": "Parte de campo: 3 heridos por quemaduras en el camping",
        "zone_id": "zone_camping",
        "payload": {"count": 3},
        "severity": "critical",
    },
    {
        "kind": "resource_status",
        "title": "Bomberos Arenas 2 avería mecánica",
        "payload": {"resource_id": "res_bomb2", "status": "out_of_service"},
        "severity": "high",
    },
    {
        "kind": "integration_down",
        "title": "Caída de la telefonía HappyRobot (simulada)",
        "payload": {"name": "happyrobot"},
        "severity": "high",
    },
    {
        "kind": "integration_up",
        "title": "Telefonía recuperada",
        "payload": {"name": "happyrobot"},
        "severity": "low",
    },
    {
        "kind": "note",
        "title": "Vecino: 'huele a humo en Guisando' (ruido, sin cambios)",
        "zone_id": "zone_guisando",
        "severity": "low",
    },
    {
        "kind": "fire_spread",
        "title": "Frente Este contenido al 100%",
        "payload": {"front_id": "front_este", "contained_pct": 100, "intensity": "low"},
        "severity": "low",
    },
]


@router.get("/script")
async def get_script() -> list[dict[str, object]]:
    return [{"step": i, **s} for i, s in enumerate(SCRIPT)]


@router.post("/step/{n}", status_code=202)
async def play_step(n: int, rt: Runtime = Depends(get_runtime)) -> Event:
    s = SCRIPT[n % len(SCRIPT)]
    if not rt.settings.seed_demo:
        raise HTTPException(409, "escenario demo deshabilitado")
    return await rt.orchestrator.ingest_event(
        Event.model_validate({"source": EventSource.simulator, **s})
    )

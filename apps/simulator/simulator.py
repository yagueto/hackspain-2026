"""Simulador de la crisis: genera eventos aleatorios y resultados de llamadas.

Tres bucles concurrentes contra la API:

- mundo:    cada --min-delay..--max-delay segundos emite un evento a POST /events.
            El tipo se sortea con pesos que cambian según la fase de la crisis
            (ignición -> escalada -> complicaciones -> resolución), y cada
            generador randomiza zona, valores y redacción.
- llamadas: vigila tareas `dispatched` y acciones SMS, y las resuelve con un
            resultado aleatorio vía POST /webhooks/happyrobot (aceptada, no
            contesta, rechazada... a veces con ETA, heridos o novedades).
- operador: auto-aprueba (o rara vez rechaza) las tareas `awaiting_approval`.

Uso:
    uv sync
    uv run python simulator.py --reset --seed 7
"""

from __future__ import annotations

import argparse
import asyncio
import os
import random
import time
from typing import Any

import httpx

# --------------------------------------------------------------------------- texto


CIVILIAN_TITLES = [
    "112: recuento en {zone}, quedan {count} personas",
    "Vecinos de {zone} confirman {count} personas en la zona",
    "Parte de campo: {count} civiles aún en {zone}",
    "112: una llamada reporta {count} personas en {zone}",
]

INJURED_TITLES = [
    "Parte sanitario: {count} heridos en {zone}",
    "Equipo en {zone} reporta {count} heridos por humo",
    "112: {count} personas quemadas en {zone}",
]

FIRE_WORSE_TITLES = [
    "{front} acelera a {speed} km/h",
    "{front} gira a rumbo {heading:.0f}°",
    "Vuelo de reconocimiento: {front} aviva",
    "{front} gana intensidad, avance irregular",
]

FIRE_CONTAIN_TITLES = [
    "{front} contenido al {pct:.0f}%",
    "Brigadas confirman {pct:.0f}% de control en {front}",
]

ROAD_BLOCK_TITLES = [
    "GC: {road} cortada, {reason}",
    "Parte: {road} intransitable ({reason})",
]

ROAD_REASONS = [
    "fuego en la calzada",
    "árboles caídos",
    "humo denso, visibilidad nula",
    "volcado de un camión",
    "colapso de vehículos evacuando",
]

ROAD_OPEN_TITLES = [
    "{road} reabierta al tráfico",
    "GC despeja {road}, circulación restablecida",
]

RESOURCE_OUT_TITLES = [
    "{res}: avería mecánica, fuera de servicio",
    "{res}: fallo de bomba, retirada a base",
    "{res}: pinchazo y sin repuesto",
]

RESOURCE_BACK_TITLES = [
    "{res}: reparado, vuelve a servicio",
    "{res} operativo de nuevo",
]

RESOURCE_SCENE_TITLES = [
    "{res} llega a destino",
    "{res} ya en escena",
]

CHATTER_TITLES = [
    "Chat vecinos {zone}: «se ve mucho humo por la ladera»",
    "Chat vecinos {zone}: «¿alguien sabe si hay que irse?»",
    "Redes: video del fuego desde {zone} viralizándose",
    "112: vecino de {zone} huele a humo (sin confirmar)",
    "Operador: rumor de saqueos en {zone}, sin verificar",
    "Chat protección civil: voluntarios se ofrecen en {zone}",
    "112: falsa alarma de foco nuevo cerca de {zone}",
    "Prensa local pide confirmación de evacuación en {zone}",
    "Chat vecinos {zone}: «la luz se corta a ratos»",
    "Operador: el alcalde pregunta por la situación en {zone}",
]

WIND_TITLES = [
    "AEMET: viento rola a {deg:.0f}°, {kmh:.0f} km/h",
    "Meteo: rachas de {kmh:.0f} km/h del {deg:.0f}°",
    "Torre de vigilancia: el viento gira a {deg:.0f}°",
]

ACCEPTED_SUMMARIES = [
    "Recibido, salimos ya",
    "Entendido, movilizamos",
    "En camino",
    "Copiado, coordinamos",
]

FAIL_SUMMARIES = {
    "no_answer": "No contesta",
    "voicemail": "Buzón de voz",
    "busy": "Comunicando",
    "rejected": "No podemos, estamos en otro servicio",
    "failed": "Error de red",
}

INFO_SUMMARIES = [
    "Aviso recibido",
    "Confirmamos recepción, pendientes",
    "Todo anotado, os avisamos",
]


# --------------------------------------------------------------------------- helpers


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def sev_bump(sev: str, steps: int = 1) -> str:
    order = ["low", "medium", "high", "critical"]
    return order[min(3, max(0, order.index(sev) + steps))]


def weighted(rng: random.Random, weights: dict[str, float]) -> str:
    kinds, w = zip(*weights.items(), strict=True)
    return rng.choices(kinds, weights=w, k=1)[0]


def phase(elapsed: float) -> str:
    if elapsed < 120:
        return "ignición"
    if elapsed < 400:
        return "escalada"
    if elapsed < 620:
        return "complicaciones"
    return "resolución"


PHASE_WEIGHTS: dict[str, dict[str, float]] = {
    "ignición": {
        "civilians": 3,
        "note": 4,
        "fire": 2,
        "wind": 1,
        "injured": 1,
        "road_block": 0.5,
        "resource": 0.5,
    },
    "escalada": {
        "fire": 4,
        "wind": 2,
        "road_block": 2.5,
        "injured": 2.5,
        "civilians": 2,
        "note": 2,
        "resource": 1,
        "integration": 0.4,
    },
    "complicaciones": {
        "resource": 2.5,
        "integration": 1.5,
        "injured": 2,
        "road_block": 1.5,
        "fire": 3,
        "civilians": 2,
        "note": 3,
        "wind": 1,
    },
    "resolución": {
        "fire": 4,  # con bias a contención
        "road_open": 2.5,
        "wind": 1.5,  # con bias a calma
        "civilians": 2,
        "note": 2,
        "resource": 1.5,
        "injured": 0.5,
    },
}


# ----------------------------------------------------------------- generadores


def g_civilians(st: dict, rng: random.Random) -> dict | None:
    zones = [z for z in st["zones"] if z["civilians_present"] > 0]
    if not zones:
        return None
    z = rng.choice(zones)
    cur = z["civilians_present"]
    direction = -1 if (phase_now == "resolución" or rng.random() < 0.65) else 1
    count = max(0, cur + direction * rng.randint(3, max(4, int(cur * 0.3))))
    if count == cur:
        return None
    return {
        "source": rng.choice(["call_112", "field_report", "sensor"]),
        "kind": "civilians_reported",
        "severity": "medium" if direction < 0 else "high",
        "title": rng.choice(CIVILIAN_TITLES).format(zone=z["name"], count=count),
        "zone_id": z["id"],
        "payload": {"count": count},
    }


def g_injured(st: dict, rng: random.Random) -> dict | None:
    zones = [z for z in st["zones"] if z["threat"] in ("high", "critical")] or st["zones"]
    if not zones:
        return None
    z = rng.choice(zones)
    count = rng.randint(1, 3)
    return {
        "source": rng.choice(["field_report", "call_112"]),
        "kind": "injured_reported",
        "severity": "critical" if count >= 3 else "high",
        "title": rng.choice(INJURED_TITLES).format(zone=z["name"], count=count),
        "zone_id": z["id"],
        "payload": {"count": count},
    }


def g_fire(st: dict, rng: random.Random) -> dict | None:
    fronts = [f for f in st["fronts"] if f["contained_pct"] < 100]
    if not fronts:
        return None
    f = rng.choice(fronts)
    if phase_now == "resolución" or rng.random() < 0.3:
        pct = min(100.0, f["contained_pct"] + rng.randint(15, 40))
        return {
            "source": "sensor",
            "kind": "fire_spread",
            "severity": "low" if pct >= 100 else "medium",
            "title": rng.choice(FIRE_CONTAIN_TITLES).format(front=f["name"], pct=pct),
            "payload": {
                "front_id": f["id"],
                "contained_pct": pct,
                "intensity": "low" if pct >= 100 else f["intensity"],
            },
        }
    speed = round(clamp(f["speed_kmh"] + rng.uniform(-0.3, 0.9), 0.3, 4.5), 2)
    heading = (f["heading_deg"] + rng.uniform(-35, 35)) % 360
    payload: dict[str, Any] = {"front_id": f["id"], "heading_deg": round(heading, 1),
                               "speed_kmh": speed}
    sev = "medium"
    if rng.random() < 0.5 and st["zones"]:
        z = rng.choice(st["zones"])
        eta = rng.randint(15, 150)
        payload["threatens"] = {z["id"]: eta}
        sev = "critical" if eta <= 30 else "high"
    if rng.random() < 0.3:
        payload["intensity"] = sev_bump(f["intensity"], rng.choice([-1, 1]))
        sev = "high" if payload["intensity"] in ("high", "critical") else sev
    return {
        "source": rng.choice(["sensor", "field_report"]),
        "kind": "fire_spread",
        "severity": sev,
        "title": rng.choice(FIRE_WORSE_TITLES).format(front=f["name"], speed=speed,
                                                      heading=heading),
        "payload": payload,
    }


def g_wind(st: dict, rng: random.Random) -> dict | None:
    w = st["weather"]
    if phase_now == "resolución":
        kmh = clamp(w["wind_kmh"] - rng.uniform(4, 12), 5, 60)
    else:
        kmh = clamp(w["wind_kmh"] + rng.uniform(-8, 15), 5, 65)
    deg = (w["wind_from_deg"] + rng.uniform(-70, 70)) % 360
    return {
        "source": "weather",
        "kind": "wind_change",
        "severity": "critical" if kmh >= 35 else "medium",
        "title": rng.choice(WIND_TITLES).format(deg=deg, kmh=kmh),
        "payload": {"wind_from_deg": round(deg, 1), "wind_kmh": round(kmh, 1)},
    }


def g_road_block(st: dict, rng: random.Random) -> dict | None:
    open_roads = [r for r in st["roads"] if r["open"]]
    if not open_roads:
        return None
    r = rng.choice(open_roads)
    reason = rng.choice(ROAD_REASONS)
    return {
        "source": rng.choice(["field_report", "call_112"]),
        "kind": "road_blocked",
        "severity": "high",
        "title": rng.choice(ROAD_BLOCK_TITLES).format(road=r["name"], reason=reason),
        "payload": {"road_id": r["id"], "reason": reason},
    }


def g_road_open(st: dict, rng: random.Random) -> dict | None:
    closed = [r for r in st["roads"] if not r["open"]]
    if not closed:
        return None
    r = rng.choice(closed)
    return {
        "source": "field_report",
        "kind": "road_open",
        "severity": "low",
        "title": rng.choice(ROAD_OPEN_TITLES).format(road=r["name"]),
        "payload": {"road_id": r["id"]},
    }


def g_resource(st: dict, rng: random.Random) -> dict | None:
    dispatched = [r for r in st["resources"] if r["status"] == "dispatched"]
    broken = [r for r in st["resources"] if r["status"] == "out_of_service"]
    available = [r for r in st["resources"] if r["status"] == "available"]
    roll = rng.random()
    if dispatched and roll < 0.55:
        r = rng.choice(dispatched)
        return {
            "source": "field_report",
            "kind": "resource_status",
            "severity": "low",
            "title": rng.choice(RESOURCE_SCENE_TITLES).format(res=r["name"]),
            "payload": {"resource_id": r["id"], "status": "on_scene"},
        }
    if broken and (roll < 0.8 or phase_now == "resolución"):
        r = rng.choice(broken)
        return {
            "source": "field_report",
            "kind": "resource_status",
            "severity": "low",
            "title": rng.choice(RESOURCE_BACK_TITLES).format(res=r["name"]),
            "payload": {"resource_id": r["id"], "status": "available"},
        }
    if available:
        r = rng.choice(available)
        return {
            "source": "field_report",
            "kind": "resource_status",
            "severity": "high",
            "title": rng.choice(RESOURCE_OUT_TITLES).format(res=r["name"]),
            "payload": {"resource_id": r["id"], "status": "out_of_service"},
        }
    return None


def g_note(st: dict, rng: random.Random) -> dict | None:
    if not st["zones"]:
        return None
    z = rng.choice(st["zones"])
    return {
        "source": rng.choice(["call_112", "operator", "field_report"]),
        "kind": "note",
        "severity": rng.choice(["low", "low", "medium"]),
        "title": rng.choice(CHATTER_TITLES).format(zone=z["name"]),
        "zone_id": z["id"],
    }


def g_integration(st: dict, rng: random.Random) -> dict | None:
    if not st["integrations"].get("happyrobot", True):
        return None
    return {
        "source": "simulator",
        "kind": "integration_down",
        "severity": "high",
        "title": "Caída de la telefonía HappyRobot (simulada)",
        "payload": {"name": "happyrobot"},
    }


GENERATORS = {
    "civilians": g_civilians,
    "injured": g_injured,
    "fire": g_fire,
    "wind": g_wind,
    "road_block": g_road_block,
    "road_open": g_road_open,
    "resource": g_resource,
    "note": g_note,
    "integration": g_integration,
}

phase_now = "ignición"  # actualizado por el bucle principal


# --------------------------------------------------------------------------- sim


class Sim:
    def __init__(self, cfg: argparse.Namespace) -> None:
        self.cfg = cfg
        self.rng = random.Random(cfg.seed)
        self.t0 = time.monotonic()
        self.stop = asyncio.Event()
        self.handled_tasks: set[str] = set()
        self.handled_actions: set[str] = set()
        self.handled_approvals: set[str] = set()
        self.client = httpx.AsyncClient(base_url=cfg.api_url, timeout=15)

    def log(self, msg: str) -> None:
        print(f"[t+{time.monotonic() - self.t0:6.1f}s] {msg}", flush=True)

    async def get_state(self) -> dict | None:
        try:
            r = await self.client.get("/state")
            if r.status_code == 200:
                return r.json()
            if r.status_code == 409:
                self.log("!! estado no sembrado: lanza con --reset")
        except httpx.HTTPError as exc:
            self.log(f"!! API inalcanzable: {exc}")
        return None

    async def post_event(self, ev: dict) -> None:
        try:
            r = await self.client.post(
                "/events", json=ev, headers={"X-API-Key": self.cfg.api_key}
            )
            tag = "OK" if r.status_code == 202 else f"HTTP {r.status_code}"
            self.log(f"evento {ev['kind']:>18} [{tag}] {ev['title']}")
        except httpx.HTTPError as exc:
            self.log(f"!! error enviando evento: {exc}")

    # ---------------------------------------------------------------- loops

    async def world_loop(self) -> None:
        """Emite eventos del mundo con cadencia aleatoria."""
        global phase_now
        while not self.stop.is_set():
            await asyncio.sleep(self.rng.uniform(self.cfg.min_delay, self.cfg.max_delay))
            if self.stop.is_set():
                return
            st = await self.get_state()
            if st is None:
                continue
            phase_now = phase(time.monotonic() - self.t0)
            weights = PHASE_WEIGHTS[phase_now]
            ev = None
            for _ in range(6):  # reintenta si el generador no aplica
                kind = weighted(self.rng, weights)
                ev = GENERATORS[kind](st, self.rng)
                if ev:
                    break
            if ev is None:
                ev = g_note(st, self.rng)
            if ev:
                await self.post_event(ev)
                if ev["kind"] == "integration_down":
                    asyncio.create_task(self._recover_integration())

    async def _recover_integration(self) -> None:
        await asyncio.sleep(self.rng.uniform(30, 90))
        if self.stop.is_set():
            return
        await self.post_event(
            {
                "source": "simulator",
                "kind": "integration_up",
                "severity": "low",
                "title": "Telefonía HappyRobot recuperada",
                "payload": {"name": "happyrobot"},
            }
        )

    async def calls_loop(self) -> None:
        """Responde las llamadas/SMS que el agente deja 'dispatched'."""
        while not self.stop.is_set():
            await asyncio.sleep(4)
            try:
                r = await self.client.get("/tasks", params={"status": "dispatched"})
                tasks = r.json() if r.status_code == 200 else []
                r = await self.client.get("/actions")
                actions = r.json() if r.status_code == 200 else []
            except httpx.HTTPError:
                continue
            for t in tasks:
                if t["id"] not in self.handled_tasks and t.get("action_ids"):
                    self.handled_tasks.add(t["id"])
                    asyncio.create_task(self._resolve_call(t))
            for a in actions:
                if (
                    a["kind"] == "sms"
                    and a["status"] == "dispatched"
                    and a["id"] not in self.handled_actions
                ):
                    self.handled_actions.add(a["id"])
                    asyncio.create_task(self._resolve_sms(a))

    async def _webhook(self, body: dict) -> None:
        headers = {"X-Webhook-Secret": self.cfg.webhook_secret} if self.cfg.webhook_secret else {}
        try:
            r = await self.client.post("/webhooks/happyrobot", json=body, headers=headers)
            tag = "OK" if r.status_code == 202 else f"HTTP {r.status_code}"
            self.log(f"llamada {body.get('outcome', '?'):>10} [{tag}] {body.get('summary', '')}")
        except httpx.HTTPError as exc:
            self.log(f"!! error en webhook: {exc}")

    async def _resolve_call(self, task: dict) -> None:
        await asyncio.sleep(self.rng.uniform(8, 30))
        if self.stop.is_set():
            return
        outcome = weighted(
            self.rng,
            {"accepted": 0.62, "info": 0.13, "no_answer": 0.1,
             "busy": 0.05, "rejected": 0.05, "voicemail": 0.05},
        )
        body: dict[str, Any] = {"task_id": task["id"], "outcome": outcome}
        if outcome == "accepted":
            body["summary"] = self.rng.choice(ACCEPTED_SUMMARIES)
            if task.get("resource_ids"):
                body["eta_minutes"] = self.rng.randint(6, 35)
                body["summary"] += f", ETA {body['eta_minutes']} min"
            if task["kind"] == "evacuate_zone" and self.rng.random() < 0.85:
                body["evacuation_confirmed"] = True
                st = await self.get_state()
                if st:
                    z = next((x for x in st["zones"] if x["id"] == task.get("zone_id")), None)
                    if z:
                        body["civilians_count"] = int(
                            z["civilians_present"] * self.rng.uniform(0.3, 0.8)
                        )
            if task["kind"] == "medical_triage" and self.rng.random() < 0.3:
                body["injured_count"] = self.rng.randint(1, 2)
            if task["kind"] == "open_shelter":
                body["shelter_capacity"] = self.rng.choice([800, 1200, 1500])
            if self.rng.random() < 0.12:
                st = await self.get_state()
                if st:
                    opens = [r for r in st["roads"] if r["open"]]
                    if opens:
                        road = self.rng.choice(opens)
                        body["road_blocked"] = road["id"]
                        body["summary"] += f". Ojo: {road['name']} cortada"
        elif outcome == "info":
            body["summary"] = self.rng.choice(INFO_SUMMARIES)
        else:
            body["summary"] = FAIL_SUMMARIES[outcome]
        await self._webhook(body)

    async def _resolve_sms(self, action: dict) -> None:
        await asyncio.sleep(self.rng.uniform(5, 20))
        if self.stop.is_set():
            return
        await self._webhook(
            {
                "action_id": action["id"],
                "outcome": self.rng.choice(["info", "info", "accepted", "no_answer"]),
                "summary": self.rng.choice(INFO_SUMMARIES),
            }
        )

    async def operator_loop(self) -> None:
        """Aprueba (casi siempre) las tareas que esperan decisión humana."""
        while not self.stop.is_set():
            await asyncio.sleep(5)
            try:
                r = await self.client.get("/tasks", params={"status": "awaiting_approval"})
                tasks = r.json() if r.status_code == 200 else []
            except httpx.HTTPError:
                continue
            for t in tasks:
                if t["id"] not in self.handled_approvals:
                    self.handled_approvals.add(t["id"])
                    asyncio.create_task(self._resolve_approval(t))

    async def _resolve_approval(self, task: dict) -> None:
        await asyncio.sleep(self.rng.uniform(8, 25))
        if self.stop.is_set():
            return
        approved = self.rng.random() < 0.9
        note = "OK, proceded" if approved else "Esperad, reevaluamos en 10 min"
        try:
            r = await self.client.post(
                f"/control/tasks/{task['id']}/approve",
                json={"approved": approved, "note": note},
                headers={"X-API-Key": self.cfg.api_key},
            )
            tag = "aprobada" if approved else "rechazada"
            self.log(f"operador {tag}: {task['title']} [{r.status_code}]")
        except httpx.HTTPError as exc:
            self.log(f"!! error aprobando: {exc}")

    # ---------------------------------------------------------------- main

    async def run(self) -> None:
        if self.cfg.reset:
            try:
                r = await self.client.post(
                    "/scenario/reset", json={}, headers={"X-API-Key": self.cfg.api_key}
                )
                self.log(f"reset escenario [{r.status_code}] {r.json().get('run_id', '')}")
            except httpx.HTTPError as exc:
                self.log(f"!! no se pudo resetear: {exc}")
                return
        loops = []
        if self.cfg.events:
            loops.append(asyncio.create_task(self.world_loop()))
        if self.cfg.calls:
            loops.append(asyncio.create_task(self.calls_loop()))
        if self.cfg.approve:
            loops.append(asyncio.create_task(self.operator_loop()))
        try:
            if self.cfg.duration > 0:
                await asyncio.sleep(self.cfg.duration)
                self.stop.set()
            await asyncio.gather(*loops)
        except (KeyboardInterrupt, asyncio.CancelledError):
            self.stop.set()
        finally:
            await self.client.aclose()
            self.log("simulador detenido")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Simulador de crisis contra crisis-api")
    p.add_argument("--api-url", default=os.getenv("SIM_API_URL", "http://localhost:8000/api/v1"))
    p.add_argument("--api-key", default=os.getenv("API_KEY", "dev-secret"))
    p.add_argument("--webhook-secret", default=os.getenv("HAPPYROBOT_WEBHOOK_SECRET", ""))
    p.add_argument("--seed", type=int, default=None, help="semilla para reproducibilidad")
    p.add_argument("--min-delay", type=float, default=6.0, help="mínimo entre eventos (s)")
    p.add_argument("--max-delay", type=float, default=18.0, help="máximo entre eventos (s)")
    p.add_argument("--duration", type=float, default=720.0, help="segundos; 0 = sin fin")
    p.add_argument("--reset", dest="reset", action="store_true", default=True)
    p.add_argument("--no-reset", dest="reset", action="store_false")
    # En una demo guionizada los hechos los dispara el presentador: con --no-events el
    # simulador solo resuelve las llamadas, que es lo que pone a las unidades en marcha.
    p.add_argument("--events", dest="events", action="store_true", default=True)
    p.add_argument("--no-events", dest="events", action="store_false")
    p.add_argument("--calls", dest="calls", action="store_true", default=True)
    p.add_argument("--no-calls", dest="calls", action="store_false")
    p.add_argument("--approve", dest="approve", action="store_true", default=True)
    p.add_argument("--no-approve", dest="approve", action="store_false")
    return p.parse_args()


if __name__ == "__main__":
    cfg = parse_args()
    try:
        asyncio.run(Sim(cfg).run())
    except KeyboardInterrupt:
        pass

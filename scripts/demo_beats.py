#!/usr/bin/env python3
"""Conductor de la demo: dispara cada beat cuando lo pide quien presenta.

Sin dependencias: solo la biblioteca estándar. Lee la clave de operador y el secreto
del webhook del entorno y, si no están, de los dotenv del backend con la misma
precedencia que `Settings` (entorno > .env.local > .env). Nunca los imprime.

Uso:
    python3 scripts/demo_beats.py            # menú interactivo, un beat por señal
    python3 scripts/demo_beats.py 3 4        # dispara beats concretos y sale
    DEMO_API=http://127.0.0.1:8002/api/v1 python3 scripts/demo_beats.py

Los beats no envían comunicaciones por su cuenta: quien decide y despacha es el
agente. En modo live eso significa llamadas y Telegram reales, así que el arranque
lo avisa y pide confirmación.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DOTENVS = (ROOT / "apps/api/.env.local", ROOT / "apps/api/.env")


def dotenv_value(name: str) -> str:
    """Igual que el backend: el entorno manda, después .env.local y después .env."""
    if os.environ.get(name):
        return os.environ[name]
    for path in DOTENVS:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip() == name:
                return value.strip().strip("'\"")
    return ""


API = os.environ.get("DEMO_API", "http://127.0.0.1:8001/api/v1").rstrip("/")
API_KEY = dotenv_value("API_KEY")
WEBHOOK_SECRET = dotenv_value("HAPPYROBOT_WEBHOOK_SECRET")
# Punto equivocado que da el informante y punto bueno que corrige el operador.
WRONG_POINT = {"lat": 40.2105, "lng": -5.0901, "label": "Arenas de San Pedro (casco urbano)"}
RIGHT_POINT = {"lat": 40.1962, "lng": -5.2783, "label": "Pista del Camping El Raso, km 2"}


class Fail(RuntimeError):
    pass


def request(method: str, path: str, body: Any = None, headers: dict[str, str] | None = None) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=70) as response:
            raw = response.read().decode()
        return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode()[:400]
        raise Fail(f"{method} {path} -> {exc.code} {detail}") from exc
    except urllib.error.URLError as exc:
        raise Fail(f"{method} {path} -> sin respuesta de la API ({exc.reason})") from exc


def operator(method: str, path: str, body: Any = None) -> Any:
    if not API_KEY:
        raise Fail("falta API_KEY: exportala o déjala en apps/api/.env.local")
    return request(method, path, body, {"X-API-Key": API_KEY})


def webhook(path: str, body: Any) -> Any:
    headers = {"X-Webhook-Secret": WEBHOOK_SECRET} if WEBHOOK_SECRET else {}
    return request("POST", path, body, headers)


def state() -> dict[str, Any]:
    return request("GET", "/state")


def now_iso(offset_seconds: int = 0) -> str:
    return (datetime.now(UTC) + timedelta(seconds=offset_seconds)).isoformat()


def report_payload(run_id: str, severity: str, located: bool) -> dict[str, Any]:
    """Aviso ciudadano tal y como lo envía el workflow de intake."""
    if severity == "vital":
        return {
            "run_id": run_id,
            "timestamp": now_iso(),
            "emergency_type": "rescate",
            "severity": "vital",
            "escalation_required": True,
            "notes": "Dos personas rodeadas por el fuego en la pista alta, sin salida a pie.",
            "active_hazards": "frente de llamas a menos de 300 m",
            "location": {
                "raw_text": "Pista alta del Camping El Raso",
                "lat": 40.1931,
                "lng": -5.2812,
                "confirmed": True,
            },
            "victims": {"count": 2, "conscious": True, "trapped": True},
            "caller": {"name": "Informante en la pista", "is_victim": True},
        }
    return {
        "run_id": run_id,
        "timestamp": now_iso(),
        "emergency_type": "sanitaria",
        "severity": "grave",
        "escalation_required": True,
        "notes": "Mujer mayor con dificultad para respirar por el humo; no puede salir sola.",
        "location": {
            # Sin GPS a propósito: obliga al agente a localizar la dirección.
            "raw_text": "Camino del Raso 12, Candeleda, Ávila"
            if located
            else "cerca del camping, no sé la calle",
            "street": "Camino del Raso" if located else None,
            "number": "12" if located else None,
            "city": "Candeleda" if located else None,
        },
        "victims": {"count": 1, "conscious": True, "breathing": False},
        "caller": {"name": "Vecino del camino", "is_victim": False},
    }


def summarize(label: str = "Estado") -> None:
    meta = request("GET", "/meta")
    world = state()
    tasks: dict[str, int] = {}
    for task in world.get("tasks", []):
        tasks[task["status"]] = tasks.get(task["status"], 0) + 1
    resources: dict[str, int] = {}
    for resource in world.get("resources", []):
        resources[resource["status"]] = resources.get(resource["status"], 0) + 1
    print(f"\n{label}: {world['incident']['name']} · versión {world.get('version')}")
    print(
        f"  salidas={'reales' if meta['happyrobot_mode'] == 'live' else 'simuladas'}"
        f" persistencia={meta.get('storage')} autonomía={meta.get('autonomous')}"
        f" agente={world.get('agent', {}).get('mode')} revisor={meta.get('llm_enabled')}"
    )
    print(f"  misiones={tasks or 'ninguna'}")
    print(f"  unidades={resources or 'ninguna'}")
    for report in world.get("incoming_calls", []):
        resolution = report.get("resolution", {})
        candidates = len(resolution.get("candidates", []))
        print(
            f"  aviso {report['run_id']}: {report['emergency_type']}/{report['severity']}"
            f" ubicación={resolution.get('status')} candidatos={candidates}"
        )


def beat_estado(session: dict[str, Any]) -> None:
    summarize()


def beat_reset(session: dict[str, Any]) -> None:
    """Escenario limpio. El backend lo rechaza en modo live: allí se rota INCIDENT_ID."""
    result = operator("POST", "/scenario/reset", {"autostart_agent": True})
    session.pop("report_run_id", None)
    print(f"escenario sembrado de nuevo: {result}")


def beat_aviso(session: dict[str, Any]) -> None:
    """Aviso ciudadano sin GPS: el agente tiene que localizarlo y decidir solo."""
    run_id = f"demo-aviso-{int(time.time())}"
    result = webhook("/webhooks/happyrobot/inbound", report_payload(run_id, "grave", located=True))
    session["report_run_id"] = run_id
    print(f"aviso {run_id} aceptado: {result}")
    print("mira el dashboard: llega sin coordenadas y el bucle lo geocodifica.")


def beat_acepta(session: dict[str, Any]) -> None:
    """Resultado de la llamada: sin un 'accepted' nadie se pone en marcha."""
    world = state()
    calls = [
        action
        for action in world.get("recent_actions", [])
        if action.get("kind") == "call"
        and action.get("task_id")
        and action.get("status") in ("dispatched", "unknown")
    ]
    if not calls:
        raise Fail("no hay ninguna llamada enviada esperando resultado")
    action = calls[0]
    result = webhook(
        "/webhooks/happyrobot",
        {
            "command_id": action["id"],
            "task_id": action["task_id"],
            "outcome": "accepted",
            "eta_minutes": 12,
            "summary": "Acepta el aviso y sale hacia el punto indicado",
            "observed_at": now_iso(),
        },
    )
    print(f"orden {action['id']} aceptada: {result}")
    print("la unidad pasa a en_route; a partir de ahí el mapa la mueve.")


def beat_adaptacion(session: dict[str, Any]) -> None:
    """Viento, carretera cortada y avería: el plan de hace veinte minutos ya no vale."""
    for step, wait in ((1, 3), (3, 3), (5, 0)):
        event = operator("POST", f"/scenario/step/{step}")
        print(f"paso {step}: {event.get('title')}")
        time.sleep(wait)
    print("el agente repriorizará y cancelará lo que estos hechos invalidan.")


def beat_ruido(session: dict[str, Any]) -> None:
    """Información que no cambia nada: el plan no debe moverse.

    Solo el paso 8 es ruido. El 9, el frente contenido, sí obliga a replanificar y
    tiene su propio beat: mezclarlos haría parecer indiferente algo que no lo es.
    """
    before = len(state().get("tasks", []))
    event = operator("POST", "/scenario/step/8")
    print(f"paso 8: {event.get('title')}")
    time.sleep(6)
    after = state().get("tasks", [])
    print(f"misiones antes={before} después={len(after)}")
    print("sin misiones nuevas: quedarse con lo que importa también es decidir.")


def beat_contenido(session: dict[str, Any]) -> None:
    """Cuándo tirar el plan: si el frente se contiene, lo movilizado sobra."""
    event = operator("POST", "/scenario/step/9")
    print(f"paso 9: {event.get('title')}")
    time.sleep(6)
    cancelled = [
        task
        for task in state().get("tasks", [])
        if task.get("status") == "cancelled" and "Frente Este" in task.get("title", "")
    ]
    print(f"misiones canceladas por frente contenido: {len(cancelled)}")
    print("libera lo que ya no hace falta sin que nadie se lo pida.")


def beat_vital(session: dict[str, Any]) -> None:
    """Aviso con vidas en peligro: esto sí espera a una persona."""
    run_id = f"demo-vital-{int(time.time())}"
    result = webhook("/webhooks/happyrobot/inbound", report_payload(run_id, "vital", located=True))
    session["vital_run_id"] = run_id
    print(f"aviso vital {run_id}: {result}")
    if not result.get("requires_operator"):
        print("atención: el backend no lo ha marcado como pendiente de operador, revísalo.")


def beat_escalado(session: dict[str, Any]) -> None:
    """Sin confirmar, el sistema avisa por Telegram una sola vez y sigue esperando."""
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        pending = [
            task
            for task in state().get("tasks", [])
            if task.get("status") == "awaiting_approval" and task.get("escalated_at")
        ]
        if pending:
            print(f"escalado registrado: {pending[0]['title']} a las {pending[0]['escalated_at']}")
            print("no ha despachado: el escalado avisa, no decide.")
            return
        time.sleep(3)
    print("sin escalado en 60 s: comprueba el workflow de Telegram en /meta.")


def beat_correccion(session: dict[str, Any]) -> None:
    """El informante se equivocó de sitio: corregir el destino invalida la misión."""
    run_id = session.get("report_run_id")
    reports = {report["run_id"]: report for report in state().get("incoming_calls", [])}
    if run_id not in reports:
        run_id = next(iter(reports), None)
    if not run_id:
        raise Fail("no hay ningún aviso al que corregir la ubicación")
    report = reports[run_id]
    result = operator(
        "POST",
        f"/control/incoming-calls/{run_id}/location",
        {"expected_timestamp": report["timestamp"], "location": RIGHT_POINT},
    )
    print(f"ubicación de {run_id} confirmada por operador: {result['resolution']['status']}")
    print("cancela las órdenes de esa incidencia y replanifica; la unidad avisada no se libera.")


def beat_parada(session: dict[str, Any]) -> None:
    agent = operator("POST", "/control/pause", {})
    print(f"parada de emergencia: agente={agent['mode']}")
    print("no sale nada nuevo, ni lo retenido. Los runs ya enviados siguen su curso.")


def beat_reanudar(session: dict[str, Any]) -> None:
    meta = request("GET", "/meta")
    path = "/control/resume" if meta["happyrobot_mode"] == "live" else "/control/resume-simulated"
    agent = operator("POST", path, {})
    print(f"reactivado explícitamente con {path}: agente={agent['mode']}")


BEATS: list[tuple[str, str, Callable[[dict[str, Any]], None]]] = [
    ("estado", "Estado actual del sistema", beat_estado),
    ("reset", "Escenario limpio (solo simulado)", beat_reset),
    ("aviso", "Beat 1: aviso ciudadano sin GPS", beat_aviso),
    ("acepta", "Beat 3: la llamada se acepta y la unidad sale", beat_acepta),
    ("adaptacion", "Beat 4: viento, corte y avería", beat_adaptacion),
    ("ruido", "Beat 5: información que no cambia el plan", beat_ruido),
    ("contenido", "Beat 5b: frente contenido, se libera lo movilizado", beat_contenido),
    ("vital", "Beat 6: aviso vital que espera a una persona", beat_vital),
    ("escalado", "Beat 6b: escalado por Telegram sin despachar", beat_escalado),
    ("correccion", "Beat 7: el operador corrige el destino", beat_correccion),
    ("parada", "Beat 8: parada de emergencia", beat_parada),
    ("reanudar", "Reactivación explícita", beat_reanudar),
]


def run_beat(index: int, session: dict[str, Any]) -> None:
    name, label, action = BEATS[index]
    print(f"\n=== [{index}] {label}")
    try:
        action(session)
    except Fail as exc:
        print(f"!! {exc}")


def interactive(session: dict[str, Any]) -> None:
    print("\nBeats disponibles:")
    for index, (name, label, _) in enumerate(BEATS):
        print(f"  {index:>2}  {name:<11} {label}")
    print("\nEnter = siguiente beat · número = ese beat · q = salir")
    cursor = 2
    while True:
        try:
            choice = input(f"\n[{cursor}] {BEATS[cursor][1]} > ").strip().lower()
        except EOFError:
            return
        if choice in ("q", "salir"):
            return
        if choice.isdigit() and int(choice) < len(BEATS):
            cursor = int(choice)
        elif choice:
            match = next((i for i, beat in enumerate(BEATS) if beat[0] == choice), None)
            if match is None:
                print("beat desconocido")
                continue
            cursor = match
        run_beat(cursor, session)
        cursor = min(cursor + 1, len(BEATS) - 1)


def main() -> int:
    try:
        meta = request("GET", "/meta")
    except Fail as exc:
        print(f"!! {exc}")
        print(f"¿está la API levantada en {API}?")
        return 1
    live = meta["happyrobot_mode"] == "live"
    print(f"API {API} · salidas {'REALES' if live else 'simuladas'}")
    if live:
        print("En modo live el agente llama y escribe de verdad a los contactos sembrados.")
        if input("Escribe 'si' para continuar: ").strip().lower() != "si":
            return 1
    if not API_KEY:
        print("aviso: sin API_KEY los beats de operador y escenario fallarán.")
    if not WEBHOOK_SECRET:
        print(
            "aviso: sin HAPPYROBOT_WEBHOOK_SECRET fallarán los beats de webhook"
            " si el backend lo exige."
        )
    session: dict[str, Any] = {}
    names = sys.argv[1:]
    if not names:
        interactive(session)
        return 0
    for name in names:
        index = (
            int(name)
            if name.isdigit()
            else next((i for i, beat in enumerate(BEATS) if beat[0] == name), -1)
        )
        if not 0 <= index < len(BEATS):
            print(f"beat desconocido: {name}")
            return 1
        run_beat(index, session)
    return 0


if __name__ == "__main__":
    sys.exit(main())

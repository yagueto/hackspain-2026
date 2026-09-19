# HackSpain 2026 — ¿Puede la IA gestionar una crisis?

Sistema agéntico de gestión de emergencias (incendio forestal) construido sobre la plataforma
[HappyRobot](https://happyrobot.ai) para las llamadas, mensajes y extracción de datos de las
interacciones con vecinos, bomberos, ambulancias, policía y responsables.

## Estructura

```
apps/
  api/        FastAPI: estado global, orquestador agéntico, integración HappyRobot, SSE
  web/        Dashboard (Next.js)  — pendiente
  simulator/  Generador de eventos que "mueve" la crisis — pendiente
docs/         Notas de arquitectura y demo
```

Cada app es autocontenida (su propio `pyproject.toml` / `package.json`). Ver el README de cada una.

## Arranque rápido (API)

```bash
cd apps/api
cp .env.example .env      # por defecto: demo en memoria y comunicaciones simuladas
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

Docs interactivas en http://localhost:8000/docs

La persistencia duradera usa **HappyRobot Twin**. Los agentes insertan observaciones y el
backend consolida el world state, reserva recursos y envía órdenes mediante una outbox.
Configuración, migración y pruebas: [API](apps/api/README.md).
Contrato de datos y decisiones: [arquitectura](docs/architecture.md).

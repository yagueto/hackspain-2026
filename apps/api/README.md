# crisis-api

Backend FastAPI del sistema de gestión de crisis.

```bash
uv sync
cp .env.example .env
uv run uvicorn app.main:app --reload --port 8000
uv run pytest
uv run ruff check . && uv run mypy app
```

## Modos y arranque

El ejemplo usa `STORAGE_BACKEND=memory` y `HAPPYROBOT_MODE=simulated`: no necesita credenciales
y no llama a teléfonos. El estado se pierde al cerrar el proceso. `AGENT_AUTOSTART=false`
permite avanzar con `POST /api/v1/control/tick`; el polling de observaciones sigue activo.
Pausar el agente conserva la sincronización y bloquea los nuevos envíos.

Para Twin:

1. Configura `STORAGE_BACKEND=twin`, `HAPPYROBOT_API_KEY`, `HAPPYROBOT_CLUSTER`,
   `INCIDENT_ID` y `SEED_DEMO=false`. Mantén `HAPPYROBOT_MODE=simulated` para validar
   persistencia sin llamadas. Twin usa el espacio de la organización/región de la API key;
   `HAPPYROBOT_ENVIRONMENT` selecciona el entorno de workflows, no otra base de Twin.
2. `uv run python -m app.store.migrate` inspecciona el schema sin modificarlo.
   Comprueba región, permisos y colisiones de nombres `crisis_*` en la salida.
3. `uv run python -m app.store.migrate --apply` crea el schema v1 idempotentemente.
   No borra tablas ni convierte una tabla existente con columnas incompatibles.
4. Arranca la API. Restaura el snapshot de `INCIDENT_ID` si existe. En caso contrario,
   `POST /api/v1/control/incident` con `X-API-Key` recibe un `WorldSnapshot` inicial
   (esquema en `/docs`), con catálogos, clima y todas las listas de histórico/tareas vacías.
   El `incident.id` debe coincidir con `INCIDENT_ID`.
5. Para una demo sobre Twin usa explícitamente `SEED_DEMO=true` y `/scenario/reset`;
   devuelve un ID nuevo, conserva el incidente anterior y no inicia llamadas reales.
   Guarda ese ID como `INCIDENT_ID` para recuperarlo en el siguiente arranque.
6. Para comunicaciones reales configura `HAPPYROBOT_MODE=live`, los cuatro workflows,
   `HAPPYROBOT_WEBHOOK_SECRET`, una `API_KEY` propia y `PUBLIC_BASE_URL` accesible desde
   HappyRobot. El backend rechaza `live` con memoria o sin secret del webhook.

La migración usa SQL de PostgreSQL mediante `POST /twin/sql`; no necesita conexión directa.
El schema y las operaciones atómicas se prueban con PostgreSQL 17 tras un transporte HTTP
simulado. Falta validar permisos, límites y admisión de estas sentencias en el Twin del equipo
con su credencial antes de activar llamadas reales.

## Prueba del circuito sin llamadas

Desde otro terminal, con el servidor local arrancado y el agente en modo manual:

```bash
curl -X POST http://localhost:8000/api/v1/control/tick -H 'X-API-Key: dev-secret'
curl http://localhost:8000/api/v1/actions
```

Elige una acción `call` con `status=dispatched` y copia su ID:

```bash
curl -X POST http://localhost:8000/api/v1/webhooks/happyrobot \
  -H 'Content-Type: application/json' \
  -d '{"command_id":"ACT_ID","observation_id":"demo-respuesta-1",
       "outcome":"accepted","eta_minutes":12,"summary":"Salimos ahora"}'
curl http://localhost:8000/api/v1/state
curl -H 'X-API-Key: dev-secret' http://localhost:8000/api/v1/receipts
```

Si configuraste `HAPPYROBOT_WEBHOOK_SECRET`, añade `X-Webhook-Secret`.
Reenviar el mismo cuerpo no crea otra asignación. El fake no genera callbacks automáticamente.
El guion de demo continúa disponible en `/api/v1/scenario/script` y `/scenario/step/{n}`.

## Pruebas y calidad

```bash
uv run ruff check .
uv run ruff format --check .
uv run mypy app
uv run pytest -q
```

Las pruebas SQL necesitan una base de **desarrollo**. Cada test crea y elimina su propio schema:

```bash
docker run --name crisis-test -d -p 127.0.0.1:55432:5432 \
  -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=crisis_test postgres:17.6
TEST_POSTGRES_DSN=postgresql://postgres:local-test-only@localhost:55432/crisis_test \
  uv run pytest -q
```

CI incluye este servicio. Sin `TEST_POSTGRES_DSN`, las pruebas de PostgreSQL se marcan
como omitidas; las de dominio, API y errores HTTP se ejecutan igualmente.

Contrato y límites: [arquitectura](../../docs/architecture.md).

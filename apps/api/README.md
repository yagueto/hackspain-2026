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

### PostgreSQL (persistencia duradera)

Desde `apps/api`:

```bash
docker compose up -d --wait postgres
export STORAGE_BACKEND=postgres
export DATABASE_URL=postgresql://crisis:local-dev-only@127.0.0.1:55433/crisis
export HAPPYROBOT_MODE=simulated AGENT_AUTOSTART=false
uv run python -m app.store.migrate --apply
uv run uvicorn app.main:app --host 127.0.0.1 --port 8001
```

La contraseña de Compose es exclusivamente para desarrollo local. Cambia `POSTGRES_PASSWORD`
y `DATABASE_URL` antes de desplegar; no publiques el puerto de la base de datos. Compose
expone únicamente `127.0.0.1:55433` y guarda los datos en un volumen persistente.
`docker compose stop` conserva los datos; no elimines el volumen si quieres conservarlos.

Puedes guardar estos ajustes en `.env.local` (ignorado por Git), sin copiar allí las API keys.
La precedencia es: variables del proceso > `.env.local` > `.env` > valores por defecto.
Para probar sin revisión LLM remota configura además `OPENAI_API_KEY=` en el entorno.

La migración crea el esquema v1 idempotentemente y rechaza tablas incompatibles. Sin `--apply`
solo inspecciona. El arranque exige un esquema migrado: no degrada silenciosamente a memoria
si PostgreSQL falla. `SEED_DEMO=true` crea el escenario solo si el incidente no existe; los
siguientes arranques restauran tareas, acciones, asignaciones, recibos e histórico.
`STORE_POLL_SECONDS` y `STORE_BATCH_SIZE` controlan la sincronización.

Para datos no simulados usa `SEED_DEMO=false` e inicializa el catálogo mediante
`POST /api/v1/control/incident` con `X-API-Key`. El `incident.id` debe coincidir con `INCIDENT_ID`.
HappyRobot atiende llamadas y avisos: configura los tres `HAPPYROBOT_WF_CALL_*` /
`HAPPYROBOT_WF_NOTIFY_AUTHORITY`, `HAPPYROBOT_WF_TELEGRAM`, `HAPPYROBOT_WEBHOOK_SECRET` y una
URL pública antes de activar `HAPPYROBOT_MODE=live`. El entorno de workflows debe ser
`development` durante pruebas.

La persistencia no necesita una API key de HappyRobot: solo las llamadas y los avisos la usan.
`integrations.storage` refleja el estado del store.

### Avisos de Telegram por workflow

`POST /api/v1/control/telegram`, autenticado con `X-API-Key`, recibe:

```json
{"contact_id":"ct_camping","message":"Aviso de prueba"}
```

El `kind` de la acción es `telegram` y su `workflow` es `send_telegram`: el backend **no habla
con la API de Telegram ni con un puente propio**, solo dispara el workflow con
`HAPPYROBOT_WF_TELEGRAM` y espera el resultado. No queda ningún canal SMS.

El aviso viaja por el mismo outbox que las llamadas, así que hereda expiración a diez minutos,
reintentos acotados, `unknown` ante respuestas ambiguas y bloqueo mientras el agente está en
pausa. Con `HAPPYROBOT_MODE=simulated` no sale ninguna petición: el fake responde un `run_id`.

Payload que recibe el trigger del workflow:

```json
{
  "channel":"telegram",
  "command_id":"act_...",
  "action_id":"act_...",
  "incident_id":"incendio-gredos-demo",
  "contact_id":"ct_camping",
  "contact_name":"Contacto del escenario",
  "message":"Aviso de prueba",
  "callback_url":"http://localhost:8000/api/v1/webhooks/happyrobot"
}
```

No incluye teléfono ni `chat_id`: un teléfono no es un chat de Telegram y hoy el chat lo
resuelve el workflow. La acción queda `dispatched` al disparar el run y solo pasa a
`completed`/`failed` cuando llega la observación `message_outcome` del workflow, de modo que
`POST /control/actions/{id}/reconcile` también sirve para un aviso. Un aviso entregado **no**
mueve la fiabilidad del contacto: eso solo lo hacen las llamadas, porque pondera la selección
de medios. Una orden cuyo `workflow` no corresponde a su `kind` falla en vez de reenrutarse.

### Workflow en HappyRobot

`Crisis - Aviso Telegram` (`01a0b9ec-2f1d-7881-b454-ddc2fd8b5f4b`, slug `5qqqelh3rij6`), v2
publicada en **development**, en la carpeta de los workflows de crisis:

```text
Entrada de aviso → Enviar mensaje a Telegram → Reportar entrega al backend
```

- `Enviar mensaje a Telegram`: POST a `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/sendMessage`
  con `{"chat_id":<TELEGRAM_CHAT_ID>,"text":<message>}`.
- `Reportar entrega al backend`: POST al `callback_url` del trigger con `X-Webhook-Secret` y
  `command_id`, `action_id`, `contact_id`, `observation_id` estable (`tg-<command_id>`),
  `run_id`, `observed_at` y `outcome=accepted`. El `run_id` y el `contact_id` los verifica
  el backend contra la orden, así que un callback descorrelacionado se rechaza.

Variables del workflow, ocultas: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` y `WEBHOOK_SECRET`
(debe coincidir con `HAPPYROBOT_WEBHOOK_SECRET` del backend). Se configuran en HappyRobot, no
en los dotenv, y por entorno.

**Publicar es por entorno.** Una versión live en `production` no la usan los runs de
`development`: el backend dispara con `HAPPYROBOT_ENVIRONMENT`, así que la versión debe estar
publicada en ese entorno o seguirá ejecutándose la anterior. Para republicar hay que
despublicar primero; `publish` falla con "Version is already live" si la versión ya está viva
en otro entorno.

Límites conocidos:

- `TELEGRAM_CHAT_ID` es único, así que **todos los avisos caen en el mismo chat** sea quien sea
  el contacto; `contact_id` y `contact_name` viajan en el payload para poder mover el mapeo
  contacto→chat al backend sin cambiar el contrato. Requiere dar de alta cada chat por `/start`.
- El nodo de reporte envía `outcome=accepted` fijo, y es correcto: solo se ejecuta si el nodo
  de Telegram tuvo éxito, así que nunca afirma una entrega que no ocurrió. Lo que falta es el
  negativo: si Telegram rechaza (400 `chat not found`, 403 si bloqueó al bot) el run muere antes
  de reportar y la acción se queda `dispatched`. `reconcile` la deja en `unknown` con el motivo,
  no en `failed`. **No se puede ramificar** para arreglarlo: un nodo hijo solo se ejecuta si el
  padre tuvo éxito, y el nodo POST solo expone `error` como variable, no `status_code` ni
  `response`, al contrario de lo que anuncia la documentación del MCP.
- `test_all` valida estructura y referencias de variables, no envíos reales; un nodo
  "skipped — success" no se ha ejecutado. El circuito completo sí se ha verificado a mano con
  envíos reales a Telegram y callback entrante por túnel público.

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

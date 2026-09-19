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

### PostgreSQL (persistencia recomendada, sin Twin)

Desde `apps/api`:

```bash
docker compose up -d --wait postgres
export STORAGE_BACKEND=postgres
export DATABASE_URL=postgresql://crisis:local-dev-only@127.0.0.1:55433/crisis
export HAPPYROBOT_MODE=simulated TELEGRAM_MODE=simulated AGENT_AUTOSTART=false
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
HappyRobot queda dedicado a las llamadas: configura los tres `HAPPYROBOT_WF_CALL_*` /
`HAPPYROBOT_WF_NOTIFY_AUTHORITY`, `HAPPYROBOT_WEBHOOK_SECRET` y una URL pública antes de
activar `HAPPYROBOT_MODE=live`. El entorno de workflows debe ser `development` durante pruebas.

El adaptador Twin anterior se conserva por compatibilidad, pero PostgreSQL no llama a Twin
ni necesita una API key de HappyRobot. `integrations.storage` refleja el estado del store.

### Telegram por webhook (sustituye SMS)

`POST /api/v1/control/telegram`, autenticado con `X-API-Key`, recibe:

```json
{"contact_id":"ct_camping","message":"Aviso de prueba"}
```

`/control/sms` es un alias obsoleto del mismo envío; ya no inicia workflows SMS. El nuevo
`kind` de la acción es `telegram`. `HAPPYROBOT_WF_SMS` ya no se utiliza.

Con `TELEGRAM_MODE=simulated` no se hace ninguna petición. Para usar un puente existente
(por ejemplo n8n), configura localmente `TELEGRAM_MODE=live`, `TELEGRAM_WEBHOOK_URL` (HTTPS)
y, si tu puente lo acepta, `TELEGRAM_WEBHOOK_SECRET` para el header `X-Webhook-Secret`.
La URL y el secret no se incluyen en acciones, respuestas API ni logs de peticiones.

Contrato JSON compartido por el backend y el borrador del workflow HappyRobot. El puente
externo debe implementar este contrato; su URL y la resolución del chat siguen pendientes:

```json
{
  "channel":"telegram",
  "command_id":"act_...",
  "action_id":"act_...",
  "incident_id":"incendio-gredos-demo",
  "contact_id":"ct_camping",
  "contact_name":"Contacto del escenario",
  "message":"Aviso de prueba"
}
```

El POST incluye `Idempotency-Key: <command_id>`. El puente debe deduplicar por esa clave y
resolver el chat de destino; un teléfono no es un chat_id de Telegram. Un HTTP 2xx completa
la entrega **al webhook**, no acredita entrega en Telegram ni aceptación de una tarea:
`result.delivery_confirmed` permanece `false`. No se guarda el cuerpo de respuesta del puente.
Timeouts tras enviar y HTTP 5xx quedan `unknown`, sin reenvío automático. Fallos de conexión
anteriores al envío y HTTP 429 se reintentan como máximo tres veces. No se siguen redirecciones.
La pausa del agente también bloquea estos envíos. Una orden histórica `sms` pendiente no
se transforma ni se reenvía silenciosamente a otro canal.

### Borrador equivalente en HappyRobot

En el workflow `Crisis - SMS a contacto` (`01a0b95f-2b86-77e7-966b-5d295bc4b499`) se ha
preparado la v2 `Telegram por webhook - pendiente de configurar`
(`01a0b9c1-fd0f-7637-bcc9-2d72eb04ce7b`), **sin publicar**. La v1 publicada en development
se ha conservado y todavía envía SMS; no usarla para probar Telegram.

El borrador contiene únicamente `Entrada de mensaje Telegram → Enviar Telegram por webhook`.
Su trigger recibe los siete campos del JSON anterior; `channel` se fija a `telegram` en el POST.
No necesita teléfono, credenciales SMS ni `callback_url`. No envía un resultado operativo al
backend: un HTTP 2xx del puente no demuestra entrega al destinatario.

Las variables del workflow `TELEGRAM_WEBHOOK_URL` y `TELEGRAM_WEBHOOK_SECRET` están ocultas
y vacías en todos los entornos. Antes de publicar, configurar una URL HTTPS del puente y
su secreto, si lo requiere. El nodo envía `Idempotency-Key: <command_id>` y
`X-Webhook-Secret`; si el puente no utiliza secreto, se puede retirar este último header.
El puente debe resolver el chat mediante `contact_id` y deduplicar por `command_id`.

El backend continúa enviando directamente al puente; **no inicia este workflow**. Son dos
entradas alternativas con el mismo contrato, no dos pasos consecutivos: no enviar una misma
orden por ambas. La configuración de variables en HappyRobot es independiente de los dotenv
del backend. No se han ejecutado envíos reales; falta validar el circuito con el puente
cuando esté configurado y se autorice una prueba.

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

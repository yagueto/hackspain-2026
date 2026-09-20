# Arquitectura: persistencia, world state y orquestador

```text
HappyRobot: llamadas, mensajes, agentes
      │ observación por HTTP                ▲ trigger / signals / cancel
      ▼                                     │
PostgreSQL (esquema crisis v1) ◄────────► FastAPI
  crisis_observations                       polling + validación + recibos
  crisis_receipts                           proyección WorldState en memoria
  crisis_world                              planner + revisión LLM opcional
  crisis_assignments                        reservas + aprobación humana
  crisis_commands                           outbox persistente
  crisis_journal                            │
      ▲                                     ▼
      └── ingesta HTTP / webhook ◄── simulador / dashboard (SSE + controles)
```

## Propiedad de datos y persistencia

Los agentes no escriben en la base: aportan **solo observaciones** por HTTP y el backend las
traduce a `crisis_observations`. El backend es el dueño del estado consolidado, las
asignaciones, decisiones, recibos y órdenes. Se conserva el informe original y se emite una
observación nueva para corregirlo, sin editar el anterior. La credencial de PostgreSQL es
exclusiva del backend; no se reparte a los agentes ni al dashboard.

`crisis_world` guarda un snapshot versionado por incidente. `WorldState` es su proyección
local y puede recuperarse al reiniciar. El dashboard recibe un extracto reciente, mientras
que la persistencia incluye todas las tareas y órdenes, también pendientes y ambiguas.
Los eventos y decisiones en memoria se limitan a 2.000 y 500; `crisis_journal` conserva el resto.

La versión v1 usa una única sentencia SQL con CTEs para guardar conjuntamente snapshot,
recibos, asignaciones, comandos y journal. La actualización exige `version = expected_version`.
Un conflicto revierte la propuesta local: no se publica por SSE ni se envía a HappyRobot.
Al decidir o reclamar un envío también se comprueba, en la misma sentencia, que no haya
observaciones pendientes. Esto evita enviar una orden con datos que llegaron entre el último
poll y el guardado. Dos escritores del mismo incidente no pueden confirmar la misma versión.

El comportamiento SQL está probado sobre PostgreSQL 17, con un schema temporal por test.
No se asumen CDC, triggers ni `LISTEN/NOTIFY`. Cada consulta abre su conexión con
`statement_timeout = 15s`. `HAPPYROBOT_ENVIRONMENT` afecta a los workflows, no a la base.
Los IDs de incidente aíslan escenarios dentro de la misma base.

## Contrato que escriben los agentes

Fila en `crisis_observations`:

| Columna | Valor |
|---|---|
| `observation_id` | ID estable y global; mismo ID en todos los reintentos |
| `incident_id` | incidente objetivo |
| `body` | objeto JSON completo siguiente |
| `received_at` | dejar el valor por defecto del servidor |

```json
{
  "observation_id": "obs-llamada-123-resultado-1",
  "schema_version": 1,
  "incident_id": "incendio-gredos-demo",
  "kind": "call_outcome",
  "observed_at": "2026-09-19T10:00:00Z",
  "source": "happyrobot",
  "source_run_id": "RUN_ID",
  "command_id": "ACT_ID",
  "title": "La ambulancia acepta la misión",
  "severity": "high",
  "payload": {
    "outcome": "accepted",
    "eta_minutes": 12,
    "summary": "Salimos ahora"
  }
}
```

Los IDs del envelope y de la fila deben coincidir. `observed_at` lleva zona horaria y representa
el momento de observación, no el momento de un reintento. Los agentes deben enviarlo siempre.
`entity_id` es metadato opcional; la referencia operativa va en el payload indicado aquí:

| `kind` | Payload |
|---|---|
| `fire_spread` | `front_id`; opcionales `heading_deg`, `speed_kmh`, `intensity`, `contained_pct`, `threatens: {zone_id: eta_minutes}` |
| `wind_change` | `wind_from_deg`, `wind_kmh` |
| `road_blocked`, `road_open` | `road_id`, opcional `reason` |
| `injured_reported`, `civilians_reported` | `count`, con `zone_id` en envelope o payload |
| `resource_status` | `resource_id`, `status`, opcionales `eta_minutes`, `task_id` |
| `call_outcome`, `message_outcome` | resultado correlacionado, descrito más abajo |
| `integration_down`, `integration_up` | `name: happyrobot` o `llm` |
| `note` | texto en `title`, payload opcional |

Los contadores son valores absolutos. Los informes `resource_status` guardan `reported_status`
y `reported_at` sin sobrescribir una reserva activa. `reserved` pertenece al backend.
Para confirmar disponibilidad tras una misión hay que incluir su `task_id`; un informe de
otra misión o anterior a la reserva no libera la unidad. Marcar una tarea `done` tampoco
demuestra por sí mismo que el vehículo esté disponible.

La API ofrece `POST /api/v1/observations` con el mismo envelope y `X-API-Key`.
`POST /events`, `/events/batch`, el simulador y el webhook se convierten al mismo contrato.
Una respuesta `202` confirma recepción; el resultado de aplicación se consulta en
`GET /api/v1/receipts`, con `X-API-Key`. Un ID repetido con otro contenido se rechaza.

## Sincronización y datos atrasados

Cada `STORE_POLL_SECONDS` se consultan observaciones sin recibo, ordenadas por
`received_at, observation_id`, con límite `STORE_BATCH_SIZE`. Se guardan por lotes y la consulta
siguiente excluye los recibos ya confirmados. No se usa un cursor temporal que pueda saltarse
inserciones concurrentes con fechas antiguas. Tras 20 lotes se continúa en la siguiente vuelta,
sin despachar mientras queden datos pendientes. Un error o timeout de la base detiene la
operación, marca `integrations.storage` como caído y bloquea el despacho.

Cada observación se valida sobre una copia. Incidentes/referencias desconocidos, tipos o rangos
inválidos y fechas futuras generan un recibo `invalid`; la copia se descarta. Se comparan relojes
por frente, carretera, recurso o tipo de contador; los datos atrasados generan `ignored`.
Las notas se conservan aunque lleguen tarde. Solo después del guardado atómico se publica el
nuevo world state.

Los hechos derivados de un callback (heridos, carretera, recurso) tienen IDs deterministas y
se validan en la misma transacción que su observación raíz. Quedan en snapshot/journal,
con un único recibo raíz; no necesitan otra inserción en la bandeja de entrada.
Un callback con heridos pero sin zona identificable conserva el aviso con
`location_unconfirmed=true`; un operador debe aportar la ubicación antes de asignar asistencia.

## Decisiones y reservas

1. Sincronizar y leer una versión coherente del incidente.
2. Reevaluar tareas vigentes: destino, contención, amenaza y disponibilidad del recurso.
3. Crear propuestas de asistencia, extinción, avisos, evacuación, albergues y carreteras.
4. Opcionalmente revisar prioridades, resumen, descartes y recurso sugerido con un LLM.
5. Revalidar observaciones nuevas y comprobar en código tipos de unidad, contacto, reserva,
   disponibilidad y acceso. El LLM no envía órdenes ni escribe asignaciones.
6. Ordenar por prioridad y seleccionar medios considerando ETA, distancia aproximada,
   capacidad, fiabilidad del contacto y cobertura restante. Ambulancias/autobuses sin capacidad
   declarada no se asignan. Se asigna un recurso por tarea; la cobertura es una preferencia,
   no un cálculo de flota óptima.
7. El agente decide solo. Únicamente lo crítico —avisos `vital` y evacuaciones, según
   `AgentConfig.approval_required_severities` y `approval_required_for`— queda
   `awaiting_approval`, sin reservar ni llamar; a los `escalate_after_seconds` sin
   confirmar se avisa una vez por Telegram y se sigue esperando. Lo demás reserva y
   prepara la orden al instante, retenida `hold_seconds` para que el operador pueda
   anularla. Una aprobación asigna contra el estado actual, no contra el plan original.
8. Confirmar decisión, reserva y orden `pending` en la base. Rechazar una evacuación impide que
   el siguiente tick vuelva a crearla automáticamente; el operador puede crear una tarea nueva.
9. Reclamar y revalidar cada envío, guardar `sending` e invocar HappyRobot.
10. Registrar resultado y volver a percibir. Viento y cortes generan Signals para las
    conversaciones suscritas a `crisis.update`.

El modelo de carreteras comprueba accesos abiertos al destino; no calcula rutas completas.
Una carretera que cambia provoca replanificación/señales y bloquea órdenes terrestres
pendientes sin acceso. Las misiones ya en marcha requieren confirmación humana/conversacional
para reasignarlas; no se declara libre una unidad por cancelar su llamada.

## Outbox y resultados HappyRobot

```text
pending → sending → dispatched → completed / failed
                  ↘ unknown
pending → skipped (tarea invalidada, rechazo o caducidad)
```

El estado de una acción describe la **comunicación**. Una llamada aceptada puede estar
`completed` mientras la tarea sigue `accepted` y la unidad `en_route`.

El payload del workflow incluye `command_id` (= `action_id`), `task_id`, `resource_ids`,
`incident_id`, `world_state_version`, contacto/teléfono, instrucciones, clima, carreteras,
`observations_table` y `callback_url`. Workflows: `call_responder`, `call_civilian`,
`notify_authority`, `send_telegram`. Los avisos de texto usan `send_telegram`: el backend
dispara el workflow y es el workflow quien hace el POST a la API de Telegram. El backend no
habla con Telegram ni con ningún puente intermedio. El payload de un aviso lleva solo
`command_id`, `action_id`, `channel`, `message`, `contacto`, `incident_id` y `callback_url`;
el chat de destino lo resuelve HappyRobot, porque un teléfono no es un chat de Telegram.
Una orden con un workflow que no corresponde a su `kind` falla en vez de cambiar de canal.

El agente reporta el resultado con `POST /api/v1/webhooks/happyrobot` y `X-Webhook-Secret`:

```json
{
  "observation_id": "obs-llamada-123-resultado-1",
  "command_id": "ACT_ID",
  "run_id": "RUN_ID",
  "observed_at": "2026-09-19T10:00:00Z",
  "outcome": "accepted",
  "eta_minutes": 12,
  "summary": "Salimos ahora"
}
```

También admite `task_id` si solo hay una comunicación correlacionable y los campos
`injured_count`, `civilians_count`, `road_blocked`, `evacuation_confirmed`, `resource_status`,
`shelter_capacity`, `session_id`, `transcript`, `extra`.
`outcome`: `accepted`, `rejected`, `no_answer`, `voicemail`, `busy`, `failed`, `info`.
La correlación se comprueba; no basta con citar una tarea distinta. Para información posterior
usa una observación nueva con `outcome=info` y fecha nueva.

Sin ID explícito el webhook calcula uno estable del cuerpo. Sin fecha usa la de creación
de la orden para conservar compatibilidad y no dejar que un callback tardío libere una misión
posterior. Los agentes nuevos deben enviar ID y fecha explícitos. Si se combinan el webhook y
`POST /api/v1/observations` para la misma observación, hay que normalizar exactamente el mismo
envelope; lo recomendado es elegir una vía por workflow.

Un fallo de conexión previo al envío o un `429` tiene como máximo tres intentos con espera.
Timeouts tras enviar, respuestas malformadas y errores POST `5xx` quedan `unknown` y no se
reenvían automáticamente. Los comandos `sending` encontrados al arrancar pasan a `unknown`.
Las órdenes pendientes se recuperan y se envían al reanudar el agente; con
`AGENT_AUTOSTART=false` se necesita un tick manual. Las comunicaciones caducan en diez minutos
antes de su primer envío (señales en dos).

`POST /control/actions/{id}/reconcile` consulta un `run_id` conocido sin reenviar.
Un run terminado sin resultado operativo conserva la incertidumbre y la reserva.
Si falta el run ID, hay que localizar `command_id` en HappyRobot y aportar una observación
correlacionada; no existe un botón de reenvío ciego. Un reinicio concurrente puede marcar
`unknown` un envío de otro proceso todavía activo; esto es conservador y evita duplicarlo.

## API del dashboard e intervención

Todos los endpoints cuelgan de `/api/v1`:

- `/state`, `/tasks`, `/resources`, `/contacts`, `/actions`, `/decisions`, `/timeline`.
- `/stream`: snapshot inicial y snapshots confirmados; `id` SSE y `version` coinciden.
  Al reconectar se recibe otro snapshot, sin replay de deltas. Ante un hueco o `resync`,
  descargar `/state`. No aplicar snapshots más antiguos que el que ya se muestra.
- `/control/pause` (parada de emergencia: frena también las órdenes retenidas, sin cancelar
  lo ya enviado), `/resume`, `/tick`, `/agent` (autonomía, frontera crítica, ventanas).
- `/control/tasks`, `/tasks/{id}/approve`, `/priority`,
  `/status` (con `cancelled` es el override de una decisión automática: anula la orden
  no enviada y libera la unidad).
- `/control/call`, `/telegram`, `/note`,
  `/actions/{id}/reconcile` (sirve también para avisos, que ahora tienen `run_id`).
- `/control/incident`: inicialización explícita, solo si no hay incidente activo.
- `/history/runs`, `/history/runs/{id}/journal`, `/history/lessons`.

Escrituras y control requieren `X-API-Key`; el webhook usa su propio secret.
El esquema OpenAPI de `/docs` describe los campos completos. El dashboard no debe mutar
las tablas del backend. `MemoryStore` conserva estos contratos para una demo sin credenciales;
no persiste tras cerrar el proceso. Configuración y comandos: [API](../apps/api/README.md).

## Límites operativos de esta versión

El despliegue previsto es un único proceso activo por incidente; CAS protege escrituras
concurrentes, pero no hay elección de líder ni leases distribuidos. El snapshot crece con
tareas/órdenes: cada guardado reescribe el JSON completo, así que un incidente largo puede
agotar el `statement_timeout` y exige archivar o evolucionar la proyección. Los endpoints de
histórico devuelven hasta 250 entradas (50 incidentes), y los recibos hasta 250.
La persistencia no convierte la heurística demo en un motor geográfico ni valida protocolos
operativos de emergencias. Frontend, simulador físico y despliegue público quedan separados.

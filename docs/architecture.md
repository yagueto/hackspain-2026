# Arquitectura

```
┌──────────────────────┐        ┌──────────────────────┐
│  apps/simulator      │        │  apps/web (Next.js)  │
│  guion de la crisis  │        │  dashboard + control │
└─────────┬────────────┘        └─────────▲────────────┘
          │ POST /events                  │ GET /stream (SSE), /state
          ▼                               │
┌─────────────────────────────────────────┴────────────┐
│  apps/api  (FastAPI)                                  │
│  1. WorldState en memoria (zonas, frentes, medios…)   │
│  2. Orquestador: percibir→filtrar→priorizar→actuar    │
│     · planner.py  plan determinista (siempre)         │
│     · llm.py      revisión LLM (opcional)             │
│     · executor.py acciones reales                     │
│  3. SQLite: journal + lessons (aprende entre runs)    │
└──────┬───────────────────────────────────────▲───────┘
       │ POST /workflows/{id}/runs               │ POST /api/v1/webhooks/happyrobot
       │ POST /signals/  (contexto a llamadas    │ (variables extraídas de la llamada)
       ▼  en curso)                              │
┌──────────────────────────────────────────────────────┐
│  HappyRobot                                          │
│  workflows: call_responder · call_civilian ·         │
│             notify_authority · sms                   │
└──────────────────────────────────────────────────────┘
```

## Ciclo del orquestador (`app/agent/orchestrator.py`)

Se despierta cuando entra un evento o cada `AGENT_TICK_SECONDS`:

1. **Percibir** — `apply_event` muta el mundo y devuelve *hechos* ("Candeleda pasa a crítico").
   Un evento sin hechos es ruido → `relevant=false`.
2. **Replanificar** — `replan_needed` detecta tareas que ya no valen (frente contenido, medio
   averiado, carretera cortada, cambio de viento). Se cancelan y se avisa a las llamadas en curso
   con una *signal* de HappyRobot.
3. **Priorizar** — `propose` genera tareas con prioridad 0-100 y su razón, contando solo con los
   medios disponibles. Si hay `OPENAI_API_KEY`, el LLM revisa: filtra eventos, reordena, descarta
   y resume. Recibe también las *lecciones* de ejecuciones anteriores.
4. **Actuar** — `Executor` asigna el medio más fiable, y dispara el workflow de HappyRobot que
   toca según el rol del contacto. Las tareas de `approval_required_for` (por defecto evacuar)
   quedan `awaiting_approval` hasta que el operador las apruebe.
5. **Explicar** — cada vuelta deja una `Decision` (resumen, prioridades, acciones, descartes).

## Contrato con HappyRobot

### Lo que enviamos al disparar un workflow (`payload`)

```json
{
  "task_id": "task_ab12", "task_kind": "dispatch_resource", "task_title": "...",
  "instructions": "...", "priority": 90,
  "contact_id": "ct_bomb1", "contact_name": "Sgto. Ruiz", "contact_role": "firefighter",
  "phone": "+34...", "language": "es",
  "incident": "Incendio forestal Sierra de Gredos", "zone": "Poyales del Hoyo",
  "zone_status": {...}, "weather": {...}, "threats": ["Frente Sur llega a Poyales en 40 min"],
  "roads_closed": ["AV-923"],
  "callback_url": "https://<PUBLIC_BASE_URL>/api/v1/webhooks/happyrobot"
}
```

### Lo que el workflow nos devuelve (último nodo → webhook)

`POST /api/v1/webhooks/happyrobot` con header `X-Webhook-Secret` y JSON:

| campo | tipo | uso |
|---|---|---|
| `task_id` | str | enlaza con la tarea (o `run_id` / `action_id`) |
| `outcome` | accepted · rejected · no_answer · voicemail · busy · failed · info | estado de la tarea y fiabilidad del contacto |
| `eta_minutes` | float | ETA del medio |
| `injured_count` | int | genera evento `injured_reported` → ambulancia |
| `civilians_count` | int | actualiza personas presentes |
| `road_blocked` | str | genera evento `road_blocked` → replan |
| `evacuation_confirmed` | bool | zona pasa a `in_progress` |
| `resource_status` | enum | estado del medio |
| `shelter_capacity` | int | capacidad del albergue |
| `summary`, `transcript` | str | contexto para el dashboard |

Todo es opcional salvo el enlace: cualquier variable extra va en `extra`.

## Intervención humana

- `POST /control/pause` · `/resume` · `/tick`
- `POST /control/tasks/{id}/approve` `{approved, note}`
- `POST /control/tasks/{id}/priority` · `/status`
- `POST /control/tasks` (tarea manual) · `/call` · `/sms` · `/note`
- `PATCH /control/agent` `{approval_required_for, tick_seconds}`

## Demo

```bash
curl -X POST localhost:8000/api/v1/scenario/reset -H 'X-API-Key: dev-secret' \
  -H 'content-type: application/json' -d '{"phones": {"firefighter": "+34600..."}}'
curl localhost:8000/api/v1/scenario/script          # guion de 10 pasos
curl -X POST localhost:8000/api/v1/scenario/step/2 -H 'X-API-Key: dev-secret'  # el viento rola
curl -N localhost:8000/api/v1/stream                 # SSE
```

Sin `HAPPYROBOT_API_KEY` se usa un cliente simulado que registra las llamadas en el log; el
webhook se puede invocar a mano para cerrar el bucle.

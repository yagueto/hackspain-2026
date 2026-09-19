# crisis-simulator

Genera el "mundo" de la demo: eventos aleatorios con cadencia realista y
respuestas simuladas a las llamadas y avisos que el agente dispara vía HappyRobot.

```bash
uv sync
uv run python simulator.py                # resetea el escenario y corre 12 min
uv run python simulator.py --seed 7 --min-delay 3 --max-delay 8
```

## Qué hace

- **Eventos del mundo** → `POST /events`. El tipo se sortea con pesos que
  dependen de la fase de la crisis:
  - *ignición* (0–2 min): avisos de civiles, rumores, primeros partes de fuego
  - *escalada* (2–7 min): viento, avance de frentes, carreteras cortadas, heridos
  - *complicaciones* (7–10 min): averías de medios, caída de telefonía, más heridos
  - *resolución* (10 min+): contención, reapertura de vías, viento en calma
- **Llamadas** → `POST /webhooks/happyrobot`. Cada tarea `dispatched` se resuelve
  con un outcome aleatorio (aceptada 62 %, info, no_answer, busy, rejected,
  voicemail), a veces con `eta_minutes`, `injured_count`, `civilians_count`,
  `evacuation_confirmed`, `shelter_capacity` o un `road_blocked` sorpresa.
- **Avisos de Telegram** → mismo webhook con `action_id` (genera `message_outcome`).
- **Operador** → `POST /control/tasks/{id}/approve`: aprueba el 90 % de las
  tareas `awaiting_approval` tras 8–25 s.
- **Chat/ruido** → eventos `note` con jerga de grupos de vecinos/redes: no
  cambian el estado y sirven para ver el filtrado del orquestador.

## Flags

| flag | defecto | descripción |
|---|---|---|
| `--api-url` | `http://localhost:8000/api/v1` | base de la API (`SIM_API_URL`) |
| `--api-key` | `dev-secret` | `X-API-Key` (`API_KEY`) |
| `--webhook-secret` | vacío | `X-Webhook-Secret` (`HAPPYROBOT_WEBHOOK_SECRET`) |
| `--seed` | aleatoria | reproducibilidad |
| `--min-delay` / `--max-delay` | 6 / 18 s | cadencia entre eventos |
| `--duration` | 720 s | `0` = sin fin |
| `--no-reset` | — | no reiniciar el escenario al arrancar |
| `--no-calls` | — | no simular respuestas de llamadas |
| `--no-approve` | — | no auto-aprobar (deja la aprobación al humano) |

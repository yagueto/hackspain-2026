# Backend

- Trabaja en `apps/api` usando su `.venv` (`uv sync`). Verifica con `uv run ruff check .`, `uv run ruff format --check .`, `uv run mypy app` y `uv run pytest -q`.
- Para ejecutar también los tests SQL usa `TEST_POSTGRES_DSN` contra PostgreSQL de desarrollo. Cada test crea su propio schema temporal. El servicio de pruebas documentado usa el puerto 55432; Compose de desarrollo usa 55433 y volumen persistente.
- PostgreSQL directo: `STORAGE_BACKEND=postgres`, `DATABASE_URL` y `uv run python -m app.store.migrate --apply`. No necesita Twin ni credenciales HappyRobot. Las operaciones SQL atómicas se comparten con el adaptador histórico.
- Configuración: entorno del proceso > `.env.local` > `.env`. Ambos dotenv y `.devin/mcp_config.local.json` deben seguir ignorados. Nunca imprimir ni versionar claves, URL privadas de webhooks o secretos.
- Las pruebas aíslan Settings de ambos dotenv y del entorno, y bloquean el transporte HTTP real. Usar ASGITransport o MockTransport; no desactivar esta protección para hacer pasar un test.
- Nunca activar comunicaciones reales durante verificaciones automáticas. Mantener `HAPPYROBOT_MODE=simulated`, `TELEGRAM_MODE=simulated`, `AGENT_AUTOSTART=false`; vaciar `OPENAI_API_KEY` en el proceso para pruebas completamente locales.
- Telegram sustituye SMS mediante un puente HTTP configurable. `/control/sms` es un alias obsoleto de `/control/telegram`. Una respuesta 2xx del puente no confirma entrega al destinatario ni aceptación de una tarea.
- No detener la API antigua con almacenamiento memory sin conservar su estado o pedir confirmación. No eliminar volúmenes de PostgreSQL.
- `apps/simulator` puede contener trabajo sin versionar del usuario; no incluirlo en commits ajenos. No hacer push sin petición explícita.

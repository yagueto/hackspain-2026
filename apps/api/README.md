# crisis-api

Backend FastAPI del sistema de gestión de crisis.

```bash
uv sync
cp .env.example .env
uv run uvicorn app.main:app --reload --port 8000
uv run pytest
uv run ruff check . && uv run mypy app
```

Ver `docs/architecture.md` en la raíz del repo.

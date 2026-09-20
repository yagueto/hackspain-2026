from collections.abc import AsyncIterator
from weakref import WeakKeyDictionary

import pytest
from httpx import ASGITransport, AsyncClient, AsyncHTTPTransport, Request, Response

from app.config import Settings, get_settings
from app.main import create_app
from app.runtime import Runtime

HEADERS = {"X-API-Key": "test"}

_RUNTIMES: WeakKeyDictionary[AsyncClient, Runtime] = WeakKeyDictionary()


def runtime_of(client: AsyncClient) -> Runtime:
    """Acceso al runtime vivo detrás de un cliente de test."""
    return _RUNTIMES[client]


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Los tests nunca deben leer credenciales ni modo live del .env local."""
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    for name in Settings.model_fields:
        monkeypatch.delenv(name.upper(), raising=False)
    get_settings.cache_clear()

    async def no_network(self: AsyncHTTPTransport, request: Request) -> Response:
        raise AssertionError("HTTP externo bloqueado en tests; usa MockTransport")

    monkeypatch.setattr(AsyncHTTPTransport, "handle_async_request", no_network)


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    settings = Settings(
        api_key="test",
        agent_autostart=False,
        happyrobot_api_key="",
        openai_api_key="",
        geocoding_enabled=False,  # quien lo necesite lo activa con su propio transporte
        _env_file=None,  # type: ignore[call-arg]
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            _RUNTIMES[c] = app.state.rt
            yield c

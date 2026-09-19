from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.main import create_app

HEADERS = {"X-API-Key": "test"}


@pytest.fixture
async def client(tmp_path: object) -> AsyncIterator[AsyncClient]:
    settings = Settings(
        api_key="test",
        database_path=f"{tmp_path}/test.db",
        agent_autostart=False,
        happyrobot_api_key="",
        openai_api_key="",
        _env_file=None,  # type: ignore[call-arg]
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

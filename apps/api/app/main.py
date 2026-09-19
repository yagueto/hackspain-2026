from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.agent.executor import Executor
from app.agent.llm import LLMReviewer
from app.agent.orchestrator import Orchestrator
from app.api import control, events, scenario, stream, webhooks
from app.api import state as state_api
from app.config import Settings, get_settings
from app.domain.models import now
from app.domain.scenario import seed_wildfire
from app.domain.state import WorldState
from app.integrations.happyrobot import FakeHappyRobotClient, HappyRobotClient
from app.runtime import Runtime
from app.store import persistence

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("crisis")


def build_runtime(settings: Settings, state: WorldState | None = None) -> Runtime:
    state = state or WorldState()
    store = persistence.Store(settings.database_path)
    persistence.store = store
    hr: HappyRobotClient = (
        HappyRobotClient(settings)
        if settings.happyrobot_api_key
        else FakeHappyRobotClient(settings)
    )
    executor = Executor(state, hr, store, public_base_url=settings.public_base_url)
    reviewer = LLMReviewer(settings.openai_api_key, settings.openai_model)
    orchestrator = Orchestrator(state, executor, store, reviewer, settings.agent_tick_seconds)
    return Runtime(settings, state, store, hr, executor, orchestrator)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    rt = build_runtime(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await rt.store.open()
        seed_wildfire(rt.state)
        await rt.store.start_run(
            f"run_{now().strftime('%Y%m%d_%H%M%S')}",
            now().isoformat(),
            rt.state.incident.name if rt.state.incident else "",
        )
        if not rt.hr.__class__.__name__.startswith("Fake"):
            log.info("HappyRobot: cluster=%s", settings.happyrobot_cluster)
        else:
            log.warning("HappyRobot sin API key: usando cliente simulado")
        if settings.agent_autostart:
            rt.orchestrator.start()
        yield
        await rt.orchestrator.stop()
        await rt.hr.aclose()
        await rt.store.close()

    app = FastAPI(
        title="Crisis API — HackSpain 2026",
        version="0.1.0",
        description="Backend agéntico de gestión de emergencias sobre HappyRobot.",
        lifespan=lifespan,
    )
    app.state.rt = rt
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    v1 = "/api/v1"
    app.include_router(events.router, prefix=v1)
    app.include_router(webhooks.router, prefix=v1)
    app.include_router(state_api.router, prefix=v1)
    app.include_router(stream.router, prefix=v1)
    app.include_router(control.router, prefix=v1)
    app.include_router(scenario.router, prefix=v1)

    @app.get("/healthz", tags=["meta"])
    async def healthz() -> dict[str, object]:
        return {
            "ok": True,
            "agent": rt.state.agent.mode,
            "happyrobot": rt.hr.configured,
            "llm": rt.orchestrator.reviewer.enabled,
        }

    return app


app = create_app()

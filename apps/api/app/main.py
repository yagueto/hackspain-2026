from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.agent.executor import Executor
from app.agent.llm import LLMReviewer
from app.agent.orchestrator import Orchestrator
from app.api import control, events, scenario, stream, webhooks
from app.api import state as state_api
from app.config import Settings, get_settings
from app.domain.scenario import seed_wildfire
from app.domain.state import WorldState
from app.integrations.happyrobot import FakeHappyRobotClient, HappyRobotClient
from app.runtime import Runtime
from app.store import persistence
from app.store.postgres import PostgresStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("crisis")


def build_runtime(
    settings: Settings, state: WorldState | None = None, store: persistence.Store | None = None
) -> Runtime:
    state = state or WorldState()
    if settings.happyrobot_mode == "live" and (
        not settings.happyrobot_api_key or not settings.happyrobot_webhook_secret
    ):
        raise ValueError("modo live requiere API key y webhook secret")
    if settings.happyrobot_mode == "live" and settings.storage_backend == "memory":
        log.warning("modo live con persistencia en memoria: el estado se pierde al reiniciar")
    if store is None:
        store = (
            PostgresStore(settings)
            if settings.storage_backend == "postgres"
            else persistence.MemoryStore()
        )
    hr: HappyRobotClient = (
        HappyRobotClient(settings)
        if settings.happyrobot_mode == "live"
        else FakeHappyRobotClient(settings)
    )
    executor = Executor(state, hr, store, public_base_url=settings.public_base_url)
    reviewer = LLMReviewer(settings.openai_api_key, settings.openai_model, settings.openai_base_url)
    orchestrator = Orchestrator(
        state,
        executor,
        store,
        reviewer,
        settings.agent_tick_seconds,
        settings.store_poll_seconds,
        settings.store_batch_size,
    )
    return Runtime(settings, state, store, hr, executor, orchestrator)


def create_app(settings: Settings | None = None, store: persistence.Store | None = None) -> FastAPI:
    settings = settings or get_settings()
    rt = build_runtime(settings, store=store)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        try:
            await rt.store.open()
            snapshot = await rt.store.load(settings.incident_id)
            if snapshot is None and settings.seed_demo:
                phones = json.loads(settings.seed_phones) if settings.seed_phones else None
                seed_wildfire(rt.state, phones=phones)
                if rt.state.incident:
                    rt.state.incident.id = settings.incident_id
                rt.state.agent.tick_seconds = settings.agent_tick_seconds
                snapshot = await rt.store.create(rt.state.snapshot(full=True))
            if snapshot:
                rt.state.restore(snapshot)
                rt.orchestrator.tick_seconds = snapshot.agent.tick_seconds
                await rt.orchestrator.recover()
            log.info(
                "Persistencia=%s, HappyRobot=%s", settings.storage_backend, settings.happyrobot_mode
            )
            rt.orchestrator.start(settings.agent_autostart)
            yield
        finally:
            await rt.orchestrator.stop()
            await rt.hr.aclose()
            await rt.store.close()
            if rt.orchestrator.reviewer.client:
                await rt.orchestrator.reviewer.client.close()

    app = FastAPI(
        title="Crisis API — HackSpain 2026",
        version="0.1.0",
        description="Backend agéntico de gestión de emergencias sobre HappyRobot.",
        lifespan=lifespan,
    )
    app.state.rt = rt

    @app.exception_handler(persistence.StoreError)
    async def store_error(request: Request, exc: persistence.StoreError) -> JSONResponse:
        status = 409 if isinstance(exc, persistence.VersionConflict) else 503
        return JSONResponse(status_code=status, content={"detail": str(exc)})

    @app.exception_handler(ValueError)
    async def invalid_operation(request: Request, exc: ValueError) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": str(exc)})

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
            "happyrobot_mode": settings.happyrobot_mode,
            "telegram": bool(settings.happyrobot_wf_telegram),
            "llm": rt.orchestrator.reviewer.enabled,
            "storage": settings.storage_backend,
            "synchronized": rt.state.integrations.get("storage", False),
            "version": rt.state.version,
            "last_synced_at": rt.state.last_synced_at,
        }

    return app


app = create_app()

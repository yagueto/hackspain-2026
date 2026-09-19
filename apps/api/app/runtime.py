"""Contenedor de dependencias vivas de la aplicación."""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Request

from app.agent.executor import Executor
from app.agent.orchestrator import Orchestrator
from app.config import Settings
from app.domain.state import WorldState
from app.integrations.happyrobot import HappyRobotClient
from app.integrations.telegram import TelegramWebhookClient
from app.store.persistence import Store


@dataclass
class Runtime:
    settings: Settings
    state: WorldState
    store: Store
    hr: HappyRobotClient
    telegram: TelegramWebhookClient
    executor: Executor
    orchestrator: Orchestrator


def get_runtime(request: Request) -> Runtime:
    rt: Runtime = request.app.state.rt
    return rt

"""Contenedor de dependencias vivas de la aplicación."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from fastapi import Request

from app.agent.executor import Executor
from app.agent.orchestrator import Orchestrator
from app.config import Settings
from app.domain.intake import prepare_intake_tasks
from app.domain.models import Event, EventKind, EventSource, LocationResolution, TaskStatus
from app.domain.state import WorldState
from app.integrations.geocoding import NominatimGeocoder
from app.integrations.happyrobot import HappyRobotClient
from app.store.persistence import Store


@dataclass
class Runtime:
    settings: Settings
    state: WorldState
    store: Store
    hr: HappyRobotClient
    executor: Executor
    orchestrator: Orchestrator
    geocoder: NominatimGeocoder

    async def geocode_report(
        self, run_id: str, expected_timestamp: datetime, *, retry: bool = False
    ) -> LocationResolution:
        if not self.geocoder.enabled:
            return LocationResolution()
        await self.orchestrator.synchronize()
        report = self.state.incoming_calls[run_id].model_copy(deep=True)
        if report.timestamp != expected_timestamp:
            raise ValueError("el aviso ha cambiado; revisa la ubicación actual")
        if not retry and report.resolution.status != "not_requested":
            return report.resolution
        if retry and any(
            task.incoming_call_id == run_id
            and (task.approved_at or task.action_ids)
            and task.status not in (TaskStatus.done, TaskStatus.cancelled, TaskStatus.failed)
            for task in self.state.tasks.values()
        ):
            raise ValueError("hay una misión en curso; revisa su destino antes de buscar otro")
        result = await self.geocoder.search(report.location)
        if result.status == "not_requested":
            return result
        async with self.orchestrator.edit() as state:
            current = state.incoming_calls[run_id]
            if current.timestamp != expected_timestamp or current.resolution != report.resolution:
                raise ValueError("el aviso o su ubicación cambiaron durante la búsqueda")
            current.resolution = result
            prepare_intake_tasks(state, current)
            state.add_event(
                Event(
                    source=EventSource.system,
                    kind=EventKind.note,
                    title=f"Geocodificación de aviso: {result.status}",
                    payload={"run_id": run_id, "provider": "nominatim"},
                )
            )
        return result


def get_runtime(request: Request) -> Runtime:
    rt: Runtime = request.app.state.rt
    return rt

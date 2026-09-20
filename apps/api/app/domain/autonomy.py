"""Frontera entre lo autónomo y lo que requiere una persona.

El agente decide y despacha los servicios disponibles sin aprobación por gravedad.
Los conflictos de recursos se resuelven mediante preguntas de coordinación. Las
órdenes autónomas salen tras una ventana en la que el operador puede anularlas.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from app.domain.models import AgentConfig, TaskKind, now


def needs_confirmation(agent: AgentConfig, kind: TaskKind, severity: str | None) -> bool:
    """`severity` es la del aviso ciudadano; None para propuestas del planner.

    Con la autonomía desactivada todo pasa por una persona, que es el comportamiento
    conservador; es lo que debe ocurrir si alguien apaga el interruptor.
    """
    return not agent.autonomous


def hold_until(agent: AgentConfig, confirmed_by_human: bool) -> datetime | None:
    """Fin de la ventana para anular. None cuando no hay nada que retener."""
    if confirmed_by_human or agent.hold_seconds <= 0:
        return None
    return now() + timedelta(seconds=agent.hold_seconds)

"""Frontera entre lo autónomo y lo que requiere una persona.

El agente decide y despacha solo. Solo somete a confirmación humana las decisiones
críticas: las evacuaciones masivas y los avisos con vidas en peligro inmediato. El
resto sale tras una ventana corta en la que el operador puede anularlo.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from app.domain.models import AgentConfig, TaskKind, now


def needs_confirmation(agent: AgentConfig, kind: TaskKind, severity: str | None) -> bool:
    """`severity` es la del aviso ciudadano; None para propuestas del planner.

    Con la autonomía desactivada todo pasa por una persona, que es el comportamiento
    conservador; es lo que debe ocurrir si alguien apaga el interruptor.
    """
    return (
        not agent.autonomous
        or kind in agent.approval_required_for
        or (severity is not None and severity in agent.approval_required_severities)
    )


def hold_until(agent: AgentConfig, confirmed_by_human: bool) -> datetime | None:
    """Fin de la ventana para anular. None cuando no hay nada que retener."""
    if confirmed_by_human or agent.hold_seconds <= 0:
        return None
    return now() + timedelta(seconds=agent.hold_seconds)

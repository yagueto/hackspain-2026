from __future__ import annotations

import hashlib
from datetime import timedelta

from app.agent.executor import compatible_resource, distance, invalid_task, location_pending
from app.domain.models import (
    ActionStatus,
    CoordinationAction,
    CoordinationAnswer,
    CoordinationOption,
    CoordinationQuestion,
    CoordinationResolution,
    Event,
    EventKind,
    EventSource,
    Resource,
    ResourceStatus,
    Severity,
    Task,
    TaskStatus,
    now,
)
from app.domain.state import WorldState

CLOSED = {TaskStatus.cancelled, TaskStatus.done, TaskStatus.failed, TaskStatus.rejected}


def incident_id(state: WorldState, task: Task) -> str:
    return (
        f"call:{task.incoming_call_id}"
        if task.incoming_call_id
        else task.zone_id or (state.incident.id if state.incident else "")
    )


def allocation_key(state: WorldState, resource_id: str | None, task_ids: list[str]) -> str:
    context = [resource_id or "unavailable"]
    for task_id in sorted(task_ids):
        task = state.tasks.get(task_id)
        if task:
            context.append(
                str(
                    (
                        task.id,
                        task.created_at,
                        task.incoming_call_timestamp,
                        task.target_location,
                        task.priority,
                        task.resource_types,
                    )
                )
            )
    return hashlib.sha256(repr(context).encode()).hexdigest()


def waiting_tasks(state: WorldState) -> list[Task]:
    return [
        task
        for task in state.open_tasks()
        if task.status == TaskStatus.proposed
        and task.resource_types
        and not task.resource_ids
        and (state.agent.autonomous or task.approved_at)
        and not location_pending(state, task)
        and not invalid_task(state, task)
    ]


def match_available(state: WorldState, tasks: list[Task]) -> dict[str, str]:
    owners: dict[str, str] = {}

    def score(task: Task, rid: str) -> tuple[bool, float]:
        resource = state.resources[rid]
        target = state.zones.get(task.zone_id or "") or state.fronts.get(task.zone_id or "")
        location = task.target_location or (target.location if target else None)
        eta = (
            distance(resource.location, location) * 1.5 if location else resource.eta_minutes or 30
        )
        contact = state.contact_for_resource(rid)
        return (
            rid != task.preferred_resource_id,
            eta - min(resource.capacity, 50) / 10 - (contact.reliability * 5 if contact else 0),
        )

    candidates = {
        task.id: sorted(
            (r.id for r in state.available_resources() if compatible_resource(state, task, r)),
            key=lambda rid: score(task, rid),
        )
        for task in tasks
    }

    def assign(task_id: str, seen: set[str]) -> bool:
        for rid in candidates[task_id]:
            if rid in seen:
                continue
            seen.add(rid)
            if rid not in owners or assign(owners[rid], seen):
                owners[rid] = task_id
                return True
        return False

    for task in tasks:
        assign(task.id, set())
    return {task_id: rid for rid, task_id in owners.items()}


def allocation_problem(
    state: WorldState, question: CoordinationQuestion, action: CoordinationAction
) -> str:
    task = state.tasks.get(action.task_id or "")
    resource = state.resources.get(action.resource_id or "")
    if (
        not question.allocation_task_ids
        or action.task_id not in question.allocation_task_ids
        or action.resource_id != question.allocation_resource_id
    ):
        return "la elección no pertenece al conflicto"
    if (
        not task
        or task.status != action.expected_status
        or task.updated_at != action.expected_updated_at
        or task.status in CLOSED
        or location_pending(state, task)
        or invalid_task(state, task)
    ):
        return "la misión o su ubicación han cambiado"
    if (
        not resource
        or resource.status != action.expected_resource_status
        or resource.assigned_task_id != action.expected_source_task_id
        or not compatible_resource(state, task, resource)
    ):
        return "la disponibilidad o asignación del recurso ha cambiado"
    source = state.tasks.get(resource.assigned_task_id or "")
    if source and (
        source.updated_at != action.expected_source_updated_at
        or source.status in CLOSED
        or invalid_task(state, source)
    ):
        return "la misión de origen ha cambiado"
    if source and any(
        state.actions[aid].status in (ActionStatus.sending, ActionStatus.unknown)
        for aid in source.action_ids
        if aid in state.actions
    ):
        return "hay una orden de resultado incierto; verifica el recurso antes de reasignarlo"
    if source and source.resource_ids != [resource.id]:
        return "la reserva de origen ha cambiado"
    if source and source.id == task.id:
        return ""
    if task.resource_ids or task.status != TaskStatus.proposed:
        return "la misión de destino ya tiene una reserva u orden"
    return ""


def close_question(state: WorldState, question: CoordinationQuestion, outcome: str) -> None:
    for task_id in question.allocation_task_ids:
        task = state.tasks.get(task_id)
        if task and not invalid_task(state, task):
            for aid in task.action_ids:
                order = state.actions.get(aid)
                if order and order.status == ActionStatus.pending:
                    order.expires_at = now() + timedelta(minutes=10)
    question.status = "resolved"
    question.resolution = CoordinationResolution(
        question_id=question.id,
        incident_id=question.incident_id,
        idempotency_key=question.id,
        answer=question.default_answer,
        answer_label="Conflicto actualizado",
        source="system",
        outcome=outcome,
        applied=False,
    )


def competing_resources(
    state: WorldState,
    task: Task,
    virtual: dict[str, Task],
    locked_tasks: set[str],
    locked_resources: set[str | None],
) -> list[tuple[Resource, Task]]:
    candidates = []
    for resource in state.resources.values():
        source = state.tasks.get(resource.assigned_task_id or "") or virtual.get(resource.id)
        if (
            resource.id in locked_resources
            or not source
            or source.status in CLOSED
            or source.id in locked_tasks
            or incident_id(state, source) == incident_id(state, task)
            or resource.status
            not in (
                ResourceStatus.available,
                ResourceStatus.reserved,
                ResourceStatus.en_route,
                ResourceStatus.dispatched,
                ResourceStatus.on_scene,
            )
            or not compatible_resource(state, task, resource)
            or invalid_task(state, source)
            or location_pending(state, source)
            or (resource.assigned_task_id and source.resource_ids != [resource.id])
            or any(
                state.actions[aid].status in (ActionStatus.sending, ActionStatus.unknown)
                for aid in source.action_ids
                if aid in state.actions
            )
        ):
            continue
        candidates.append((resource, source))
    return sorted(
        candidates, key=lambda pair: (bool(pair[0].assigned_task_id), pair[1].priority, pair[0].id)
    )


def refresh_allocations(state: WorldState) -> bool:
    waiting = waiting_tasks(state)
    matches = match_available(state, waiting)
    virtual_owners = {rid: state.tasks[tid] for tid, rid in matches.items()}
    changed = False
    for question in state.coordination_questions.values():
        if question.status != "pending" or not question.allocation_task_ids:
            continue
        pending = [t for t in waiting if t.id in question.allocation_task_ids]
        choices = [o.action for o in question.options if o.action.type == "allocate-resource"]
        stale = any(allocation_problem(state, question, action) for action in choices)
        new_choices = not choices and any(
            competing_resources(state, task, virtual_owners, set(), set()) for task in pending
        )
        resource = state.resources.get(question.allocation_resource_id or "")
        new_contender = (
            resource is not None
            and len(question.allocation_task_ids) < 11
            and any(
                task.id not in question.allocation_task_ids
                and task.id not in matches
                and compatible_resource(state, task, resource)
                for task in waiting
            )
        )
        if (
            not pending
            or all(t.id in matches for t in pending)
            or stale
            or new_choices
            or new_contender
            or question.allocation_key
            != allocation_key(state, question.allocation_resource_id, question.allocation_task_ids)
        ):
            close_question(
                state, question, "La situación cambió; se recalculan los medios necesarios."
            )
            changed = True
    locked_tasks = {
        tid
        for q in state.coordination_questions.values()
        if q.status == "pending"
        for tid in q.allocation_task_ids
    }
    locked_resources = {
        q.allocation_resource_id
        for q in state.coordination_questions.values()
        if q.status == "pending"
    }
    for task in waiting:
        if task.id in matches or task.id in locked_tasks:
            continue
        candidates = competing_resources(
            state, task, virtual_owners, locked_tasks, locked_resources
        )
        resource, source = candidates[0] if candidates else (None, None)
        if not resource and any(
            r.id in locked_resources and compatible_resource(state, task, r)
            for r in state.resources.values()
        ):
            continue
        targets = [source, task] if source else [task]
        if resource:
            targets.extend(
                t
                for t in waiting
                if t.id not in matches
                and t not in targets
                and t.id not in locked_tasks
                and compatible_resource(state, t, resource)
            )
        targets = targets[:11]
        task_ids = [target.id for target in targets]
        key = allocation_key(state, resource.id if resource else None, task_ids)
        if any(
            q.allocation_resource_id == (resource.id if resource else None)
            and set(task_ids) <= set(q.allocation_task_ids)
            and q.allocation_key
            == allocation_key(state, q.allocation_resource_id, q.allocation_task_ids)
            and q.resolution
            and q.resolution.source == "human"
            and q.resolution.applied
            for q in state.coordination_questions.values()
        ):
            continue
        options = [CoordinationOption(id="wait", label="Seguir esperando; no decidir todavía")]
        if resource and source:
            for target in targets:
                current = state.tasks.get(resource.assigned_task_id or "")
                label = (
                    target.target_location.label if target.target_location else ""
                ) or incident_id(state, target)
                options.append(
                    CoordinationOption(
                        id=target.id,
                        label=(
                            f"{incident_id(state, target)} · Prioridad {target.priority} · "
                            f"{label}: {target.title}"
                        )[:200],
                        action=CoordinationAction(
                            type="allocate-resource",
                            task_id=target.id,
                            resource_id=resource.id,
                            expected_status=target.status,
                            expected_updated_at=target.updated_at,
                            expected_source_task_id=resource.assigned_task_id,
                            expected_source_updated_at=current.updated_at if current else None,
                            expected_resource_status=resource.status,
                        ),
                    )
                )
        question = CoordinationQuestion(
            incident_id=incident_id(state, task),
            urgency="critical",
            expires_at=None,
            prompt=(
                f"Medios insuficientes. {resource.name} no puede atender todos los incidentes. "
                "¿A cuál debe ir? El resto seguirá esperando medios. Una reasignación requiere "
                "una nueva comunicación y aceptación de la unidad."
                if resource and source
                else f"Sin medios compatibles disponibles para {task.title}. "
                "No hay una unidad reasignable: se necesita un refuerzo "
                "o un parte de disponibilidad."
            ),
            options=options,
            default_answer=CoordinationAnswer(option_ids=["wait"]),
            sequence=max((q.sequence for q in state.coordination_questions.values()), default=0)
            + 1,
            allocation_resource_id=resource.id if resource else None,
            allocation_task_ids=task_ids,
            allocation_key=key,
        )
        state.coordination_questions[question.id] = question
        locked_tasks.update(task_ids)
        locked_resources.add(question.allocation_resource_id)
        state.add_event(
            Event(
                source=EventSource.system,
                kind=EventKind.note,
                severity=Severity.critical,
                title="Conflicto de recursos: decisión del operador",
                payload={
                    "incident_id": question.incident_id,
                    "question_id": question.id,
                    "summary": question.prompt,
                    "log_kind": "question",
                },
            )
        )
        changed = True
    for task in waiting:
        if task.id not in locked_tasks and task.id in matches:
            preferred = matches[task.id]
            if task.preferred_resource_id != preferred:
                task.preferred_resource_id = preferred
                changed = True
    return changed

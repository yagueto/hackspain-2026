import hashlib

from app.domain.models import (
    ContactRole,
    IncomingCall,
    Location,
    ResourceType,
    Task,
    TaskKind,
    TaskStatus,
    now,
)
from app.domain.state import WorldState


def report_location(report: IncomingCall) -> Location | None:
    location = report.location
    resolved = report.resolution.selected
    if resolved and report.resolution.status == "confirmed":
        return Location(lat=resolved.lat, lng=resolved.lng, label=resolved.label)
    if location.confirmed and location.lat is not None and location.lng is not None:
        return Location(lat=location.lat, lng=location.lng, label=location.raw_text or "")
    if resolved and report.resolution.status == "resolved":
        return Location(lat=resolved.lat, lng=resolved.lng, label=resolved.label)
    return None


def prepare_intake_tasks(state: WorldState, report: IncomingCall) -> bool:
    requirements = {
        "incendio": (ResourceType.fire_engine, ContactRole.firefighter, TaskKind.dispatch_resource),
        "sanitaria": (ResourceType.ambulance, ContactRole.ambulance, TaskKind.medical_triage),
        "seguridad": (ResourceType.police_unit, ContactRole.police, TaskKind.dispatch_resource),
        "trafico": (ResourceType.police_unit, ContactRole.police, TaskKind.dispatch_resource),
        "rescate": (ResourceType.fire_engine, ContactRole.firefighter, TaskKind.dispatch_resource),
    }
    wanted = []
    if report.severity != "no_emergencia" and report.emergency_type in requirements:
        wanted.append(requirements[report.emergency_type])
        if report.emergency_type != "sanitaria" and (
            report.victims.breathing is False or report.victims.conscious is False
        ):
            wanted.append(requirements["sanitaria"])
    target = report_location(report)
    digest = hashlib.sha256(report.run_id.encode()).hexdigest()[:16]
    wanted_ids = {f"intake_{digest}_{resource_type}" for resource_type, _, _ in wanted}
    changed = False
    for task in state.tasks.values():
        if task.incoming_call_id != report.run_id:
            continue
        if (
            task.approved_at
            and (task.incoming_call_timestamp != report.timestamp or task.target_location != target)
            and task.status not in (TaskStatus.done, TaskStatus.cancelled, TaskStatus.failed)
        ):
            warning = "Aviso actualizado: revisar la misión; el destino aprobado no se ha cambiado."
            if task.outcome != warning:
                task.outcome = warning
                task.updated_at = now()
                changed = True
        if task.id not in wanted_ids and task.status == TaskStatus.awaiting_approval:
            task.status = TaskStatus.cancelled
            task.outcome = "El aviso actualizado ya no requiere esta propuesta."
            task.updated_at = now()
            changed = True
    for resource_type, role, kind in wanted:
        task_id = f"intake_{digest}_{resource_type}"
        previous = state.tasks.get(task_id)
        if previous and previous.status != TaskStatus.awaiting_approval:
            can_reopen = (
                previous.status == TaskStatus.cancelled
                and not previous.approved_at
                and not previous.cancellation_requested
                and not previous.action_ids
            )
            if not can_reopen:
                continue
        service = {
            ResourceType.fire_engine: "Bomberos",
            ResourceType.ambulance: "Ambulancia",
            ResourceType.police_unit: "Policía",
        }[resource_type]
        proposed = Task(
            id=task_id,
            kind=kind,
            title=f"Propuesta: {service} para aviso de {report.emergency_type}",
            description=(
                f"{report.notes or ''}\n"
                f"Ubicación declarada: {report.location.raw_text or 'desconocida'}"
            ),
            priority={"vital": 100, "grave": 85, "moderada": 60, "leve": 35}[report.severity],
            priority_reason="Aviso ciudadano; requiere revisión y aprobación del operador.",
            status=TaskStatus.awaiting_approval,
            requires_approval=True,
            resource_types=[resource_type],
            contact_roles=[role],
            incoming_call_id=report.run_id,
            incoming_call_timestamp=report.timestamp,
            target_location=target,
            outcome="Revisar ubicación y aprobar recursos."
            if target
            else "Ubicación pendiente; aprobación bloqueada.",
        )
        if previous:
            proposed.created_at = previous.created_at
            comparable = {"updated_at"}
            if proposed.model_dump(exclude=comparable) == previous.model_dump(exclude=comparable):
                continue
        state.upsert_task(proposed)
        changed = True
    return changed

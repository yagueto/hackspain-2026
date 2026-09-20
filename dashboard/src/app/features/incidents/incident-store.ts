import { computed, effect, inject, Injectable, InjectionToken, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, Observable } from 'rxjs';
import { Incident, MapLocation } from '../../core/models/operations';
import { OperationLogEvent } from '../../core/models/operation-log';
import { ACTION_LABELS, TASK_LABELS, WorldSnapshot } from '../../core/models/world';
import { Operations, taskIncidentId } from '../../core/services/operations';
import { IncidentDetails, IncidentEvent } from './incidents.mock';

export interface IncidentUpdate {
  incidentId: string;
  incident?: Partial<Omit<Incident, 'id'>>;
  details?: Partial<IncidentDetails>;
  event?: IncidentEvent;
  units?: readonly MapLocation[];
}

export const INCIDENT_UPDATES = new InjectionToken<Observable<IncidentUpdate>>('INCIDENT_UPDATES', {
  providedIn: 'root',
  factory: () => EMPTY,
});

function snapshotEvents(state: WorldSnapshot | null): IncidentEvent[] {
  if (!state) return [];
  const taskFor = (id: unknown) => state.tasks.find((task) => task.id === id);
  const events: IncidentEvent[] = (state.recent_events ?? []).map((event) => {
    const payload = event.payload ?? {};
    const action = state.recent_actions.find(
      (item) => item.id === (payload['command_id'] || payload['action_id']),
    );
    const resource = state.resources.find((item) => item.id === payload['resource_id']);
    const task = taskFor(payload['task_id'] || action?.task_id || resource?.assigned_task_id);
    const incidentId =
      typeof payload['incident_id'] === 'string'
        ? payload['incident_id']
        : typeof payload['run_id'] === 'string' && event.kind === 'incoming_call'
          ? `call:${payload['run_id']}`
          : taskIncidentId(task, event.zone_id || state.incident.id);
    const kind =
      payload['log_kind'] === 'question' || payload['log_kind'] === 'answer'
        ? payload['log_kind']
        : 'note';
    return {
      id: `event:${event.id}`,
      incidentId,
      occurredAt: event.ts,
      title: event.title,
      description: [
        typeof payload['summary'] === 'string' ? payload['summary'] : event.title,
        event.relevance_reason,
      ]
        .filter(Boolean)
        .join(' · '),
      source:
        event.source === 'happyrobot' || event.source === 'call_112'
          ? 'HappyRobot · recepción'
          : event.source === 'operator'
            ? 'Operador'
            : event.source,
      kind,
      questionId: typeof payload['question_id'] === 'string' ? payload['question_id'] : undefined,
    };
  });
  events.push(
    ...(state.incoming_calls ?? []).map((report): IncidentEvent => ({
      id: `report:${report.run_id}`,
      incidentId: `call:${report.run_id}`,
      occurredAt: report.timestamp,
      title: 'Aviso ciudadano recibido por Web Call',
      description: `${report.emergency_type} · ${report.severity}. ${report.notes || ''}`,
      source: 'HappyRobot · Web Call',
      kind: 'created',
    })),
  );
  events.push(
    ...state.tasks.map((task): IncidentEvent => ({
      id: `task:${task.id}`,
      incidentId: taskIncidentId(task, state.incident.id),
      occurredAt: task.updated_at || task.created_at || state.incident.started_at,
      title: task.title,
      description: [
        TASK_LABELS[task.status] || task.status,
        task.priority_reason,
        task.blocked_reason,
        task.outcome,
      ]
        .filter(Boolean)
        .join(' · '),
      source: task.autonomous ? 'Agente autónomo' : 'Coordinación',
      kind: 'assignment',
    })),
  );
  events.push(
    ...state.recent_actions.map((action): IncidentEvent => ({
      id: `action:${action.id}`,
      incidentId: taskIncidentId(
        taskFor(action.task_id || action.request?.task_id),
        state.contacts.find((contact) => contact.id === action.contact_id)?.zone_id ||
          state.incident.id,
      ),
      occurredAt: action.ts,
      title: action.summary,
      description: [
        action.summary,
        ACTION_LABELS[action.status] || action.status,
        action.result.webhook?.summary,
        action.error,
      ]
        .filter(Boolean)
        .join(' · '),
      source: action.workflow ? `HappyRobot · ${action.workflow}` : 'Orquestador',
      kind: action.kind === 'call' ? 'call' : 'action',
    })),
  );
  events.push(
    ...(state.recent_decisions ?? []).map((decision): IncidentEvent => ({
      id: `decision:${decision.id}`,
      incidentId: state.incident.id,
      occurredAt: decision.ts,
      title: decision.replan ? 'Replanificación del agente' : 'Decisión del agente',
      description: [
        decision.situation_summary,
        decision.replan_reason,
        ...decision.priorities,
        ...decision.actions_taken,
        ...(decision.discarded_events ?? []).map((event) => `Descartado: ${event}`),
      ]
        .filter(Boolean)
        .join(' · '),
      source: `Agente · ${decision.model}`,
      kind: 'action',
    })),
  );
  return events.filter((event) => Number.isFinite(Date.parse(event.occurredAt)));
}

@Injectable({ providedIn: 'root' })
export class IncidentStore {
  readonly operations = inject(Operations);
  private readonly updates = signal<Readonly<Record<string, IncidentUpdate>>>({});
  private readonly eventState = signal<readonly IncidentEvent[]>([]);
  private readonly adapterError = signal(false);
  readonly incidents = computed(() =>
    this.operations.incidents().map((incident) => ({
      ...incident,
      ...this.updates()[incident.id]?.incident,
      id: incident.id,
    })),
  );
  readonly units = computed(() => {
    let units: readonly MapLocation[] = this.operations.units();
    for (const update of Object.values(this.updates()))
      if (update.units)
        units = [...units.filter((unit) => unit.incidentId !== update.incidentId), ...update.units];
    return units;
  });
  readonly details = computed<Readonly<Record<string, IncidentDetails>>>(() => {
    const state = this.operations.snapshot();
    return Object.fromEntries(
      this.incidents().map((incident) => {
        const report = state?.incoming_calls.find((call) => `call:${call.run_id}` === incident.id);
        const zone = state?.zones.find((item) => item.id === incident.id);
        const front = state?.fronts.find((item) => item.id === incident.id);
        return [
          incident.id,
          {
            category: report
              ? ({
                  sanitaria: 'Sanitaria',
                  incendio: 'Incendio',
                  seguridad: 'Seguridad',
                  trafico: 'Tráfico',
                  rescate: 'Rescate',
                }[report.emergency_type] ?? 'Aviso ciudadano')
              : front
                ? 'Forestal'
                : zone
                  ? 'Zona de emergencia'
                  : 'Tráfico',
            openedAt: report?.timestamp || state?.incident.started_at || '',
            affected: report?.victims.count ?? zone?.civilians_present ?? null,
            // El backend solo cuenta heridos por zona. Un aviso ciudadano describe el estado de
            // las víctimas con banderas, no con un recuento, así que no se inventa una cifra.
            assistanceNeeded: report ? null : (zone?.injured ?? null),
            affectedNote: report
              ? [
                  report.victims.trapped ? 'Personas atrapadas' : '',
                  report.victims.minors_involved ? 'Menores implicados' : '',
                  report.victims.breathing === false ? 'No respira' : '',
                  report.victims.conscious === false ? 'Inconsciente' : '',
                  report.active_hazards,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : zone
                ? `${zone.injured} heridos · capacidad de acogida ${zone.shelter_capacity ?? 0}`
                : 'Sin personas confirmadas',
            ...this.updates()[incident.id]?.details,
          },
        ];
      }),
    );
  });
  readonly events = computed<readonly OperationLogEvent[]>(() => [
    ...new Map(
      [...snapshotEvents(this.operations.snapshot()), ...this.eventState()].map((event) => [
        `${event.incidentId}:${event.id}`,
        event,
      ]),
    ).values(),
  ]);
  readonly updateError = computed(
    () => this.adapterError() || ['offline', 'reconnecting'].includes(this.operations.connection()),
  );

  constructor() {
    this.operations.start();
    let identity: string | undefined;
    effect(() => {
      const state = this.operations.snapshot();
      const next = state ? `${state.incident.id}:${state.incident.started_at}` : undefined;
      if (identity && next !== identity) {
        this.updates.set({});
        this.eventState.set([]);
      }
      identity = next;
    });
    inject(INCIDENT_UPDATES)
      .pipe(takeUntilDestroyed())
      .subscribe({
        next: (update) => this.applyUpdate(update),
        error: () => this.adapterError.set(true),
      });
  }

  appendEvent(event: IncidentEvent): void {
    if (!Number.isFinite(Date.parse(event.occurredAt))) return;
    this.eventState.update((events) => [
      ...events.filter(
        (existing) => existing.id !== event.id || existing.incidentId !== event.incidentId,
      ),
      event,
    ]);
  }

  applyUpdate(update: IncidentUpdate): void {
    const id = update.incidentId;
    if (!this.incidents().some((incident) => incident.id === id)) return;
    this.updates.update((updates) => ({
      ...updates,
      [id]: {
        ...updates[id],
        ...update,
        incident: { ...updates[id]?.incident, ...update.incident },
        details: { ...updates[id]?.details, ...update.details },
        units:
          update.units?.filter((unit) => unit.kind === 'unit' && unit.incidentId === id) ??
          updates[id]?.units,
      },
    }));
    if (update.event?.incidentId === id) this.appendEvent(update.event);
  }
}

import { inject, Injectable, InjectionToken, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, Observable } from 'rxjs';
import { MOCK_COMMUNICATIONS, MOCK_INCIDENTS, MOCK_UNITS } from '../../core/data/operations.mock';
import { Communication, Incident, MapLocation } from '../../core/models/operations';
import { DemoRouteSimulation } from '../../core/services/demo-route-simulation';
import { ResourceIntervention } from '../resources/resources.mock';
import { IncidentDetails, IncidentEvent, MOCK_INCIDENT_DETAILS } from './incidents.mock';

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

@Injectable({ providedIn: 'root' })
export class IncidentStore {
  private readonly simulation = inject(DemoRouteSimulation);
  private readonly incidentState = signal<readonly Incident[]>(MOCK_INCIDENTS);
  private readonly detailState =
    signal<Readonly<Record<string, IncidentDetails>>>(MOCK_INCIDENT_DETAILS);
  private readonly unitState = signal<readonly MapLocation[]>(MOCK_UNITS);
  private readonly communicationState = signal<readonly Communication[]>(MOCK_COMMUNICATIONS);
  private readonly historyState = signal<readonly ResourceIntervention[]>([]);
  private readonly eventState = signal<readonly IncidentEvent[]>(
    MOCK_INCIDENTS.flatMap((incident) => [
      {
        id: `${incident.id}:reported`,
        incidentId: incident.id,
        occurredAt: MOCK_INCIDENT_DETAILS[incident.id].openedAt,
        title: 'Incidencia notificada',
        kind: 'created' as const,
        description: `${incident.title}. ${MOCK_INCIDENT_DETAILS[incident.id].affectedNote}`,
        source: 'Central 112',
      },
      ...MOCK_UNITS.filter((unit) => unit.incidentId === incident.id).map((unit) => ({
        id: `${unit.id}:assigned`,
        incidentId: incident.id,
        occurredAt: new Date(
          Date.parse(MOCK_INCIDENT_DETAILS[incident.id].openedAt) + 90000,
        ).toISOString(),
        title: 'Recurso asignado',
        kind: 'assignment' as const,
        description: `${unit.id} está interviniendo en ${incident.id}.`,
        source: 'Coordinación',
      })),
    ]),
  );
  readonly incidents = this.incidentState.asReadonly();
  readonly details = this.detailState.asReadonly();
  readonly units = this.unitState.asReadonly();
  readonly communications = this.communicationState.asReadonly();
  readonly resourceHistory = this.historyState.asReadonly();
  readonly events = this.eventState.asReadonly();
  readonly updateError = signal(false);

  constructor() {
    inject(INCIDENT_UPDATES)
      .pipe(takeUntilDestroyed())
      .subscribe({
        next: (update) => this.applyUpdate(update),
        error: () => this.updateError.set(true),
      });
    this.simulation.arrivals$.pipe(takeUntilDestroyed()).subscribe((event) => {
      this.appendEvent(event);
      for (const source of this.units()) {
        if (source.incidentId !== event.incidentId || source.kind !== 'unit') continue;
        const unit = this.simulation.project(source);
        if (unit.route?.status === 'completed')
          this.updateCommunication(
            unit.id,
            `${unit.id} en destino: ${unit.route.destinationLabel}.`,
            'En ejecución',
          );
      }
      const incident = this.incidents().find((item) => item.id === event.incidentId);
      const assigned = this.units().filter(
        (unit) => unit.kind === 'unit' && unit.incidentId === event.incidentId,
      );
      if (
        incident &&
        ['Recursos en camino', 'Bomberos reasignados en camino'].includes(incident.status) &&
        assigned.length &&
        assigned.every((unit) => this.simulation.project(unit).route?.status === 'completed')
      )
        this.applyUpdate({
          incidentId: incident.id,
          incident: { status: incident.id === 'INC-003' ? 'En extinción' : 'En atención' },
        });
    });
  }

  createIncident(incident: Incident, details: IncidentDetails): void {
    if (this.incidents().some((item) => item.id === incident.id)) return;
    this.incidentState.update((incidents) => [...incidents, incident]);
    this.detailState.update((state) => ({ ...state, [incident.id]: details }));
    this.appendEvent({
      id: `${incident.id}:reported`,
      incidentId: incident.id,
      occurredAt: details.openedAt,
      title: 'Incidencia notificada',
      kind: 'created',
      description: `${incident.title}. ${details.affectedNote}`,
      source: 'Central 112',
    });
  }

  appendEvent(event: IncidentEvent): void {
    if (
      !this.incidents().some((incident) => incident.id === event.incidentId) ||
      !Number.isFinite(Date.parse(event.occurredAt))
    )
      return;
    if (
      this.events().some(
        (existing) => existing.id === event.id && existing.incidentId === event.incidentId,
      )
    )
      return;
    this.eventState.update((events) => [...events, event]);
  }

  updateCommunication(resourceId: string, message: string, status: Communication['status']): void {
    const unit = this.units().find((item) => item.id === resourceId);
    if (!unit) return;
    this.communicationState.update((items) =>
      items.map((item) =>
        item.vehicle === resourceId
          ? {
              ...item,
              incidentId: unit.incidentId ?? 'Sin asignar',
              message,
              status,
              time: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
            }
          : item,
      ),
    );
  }

  reassignUnit(unit: MapLocation, incidentId: string, onSite = false): void {
    const incident = this.incidents().find((item) => item.id === incidentId);
    const existing = this.units().find((item) => item.id === unit.id && item.kind === 'unit');
    if (!incident || !existing || existing.incidentId === incidentId) return;
    const occurredAt = new Date().toISOString();
    const assigned: MapLocation = {
      ...existing,
      incidentId,
      coordinates: unit.coordinates,
      address: onSite ? incident.address : `En ruta hacia ${incident.title}`,
      route: {
        status: onSite ? 'completed' : 'active',
        destination: incident.coordinates,
        destinationLabel: incident.title,
      },
    };
    this.unitState.update((units) => units.map((item) => (item.id === unit.id ? assigned : item)));
    if (existing.incidentId) {
      const summary = `${unit.id} se retira de ${existing.incidentId} y se reasigna a ${incidentId} por prioridad operativa.`;
      this.historyState.update((history) => [
        ...history,
        {
          resourceIds: [unit.id],
          incidentId: existing.incidentId!,
          completedAt: occurredAt,
          summary,
        },
      ]);
      this.appendEvent({
        id: `${incidentId}:transfer:${unit.id}`,
        incidentId: existing.incidentId,
        occurredAt,
        title: 'Recurso reasignado',
        kind: 'assignment',
        description: summary,
        source: 'Coordinación',
      });
    }
    this.appendEvent({
      id: `${incidentId}:assigned:${unit.id}`,
      incidentId,
      occurredAt,
      title: 'Recurso asignado',
      kind: 'assignment',
      description: `${unit.id} asignado a ${incidentId}${existing.incidentId ? ` desde ${existing.incidentId}` : ' desde reserva'}. ${onSite ? 'Equipo en destino.' : 'Recurso en camino.'}`,
      source: 'Coordinación',
    });
    this.updateCommunication(
      unit.id,
      `${unit.id} ${onSite ? 'en destino' : 'en camino'} para ${incidentId} · ${incident.title}.`,
      onSite ? 'En ejecución' : 'Aceptada',
    );
    this.simulation.start(this.units());
  }

  applyUpdate(update: IncidentUpdate): void {
    const id = update.incidentId;
    if (!this.incidents().some((incident) => incident.id === id)) return;
    if (update.incident) {
      this.incidentState.update((incidents) =>
        incidents.map((incident) =>
          incident.id === id ? { ...incident, ...update.incident, id } : incident,
        ),
      );
    }
    if (update.details) {
      this.detailState.update((details) => ({
        ...details,
        [id]: { ...details[id], ...update.details },
      }));
    }
    if (update.units) {
      const incoming = update.units.filter(
        (unit) => unit.kind === 'unit' && unit.incidentId === id,
      );
      const ids = new Set(incoming.map((unit) => unit.id));
      this.unitState.update((units) => [
        ...units.filter((unit) => unit.incidentId !== id && !ids.has(unit.id)),
        ...incoming,
      ]);
      this.simulation.start(this.units());
    }
    const event = update.event;
    if (event && event.incidentId === id && Number.isFinite(Date.parse(event.occurredAt))) {
      this.eventState.update((events) => [
        ...events.filter((existing) => existing.incidentId !== id || existing.id !== event.id),
        event,
      ]);
    }
  }
}

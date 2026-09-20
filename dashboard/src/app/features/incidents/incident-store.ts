import { inject, Injectable, InjectionToken, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, Observable } from 'rxjs';
import { MOCK_COMMUNICATIONS, MOCK_INCIDENTS, MOCK_UNITS } from '../../core/data/operations.mock';
import { Incident, MapLocation } from '../../core/models/operations';
import { IncidentDetails, IncidentEvent, MOCK_INCIDENT_DETAILS } from './incidents.mock';
import { MOCK_RESOURCE_PROFILES } from '../resources/resources.mock';

function assignmentEvents(
  unit: MapLocation,
  occurredAt: string,
  actionId: string,
): IncidentEvent[] {
  if (!unit.incidentId) return [];
  const profile = MOCK_RESOURCE_PROFILES[unit.icon];
  const contact = MOCK_COMMUNICATIONS.find((item) => item.vehicle === unit.id)?.agent;
  const events: IncidentEvent[] = [
    {
      id: `${actionId}:vehicle`,
      incidentId: unit.incidentId,
      occurredAt,
      kind: 'assignment',
      title: `Vehículo asignado · ${unit.label}`,
      description: `${profile?.service ?? 'Apoyo'} movilizado para ${unit.incidentId}.`,
      source: 'Agente de coordinación',
    },
  ];
  if (profile)
    events.push({
      id: `${actionId}:people`,
      incidentId: unit.incidentId,
      occurredAt,
      kind: 'assignment',
      title: `${profile.crew} personas asignadas · ${unit.label}`,
      description: `Equipo de ${profile.service}${contact ? ` · Responsable: ${contact}` : ''}.`,
      source: 'Agente de coordinación',
    });
  return events;
}

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
  private readonly incidentState = signal<readonly Incident[]>(MOCK_INCIDENTS);
  private readonly detailState =
    signal<Readonly<Record<string, IncidentDetails>>>(MOCK_INCIDENT_DETAILS);
  private readonly unitState = signal<readonly MapLocation[]>(MOCK_UNITS);
  private readonly eventState = signal<readonly IncidentEvent[]>([
    ...MOCK_INCIDENTS.flatMap((incident) => {
      const openedAt = MOCK_INCIDENT_DETAILS[incident.id]?.openedAt;
      if (!openedAt) return [];
      return [
        {
          id: `${incident.id}:reported`,
          incidentId: incident.id,
          occurredAt: openedAt,
          title: 'Llamada recibida · Central 112',
          kind: 'call' as const,
          description: `${incident.title}. ${incident.address}.`,
          source: 'Central 112',
        },
      ];
    }),
    ...MOCK_UNITS.filter((unit) => unit.kind === 'unit' && unit.incidentId).flatMap((unit) => {
      const assignedAt = new Date(
        Date.parse(
          MOCK_INCIDENT_DETAILS[unit.incidentId!]?.openedAt ?? '2026-09-19T14:00:00+02:00',
        ) + 90000,
      ).toISOString();
      const communication = MOCK_COMMUNICATIONS.find((item) => item.vehicle === unit.id);
      return [
        {
          id: `${unit.id}:dispatch-call`,
          incidentId: unit.incidentId!,
          occurredAt: new Date(Date.parse(assignedAt) - 30000).toISOString(),
          kind: 'call' as const,
          title: `Llamada realizada · ${unit.label}`,
          description: `El agente solicita la intervención de ${communication?.agent ?? unit.label} en ${unit.incidentId}.`,
          source: 'Agente de coordinación',
        },
        ...assignmentEvents(unit, assignedAt, `${unit.id}:assigned`),
      ];
    }),
    ...MOCK_COMMUNICATIONS.map((communication) => ({
      id: communication.id,
      incidentId: communication.incidentId,
      occurredAt: `2026-09-19T${communication.time}:00+02:00`,
      title: `Llamada recibida · ${communication.vehicle}`,
      kind: 'call' as const,
      description: communication.message,
      source: `${communication.service} · ${communication.vehicle} · ${communication.agent}`,
    })),
  ]);
  readonly incidents = this.incidentState.asReadonly();
  readonly details = this.detailState.asReadonly();
  readonly units = this.unitState.asReadonly();
  readonly events = this.eventState.asReadonly();
  readonly updateError = signal(false);

  constructor() {
    inject(INCIDENT_UPDATES)
      .pipe(takeUntilDestroyed())
      .subscribe({
        next: (update) => this.applyUpdate(update),
        error: () => this.updateError.set(true),
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

  reassignUnit(unit: MapLocation, incidentId: string, actionId: string): void {
    if (unit.kind !== 'unit' || !this.incidents().some((incident) => incident.id === incidentId))
      return;
    this.unitState.update((units) =>
      units.map((existing) =>
        existing.id === unit.id
          ? {
              ...existing,
              incidentId,
              coordinates: unit.coordinates,
              address: unit.address,
              route: undefined,
            }
          : existing,
      ),
    );
    for (const event of assignmentEvents(
      { ...unit, incidentId },
      new Date().toISOString(),
      `${actionId}:${unit.id}`,
    ))
      this.appendEvent(event);
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
      this.unitState.update((units) => [
        ...units.filter((unit) => unit.incidentId !== id),
        ...update.units!.filter((unit) => unit.kind === 'unit' && unit.incidentId === id),
      ]);
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

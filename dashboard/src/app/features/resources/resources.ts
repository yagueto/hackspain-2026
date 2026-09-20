import { DatePipe, DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MapLocation } from '../../core/models/operations';
import { Operations, operatorError, taskIncidentId } from '../../core/services/operations';
import { DemoRouteSimulation } from '../../core/services/demo-route-simulation';
import { formatRouteDuration } from '../../core/services/routing';
import { Icon } from '../../shared/icon/icon';
import { OperationalMap } from '../home/operational-map/operational-map';
import { IncidentStore } from '../incidents/incident-store';

const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

@Component({
  selector: 'app-resources',
  imports: [DatePipe, DecimalPipe, RouterLink, Icon, OperationalMap],
  templateUrl: './resources.html',
  styleUrls: ['../incidents/incidents.css', './resources.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Resources {
  protected readonly store = inject(IncidentStore);
  protected readonly operations = inject(Operations);
  private readonly simulation = inject(DemoRouteSimulation);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly selectedId = signal<string | null>(null);
  protected readonly filters = signal({ query: '', service: '', status: '', incident: '' });
  private readonly sourceUnits = computed(() =>
    this.store.units().filter((unit) => unit.kind === 'unit'),
  );
  readonly units = computed(() => this.sourceUnits().map((unit) => this.simulation.project(unit)));
  protected readonly statuses = computed(() =>
    [...new Set(this.units().map((unit) => this.status(unit)))].sort(),
  );
  protected readonly services = computed(() =>
    [...new Set(this.sourceUnits().map((unit) => this.serviceName(unit)))].sort(),
  );
  protected readonly hasFilters = computed(() => Object.values(this.filters()).some(Boolean));
  readonly filteredUnits = computed(() => {
    const filters = this.filters();
    const terms = normalize(filters.query).trim().split(/\s+/).filter(Boolean);
    return this.units().filter((unit) => {
      const communication = this.latestCommunication(unit.id);
      const incident = this.store.incidents().find((item) => item.id === unit.incidentId);
      const text = normalize(
        `${unit.id} ${unit.label} ${this.serviceName(unit)} ${unit.address} ${unit.incidentId ?? ''} ${incident?.title ?? ''} ${communication?.agent ?? ''}`,
      );
      return (
        terms.every((term) => text.includes(term)) &&
        (!filters.service || filters.service === this.serviceName(unit)) &&
        (!filters.status || filters.status === this.status(unit)) &&
        (!filters.incident ||
          (filters.incident === 'unassigned'
            ? !unit.incidentId
            : unit.incidentId === filters.incident))
      );
    });
  });
  readonly selectedUnit = computed(() =>
    this.filteredUnits().find((unit) => unit.id === this.selectedId()),
  );
  private readonly selectedSource = computed(() =>
    this.sourceUnits().find((unit) => unit.id === this.selectedUnit()?.id),
  );
  protected readonly profile = computed(() => {
    const unit = this.selectedSource();
    const resource = this.operations.snapshot()?.resources.find((item) => item.id === unit?.id);
    return unit && resource
      ? {
          service: this.serviceName(unit),
          type: resource.name,
          capacity: resource.capacity ?? null,
          base: resource.location.label,
          capabilities: resource.notes ?? [],
        }
      : undefined;
  });
  protected readonly currentIncident = computed(() =>
    this.store.incidents().find((incident) => incident.id === this.selectedSource()?.incidentId),
  );
  protected readonly communication = computed(() =>
    this.latestCommunication(this.selectedSource()?.id ?? ''),
  );
  protected readonly contact = computed(() => {
    const unit = this.selectedSource();
    return unit
      ? this.operations
          .snapshot()
          ?.contacts.find(
            (contact) => contact.id === unit.contactId || contact.resource_id === unit.id,
          )
      : undefined;
  });
  protected readonly history = computed(() =>
    (this.operations.snapshot()?.tasks ?? [])
      .filter(
        (task) =>
          task.resource_ids.includes(this.selectedSource()?.id ?? '') &&
          ['done', 'cancelled', 'failed', 'rejected'].includes(task.status),
      )
      .map((task) => ({
        id: task.id,
        incidentId: taskIncidentId(task, this.operations.snapshot()?.incident.id),
        completedAt: task.updated_at || task.created_at || '',
        summary: task.outcome || task.title,
        incident: this.store.incidents().find((incident) => incident.id === taskIncidentId(task)),
      }))
      .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt)),
  );
  protected readonly mapLocations = computed<readonly MapLocation[]>(() => {
    const unit = this.selectedSource();
    if (!unit) return [];
    const incident = this.currentIncident();
    return incident?.coordinates
      ? [
          unit,
          {
            id: incident.id,
            label: incident.id,
            address: incident.address,
            coordinates: incident.coordinates,
            icon: incident.icon,
            kind: 'incident',
            incidentId: incident.id,
            radiusMeters: incident.radiusMeters,
          },
        ]
      : [unit];
  });
  protected readonly arrival = computed(() => {
    const unit = this.selectedUnit();
    if (unit?.etaMinutes != null) return `ETA comunicado: ${unit.etaMinutes} min`;
    const route = unit?.route;
    if (!route || route.status !== 'active') return null;
    const navigation = route.navigation;
    return navigation?.status === 'ready'
      ? `≈ ${formatRouteDuration(navigation.route.durationSeconds)}`
      : navigation?.status === 'loading'
        ? 'Calculando llegada…'
        : 'Tiempo no disponible';
  });
  protected readonly message = signal('');
  protected readonly channel = signal('call');
  protected readonly liveConfirmed = signal(false);
  protected readonly busy = signal(false);
  protected readonly feedback = signal('');

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const id = params.get('recurso');
      if (id && !this.filteredUnits().some((unit) => unit.id === id)) this.clearFilters();
      this.selectedId.set(id);
      this.message.set('');
      this.liveConfirmed.set(false);
      this.feedback.set('');
    });
    effect(() => {
      if (this.operations.snapshot() && !this.selectedUnit()) this.selectedId.set(null);
    });
  }

  selectResource(id: string): void {
    this.selectedId.set(id);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { recurso: id },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
  setFilter(key: 'query' | 'service' | 'status' | 'incident', value: string): void {
    this.filters.update((filters) => ({ ...filters, [key]: value }));
  }
  protected clearFilters(): void {
    this.filters.set({ query: '', service: '', status: '', incident: '' });
  }
  protected serviceName(unit: MapLocation): string {
    return unit.service || this.latestCommunication(unit.id)?.service || 'Recurso de apoyo';
  }
  protected status(unit: MapLocation): string {
    return (
      unit.resourceStatus ||
      (unit.route?.status === 'active'
        ? 'En camino'
        : unit.incidentId
          ? unit.route?.status === 'completed'
            ? 'En destino'
            : 'Asignado'
          : 'Disponible')
    );
  }
  protected openIncident(id: string): void {
    void this.router.navigate(['/incidencias'], { queryParams: { incidencia: id } });
  }
  private latestCommunication(id: string) {
    return this.operations.communications().find((item) => item.vehicle === id);
  }

  async send(event: Event): Promise<void> {
    event.preventDefault();
    const contact = this.contact(),
      message = this.message().trim();
    if (!contact || !message || this.busy()) return;
    if (
      !this.operations.meta() ||
      (this.operations.meta()?.happyrobot_mode === 'live' && !this.liveConfirmed())
    ) {
      this.feedback.set('Confirma explícitamente la comunicación real.');
      return;
    }
    this.busy.set(true);
    this.feedback.set('');
    try {
      const action = await (this.channel() === 'telegram'
        ? this.operations.telegram(contact.id, message)
        : this.operations.call(contact.id, message));
      this.feedback.set(
        `Orden ${action.id} registrada. El envío no confirma recepción ni movilización.`,
      );
      this.message.set('');
      this.liveConfirmed.set(false);
      this.operations.refresh();
    } catch (error) {
      this.feedback.set(operatorError(error));
    } finally {
      this.busy.set(false);
    }
  }
}

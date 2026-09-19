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
import { MOCK_COMMUNICATIONS } from '../../core/data/operations.mock';
import { MapLocation } from '../../core/models/operations';
import { DemoRouteSimulation } from '../../core/services/demo-route-simulation';
import { formatRouteDuration } from '../../core/services/routing';
import { Icon } from '../../shared/icon/icon';
import { OperationalMap } from '../home/operational-map/operational-map';
import { IncidentStore } from '../incidents/incident-store';
import { MOCK_RESOURCE_HISTORY, MOCK_RESOURCE_PROFILES } from './resources.mock';

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
  private readonly simulation = inject(DemoRouteSimulation);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly selectedId = signal<string | null>(null);
  protected readonly filters = signal({ query: '', service: '', status: '', incident: '' });
  protected readonly statuses = ['Asignado', 'En camino', 'En destino', 'Disponible'];
  private readonly sourceUnits = computed(() =>
    this.store.units().filter((unit) => unit.kind === 'unit'),
  );
  readonly units = computed(() => this.sourceUnits().map((unit) => this.simulation.project(unit)));
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
    return unit ? MOCK_RESOURCE_PROFILES[unit.icon] : undefined;
  });
  protected readonly currentIncident = computed(() =>
    this.store.incidents().find((incident) => incident.id === this.selectedSource()?.incidentId),
  );
  protected readonly communication = computed(() =>
    this.latestCommunication(this.selectedSource()?.id ?? ''),
  );
  protected readonly history = computed(() =>
    MOCK_RESOURCE_HISTORY.filter((entry) =>
      entry.resourceIds.includes(this.selectedSource()?.id ?? ''),
    )
      .map((entry) => ({
        ...entry,
        incident: this.store.incidents().find((incident) => incident.id === entry.incidentId),
      }))
      .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt)),
  );
  protected readonly mapLocations = computed<readonly MapLocation[]>(() => {
    const unit = this.selectedSource();
    if (!unit) return [];
    const incident = this.currentIncident();
    return incident
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
    const route = this.selectedUnit()?.route;
    if (!route || route.status !== 'active') return null;
    const navigation = route.navigation;
    return navigation?.status === 'ready'
      ? `≈ ${formatRouteDuration(navigation.route.durationSeconds)}`
      : navigation?.status === 'loading'
        ? 'Calculando llegada…'
        : 'Tiempo no disponible';
  });

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const id = params.get('recurso');
      if (id && !this.filteredUnits().some((unit) => unit.id === id)) this.clearFilters();
      this.selectedId.set(id);
    });
    effect(() => {
      if (!this.selectedUnit()) this.selectedId.set(null);
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
    return MOCK_RESOURCE_PROFILES[unit.icon]?.service ?? 'Apoyo';
  }

  protected status(unit: MapLocation): string {
    return unit.route?.status === 'active'
      ? 'En camino'
      : unit.incidentId
        ? unit.route?.status === 'completed'
          ? 'En destino'
          : 'Asignado'
        : 'Disponible';
  }

  protected openIncident(id: string): void {
    void this.router.navigate(['/incidencias'], { queryParams: { incidencia: id } });
  }

  private latestCommunication(id: string) {
    return MOCK_COMMUNICATIONS.filter((item) => item.vehicle === id).sort((a, b) =>
      b.time.localeCompare(a.time),
    )[0];
  }
}

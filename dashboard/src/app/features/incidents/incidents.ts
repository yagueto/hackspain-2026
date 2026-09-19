import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Incident, MapLocation } from '../../core/models/operations';
import { IncidentActivity } from './incident-activity';
import { Icon } from '../../shared/icon/icon';
import { OperationalMap } from '../home/operational-map/operational-map';
import { IncidentStore } from './incident-store';

const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

@Component({
  selector: 'app-incidents',
  imports: [DatePipe, Icon, OperationalMap, IncidentActivity],
  templateUrl: './incidents.html',
  styleUrl: './incidents.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Incidents {
  protected readonly store = inject(IncidentStore);
  private readonly route = inject(ActivatedRoute, { optional: true });
  private readonly router = inject(Router, { optional: true });
  protected readonly filters = signal({ query: '', category: '', priority: '', status: '' });
  protected readonly severity: Record<NonNullable<Incident['priority']>, string> = {
    P0: 'Crítica',
    P1: 'Grave',
    P2: 'Moderada',
    P3: 'Baja',
  };
  protected readonly priorities = ['P0', 'P1', 'P2', 'P3'] as const;
  private readonly selectedId = signal<string | null>(null);
  private readonly unitId = signal<string | null>(null);
  private readonly detailMap = viewChild<ElementRef<HTMLElement>>('detailMap');
  protected readonly categories = computed(() =>
    [...new Set(this.store.incidents().map((incident) => this.category(incident)))].sort(),
  );
  protected readonly statuses = computed(() =>
    [...new Set(this.store.incidents().map((incident) => incident.status))].sort(),
  );
  protected readonly hasFilters = computed(() => Object.values(this.filters()).some(Boolean));
  readonly filteredIncidents = computed(() => {
    const { query, category, priority, status } = this.filters();
    const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
    return this.store.incidents().filter((incident) => {
      const text = normalize(
        `${incident.id} ${incident.title} ${incident.address} ${incident.area} ${this.category(incident)}`,
      );
      return (
        terms.every((term) => text.includes(term)) &&
        (!category || this.category(incident) === category) &&
        (!priority || incident.priority === priority) &&
        (!status || incident.status === status)
      );
    });
  });
  readonly selectedIncident = computed(() =>
    this.filteredIncidents().find((incident) => incident.id === this.selectedId()),
  );
  protected readonly details = computed(
    () => this.store.details()[this.selectedIncident()?.id ?? ''],
  );
  protected readonly services = computed(() => {
    const id = this.selectedIncident()?.id;
    return id
      ? this.store.units().filter((unit) => unit.kind === 'unit' && unit.incidentId === id)
      : [];
  });
  readonly selectedUnitId = computed(
    () => this.services().find((unit) => unit.id === this.unitId())?.id ?? null,
  );
  protected readonly timeline = computed(() =>
    this.store
      .events()
      .filter((event) => event.incidentId === this.selectedIncident()?.id)
      .sort(
        (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id),
      ),
  );
  protected readonly locations = computed<readonly MapLocation[]>(() => {
    const incident = this.selectedIncident();
    return incident
      ? [
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
          ...this.services(),
        ]
      : [];
  });

  constructor() {
    this.route?.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const id = params.get('incidencia');
      if (id && !this.filteredIncidents().some((incident) => incident.id === id))
        this.clearFilters();
      this.selectedId.set(id);
      this.unitId.set(null);
    });
    effect(() => {
      if (!this.selectedIncident()) {
        this.selectedId.set(null);
        this.unitId.set(null);
      }
    });
  }

  setFilter(key: 'query' | 'category' | 'priority' | 'status', value: string): void {
    this.filters.update((filters) => ({ ...filters, [key]: value }));
  }

  protected clearFilters(): void {
    this.filters.set({ query: '', category: '', priority: '', status: '' });
  }

  selectIncident(id: string): void {
    this.selectedId.set(id);
    this.unitId.set(null);
    if (this.route && this.router) {
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { incidencia: id },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    }
  }

  protected selectUnit(id: string): void {
    if (!this.services().some((unit) => unit.id === id)) return;
    this.unitId.set(id);
    this.detailMap()?.nativeElement.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
  }

  protected category(incident: Incident): string {
    return this.store.details()[incident.id]?.category ?? incident.title;
  }
}

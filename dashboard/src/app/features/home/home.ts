import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MOCK_COMMUNICATIONS } from '../../core/data/operations.mock';
import { MapLocation } from '../../core/models/operations';
import { IncidentList } from './incident-list/incident-list';
import { OperationalMap } from './operational-map/operational-map';
import { ServiceFeed } from './service-feed/service-feed';
import { SplitPane } from '../../shared/split-pane/split-pane';
import { DemoRouteSimulation } from '../../core/services/demo-route-simulation';
import { IncidentStore } from '../incidents/incident-store';
import { OperationLogStore } from './operation-log/operation-log-store';
import { Incidents } from '../incidents/incidents';
import { Resources } from '../resources/resources';
import { Icon } from '../../shared/icon/icon';

@Component({
  selector: 'app-home',
  imports: [
    OperationalMap,
    IncidentList,
    ServiceFeed,
    SplitPane,
    Incidents,
    Resources,
    Icon,
    RouterLink,
  ],
  host: { '(window:keydown)': 'handleKeyboard($event)' },
  templateUrl: './home.html',
  styleUrl: './home.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {
  private readonly simulation = inject(DemoRouteSimulation);
  private readonly store = inject(IncidentStore);
  private readonly route = inject(ActivatedRoute, { optional: true });
  private readonly router = inject(Router, { optional: true });
  protected readonly log = inject(OperationLogStore);
  readonly detail = signal<'incident' | 'resource' | null>(null);
  readonly incidents = this.store.incidents;
  readonly units = this.store.units;
  readonly communications = computed(() =>
    MOCK_COMMUNICATIONS.map((item) => {
      const unit = this.units().find((unit) => unit.id === item.vehicle);
      return unit ? { ...item, incidentId: unit.incidentId ?? 'Sin asignar' } : item;
    }),
  );
  readonly addresses = computed(() => this.incidents().map((incident) => incident.address));
  readonly projectedUnits = computed(() =>
    this.units().map((unit) => this.simulation.project(unit)),
  );
  readonly selectedIncidentId = signal<string | null>(null);
  readonly selectedUnitId = signal<string | null>(null);
  readonly visibleUnitIds = signal<readonly string[] | null>(null);
  readonly locations = computed<MapLocation[]>(() => [
    ...this.incidents().map((incident) => ({
      id: incident.id,
      label: incident.id,
      address: incident.address,
      coordinates: incident.coordinates,
      icon: incident.icon,
      kind: 'incident' as const,
      incidentId: incident.id,
      radiusMeters: incident.radiusMeters,
    })),
    ...this.units(),
  ]);

  constructor() {
    this.route?.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const incidentId = params.get('incidencia');
      const unitId = params.get('recurso');
      const incident = this.incidents().find((item) => item.id === incidentId);
      const unit = this.units().find((item) => item.kind === 'unit' && item.id === unitId);
      this.detail.set(incident ? 'incident' : unit ? 'resource' : null);
      this.selectedIncidentId.set(incident?.id ?? null);
      this.selectedUnitId.set(incident ? null : (unit?.id ?? null));
    });
  }

  protected openIncident(id: string): void {
    void this.router?.navigate(['/'], { queryParams: { incidencia: id } });
  }

  protected locateUnit(id: string): void {
    this.selectedUnitId.set(id);
  }

  protected handleKeyboard(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (
      event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'i'
    ) {
      event.preventDefault();
      if (!event.repeat) this.log.generateDemoQuestion();
    }
  }

  selectIncident(id: string): void {
    if (this.incidents().some((incident) => incident.id === id)) {
      if (this.detail()) {
        this.openIncident(id);
        return;
      }
      this.selectedUnitId.set(null);
      this.selectedIncidentId.update((selected) => (selected === id ? null : id));
    }
  }

  selectUnit(id: string): void {
    if (this.units().some((unit) => unit.kind === 'unit' && unit.id === id)) {
      if (this.detail()) {
        void this.router?.navigate(['/'], { queryParams: { recurso: id } });
        return;
      }
      this.selectedIncidentId.set(null);
      this.selectedUnitId.update((selected) => (selected === id ? null : id));
    }
  }
}

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MOCK_COMMUNICATIONS, MOCK_INCIDENTS, MOCK_UNITS } from '../../core/data/operations.mock';
import { MapLocation } from '../../core/models/operations';
import { IncidentList } from './incident-list/incident-list';
import { OperationalMap } from './operational-map/operational-map';
import { ServiceFeed } from './service-feed/service-feed';
import { SplitPane } from '../../shared/split-pane/split-pane';
import { DemoRouteSimulation } from '../../core/services/demo-route-simulation';

@Component({
  selector: 'app-home',
  imports: [OperationalMap, IncidentList, ServiceFeed, SplitPane],
  templateUrl: './home.html',
  styleUrl: './home.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {
  private readonly simulation = inject(DemoRouteSimulation);
  readonly incidents = signal(MOCK_INCIDENTS);
  readonly communications = signal(MOCK_COMMUNICATIONS);
  readonly units = signal(MOCK_UNITS);
  readonly addresses = signal<string[]>(MOCK_INCIDENTS.map((incident) => incident.address));
  readonly projectedUnits = computed(() =>
    this.units().map((unit) => this.simulation.project(unit)),
  );
  readonly selectedIncidentId = signal<string | null>(null);
  readonly selectedUnitId = signal<string | null>(null);
  readonly locations = computed<MapLocation[]>(() => [
    ...this.incidents().map((incident) => ({
      id: incident.id,
      label: incident.id,
      address: incident.address,
      coordinates: incident.coordinates,
      icon: incident.icon,
      kind: 'incident' as const,
      incidentId: incident.id,
    })),
    ...this.units(),
  ]);

  selectIncident(id: string): void {
    if (this.incidents().some((incident) => incident.id === id)) {
      this.selectedUnitId.set(null);
      this.selectedIncidentId.update((selected) => (selected === id ? null : id));
    }
  }

  selectUnit(id: string): void {
    if (this.units().some((unit) => unit.kind === 'unit' && unit.id === id)) {
      this.selectedIncidentId.set(null);
      this.selectedUnitId.update((selected) => (selected === id ? null : id));
    }
  }
}

import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { Communication, Incident, MapLocation } from '../../core/models/operations';
import { Operations } from '../../core/services/operations';
import { DemoRouteSimulation } from '../../core/services/demo-route-simulation';
import { IncidentDetails, IncidentEvent } from './incidents.mock';
import { OperationTimeline } from '../home/operation-log/operation-timeline';
import { ServiceFeed } from '../home/service-feed/service-feed';
import { Icon } from '../../shared/icon/icon';

@Component({
  selector: 'app-incident-activity',
  imports: [OperationTimeline, ServiceFeed, Icon],
  templateUrl: './incident-activity.html',
  styleUrl: './incident-activity.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IncidentActivity {
  private readonly operations = inject(Operations);
  private readonly simulation = inject(DemoRouteSimulation);
  readonly incident = input.required<Incident>();
  readonly details = input<IncidentDetails>();
  readonly timeline = input.required<readonly IncidentEvent[]>();
  readonly services = input.required<readonly MapLocation[]>();
  readonly selectedUnitId = input<string | null>(null);
  readonly updateError = input(false);
  readonly unitSelected = output<string>();
  protected readonly projectedServices = computed(() =>
    this.services().map((unit) => this.simulation.project(unit)),
  );
  /** Las comunicaciones vienen del backend, una por recurso; aquí solo se filtran las asignadas. */
  protected readonly communications = computed<readonly Communication[]>(() => {
    const assigned = new Set(this.services().map((unit) => unit.id));
    return this.operations
      .communications()
      .filter((communication) => assigned.has(communication.vehicle));
  });
}

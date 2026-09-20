import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { Communication, Incident, MapLocation } from '../../core/models/operations';
import { MOCK_COMMUNICATIONS } from '../../core/data/operations.mock';
import { DemoRouteSimulation } from '../../core/services/demo-route-simulation';
import { IncidentDetails, IncidentEvent } from './incidents.mock';
import { OperationTimeline } from '../home/operation-log/operation-timeline';
import { ServiceFeed } from '../home/service-feed/service-feed';
import { MOCK_RESOURCE_PROFILES } from '../resources/resources.mock';
import { Icon } from '../../shared/icon/icon';

@Component({
  selector: 'app-incident-activity',
  imports: [OperationTimeline, ServiceFeed, Icon],
  templateUrl: './incident-activity.html',
  styleUrl: './incident-activity.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IncidentActivity {
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
  protected readonly communications = computed<readonly Communication[]>(() =>
    this.services().map((unit) => {
      const communication = MOCK_COMMUNICATIONS.filter((item) => item.vehicle === unit.id).sort(
        (a, b) => b.time.localeCompare(a.time),
      )[0];
      return {
        ...(communication ?? {
          id: unit.id,
          time: '',
          status: 'Asignado' as const,
          message: `${unit.label} asignado a ${this.incident().id}.`,
          service: MOCK_RESOURCE_PROFILES[unit.icon]?.service ?? 'Apoyo',
          vehicle: unit.id,
          agent: '',
          icon: unit.icon,
        }),
        incidentId: this.incident().id,
      };
    }),
  );
}

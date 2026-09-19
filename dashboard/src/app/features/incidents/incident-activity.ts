import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { IconName, Incident, MapLocation } from '../../core/models/operations';
import { Icon } from '../../shared/icon/icon';
import { DemoRouteSimulation } from '../../core/services/demo-route-simulation';
import { IncidentDetails, IncidentEvent } from './incidents.mock';

const SERVICE_NAMES: Partial<Record<IconName, string>> = {
  'fire-truck': 'Bomberos',
  helicopter: 'Apoyo aéreo',
  bus: 'Transporte',
  medical: 'Sanitarios',
  shield: 'Policía',
  tools: 'Guardia Civil',
  truck: 'Logística',
};

@Component({
  selector: 'app-incident-activity',
  imports: [DatePipe, Icon],
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

  protected serviceName(unit: MapLocation): string {
    return SERVICE_NAMES[unit.icon] ?? 'Recurso de apoyo';
  }

  protected serviceStatus(unit: MapLocation): string {
    unit = this.simulation.project(unit);
    return unit.route?.status === 'active'
      ? 'En camino'
      : unit.route?.status === 'completed'
        ? 'En destino'
        : 'Asignado';
  }
}

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { MapLocation } from '../../core/models/operations';
import { GeocodedPlace, OperationalTask } from '../../core/models/world';
import { Operations } from '../../core/services/operations';
import { IncidentList } from './incident-list/incident-list';
import { OperationalMap } from './operational-map/operational-map';
import { ServiceFeed } from './service-feed/service-feed';

@Component({
  selector: 'app-home',
  imports: [OperationalMap, IncidentList, ServiceFeed],
  templateUrl: './home.html',
  styleUrl: './home.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {
  readonly operations = inject(Operations);
  readonly incidents = this.operations.incidents;
  readonly communications = this.operations.communications;
  readonly units = this.operations.units;
  readonly addresses = computed(() =>
    this.incidents()
      .filter((incident) => incident.coordinates)
      .map((incident) => incident.address),
  );
  readonly selectedIncidentId = signal<string | null>(null);
  readonly selectedUnitId = signal<string | null>(null);
  readonly selectedIncident = computed(() =>
    this.incidents().find((incident) => incident.id === this.selectedIncidentId()),
  );
  readonly operatorKey = this.operations.operatorKey;
  readonly operatorMessage = signal('');
  readonly operatorBusy = signal(false);
  readonly reviewedLocation = signal<string | null>(null);
  readonly latitude = signal('');
  readonly longitude = signal('');
  readonly selectedReport = computed(() => {
    const id = this.selectedIncidentId();
    return id?.startsWith('call:')
      ? this.operations.snapshot()?.incoming_calls.find((report) => `call:${report.run_id}` === id)
      : undefined;
  });
  readonly reportTime = computed(() => {
    const report = this.selectedReport();
    return report ? new Date(report.timestamp).toLocaleString('es-ES') : '';
  });
  readonly reportTasks = computed(() => {
    const report = this.selectedReport();
    return report
      ? this.operations
          .snapshot()
          ?.tasks.filter((task) => task.incoming_call_id === report.run_id) || []
      : [];
  });
  readonly locationVersion = computed(() => {
    const report = this.selectedReport();
    return JSON.stringify([report?.timestamp, report?.location, report?.resolution]);
  });
  readonly locationReviewed = computed(() => this.reviewedLocation() === this.locationVersion());
  readonly paused = this.operations.paused;
  readonly hasQueuedOrders = computed(() =>
    this.reportTasks().some((task) => task.status === 'dispatching'),
  );
  readonly taskLabels: Record<string, string> = {
    awaiting_approval: 'Pendiente de confirmación',
    proposed: 'En espera de recurso compatible',
    dispatching: 'Orden preparada, aún no enviada',
    dispatched: 'Orden enviada, respuesta pendiente',
    accepted: 'Aceptada por el recurso',
    in_progress: 'En curso',
    done: 'Finalizada',
    rejected: 'Rechazada',
    cancelled: 'Cancelada',
    failed: 'Fallida',
  };
  readonly connectionLabel = computed(
    () =>
      ({
        loading: 'Conectando con la API…',
        live: 'Actualización en directo',
        reconnecting: 'Reconectando al directo · actualización periódica activa',
        offline: 'Sin conexión · los datos pueden estar desactualizados',
      })[this.operations.connection()],
  );
  readonly locations = computed<MapLocation[]>(() => [
    ...this.incidents().flatMap((incident) =>
      incident.coordinates
        ? [
            {
              id: incident.id,
              label: incident.id,
              address: incident.address,
              detail: incident.locationStatus,
              coordinates: incident.coordinates,
              icon: incident.icon,
              kind: 'incident' as const,
              incidentId: incident.id,
            },
          ]
        : [],
    ),
    ...this.units(),
  ]);

  constructor() {
    this.operations.start();
    effect(() => {
      if (!this.incidents().some((incident) => incident.id === this.selectedIncidentId()))
        this.selectedIncidentId.set(null);
      if (!this.units().some((unit) => unit.id === this.selectedUnitId()))
        this.selectedUnitId.set(null);
    });
  }

  /** Segundos que faltan para que salga una decisión automática, o null si ya no aplica. */
  holdRemaining(task: OperationalTask): number | null {
    if (!task.hold_until || task.status !== 'dispatching') return null;
    const remaining = Date.parse(task.hold_until) - this.operations.now();
    return Number.isFinite(remaining) && remaining > 0 ? Math.ceil(remaining / 1000) : null;
  }

  approximateLocation(task: OperationalTask): boolean {
    const report = this.selectedReport();
    return (
      !!task.target_location &&
      report?.resolution?.status === 'resolved' &&
      report.location.lat == null
    );
  }

  selectIncident(id: string): void {
    if (this.incidents().some((incident) => incident.id === id)) {
      this.selectedUnitId.set(null);
      this.selectedIncidentId.set(id);
      this.reviewedLocation.set(null);
      this.operatorMessage.set('');
      const coordinates = this.selectedIncident()?.coordinates;
      this.latitude.set(coordinates?.lat.toString() || '');
      this.longitude.set(coordinates?.lng.toString() || '');
    }
  }

  async searchLocation(): Promise<void> {
    const report = this.selectedReport();
    if (!report) return;
    await this.runOperatorAction(() => this.operations.geocode(report));
  }

  async chooseLocation(location: GeocodedPlace): Promise<void> {
    const report = this.selectedReport();
    if (!report) return;
    await this.runOperatorAction(() => this.operations.confirmLocation(report, location));
    this.reviewedLocation.set(null);
  }

  async confirmCoordinates(): Promise<void> {
    const lat = Number(this.latitude()),
      lng = Number(this.longitude());
    if (
      !this.latitude().trim() ||
      !this.longitude().trim() ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      this.operatorMessage.set('Introduce latitud y longitud válidas, con punto decimal.');
      return;
    }
    await this.chooseLocation({
      lat,
      lng,
      label: this.selectedIncident()?.address || 'Ubicación confirmada',
      kind: 'manual',
    });
  }

  async approveTask(task: OperationalTask, approved: boolean): Promise<void> {
    if (approved && (!this.locationReviewed() || !task.target_location)) return;
    await this.runOperatorAction(() =>
      this.operations.approve(task, approved, this.locationReviewed()),
    );
  }

  async cancelTask(task: OperationalTask): Promise<void> {
    await this.runOperatorAction(() => this.operations.cancelTask(task));
  }

  async resumeSimulated(): Promise<void> {
    await this.runOperatorAction(() => this.operations.resumeSimulated());
  }

  private async runOperatorAction(action: () => Promise<unknown>): Promise<void> {
    if (this.operatorBusy()) return;
    this.operatorBusy.set(true);
    this.operatorMessage.set('');
    try {
      await action();
      this.operatorMessage.set('Operación guardada. Consulta el estado de la propuesta.');
      this.operations.refresh();
    } catch (error) {
      this.operatorMessage.set(
        error instanceof HttpErrorResponse
          ? error.status === 401
            ? 'Clave de operador incorrecta.'
            : typeof error.error?.detail === 'string'
              ? error.error.detail
              : 'No se pudo completar la operación.'
          : error instanceof Error
            ? error.message
            : 'No se pudo completar la operación.',
      );
    } finally {
      this.operatorBusy.set(false);
    }
  }

  selectUnit(id: string): void {
    if (this.units().some((unit) => unit.kind === 'unit' && unit.id === id)) {
      this.selectedIncidentId.set(null);
      this.selectedUnitId.set(id);
    }
  }
}

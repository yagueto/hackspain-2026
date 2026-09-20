import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MapLocation } from '../../core/models/operations';
import { GeocodedPlace, OperationalTask } from '../../core/models/world';
import { Operations } from '../../core/services/operations';
import { IncidentList } from './incident-list/incident-list';
import { OperationalMap } from './operational-map/operational-map';
import { ServiceFeed } from './service-feed/service-feed';
import { SplitPane } from '../../shared/split-pane/split-pane';
import { IncidentStore } from '../incidents/incident-store';
import { OperationLogStore } from './operation-log/operation-log-store';
import { OperationLogPanel } from './operation-log/operation-log-panel';

@Component({
  selector: 'app-home',
  imports: [OperationalMap, IncidentList, ServiceFeed, SplitPane, OperationLogPanel, RouterLink],
  host: { '(window:keydown)': 'handleKeyboard($event)' },
  templateUrl: './home.html',
  styleUrl: './home.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {
  readonly operations = inject(Operations);
  private readonly store = inject(IncidentStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute, { optional: true });
  protected readonly log = inject(OperationLogStore);
  protected readonly logOverlay = signal(false);
  readonly incidents = this.store.incidents;
  readonly communications = this.operations.communications;
  readonly units = this.store.units;
  readonly addresses = computed(() =>
    this.incidents()
      .filter((incident) => incident.coordinates)
      .map((incident) => incident.address),
  );
  readonly selectedIncidentId = signal<string | null>(null);
  readonly selectedUnitId = signal<string | null>(null);
  readonly visibleUnitIds = signal<readonly string[] | null>(null);
  readonly selectedIncident = computed(() =>
    this.incidents().find((incident) => incident.id === this.selectedIncidentId()),
  );
  readonly operatorKey = this.operations.operatorKey;
  readonly operatorMessage = signal('');
  readonly operatorBusy = signal(false);
  readonly reviewedLocation = signal<string | null>(null);
  readonly locationOpen = signal(false);
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
  /** Una decisión bloqueada por la ubicación necesita al operador: se abre ya el panel. */
  readonly needsLocationHelp = computed(() => {
    const status = this.selectedReport()?.resolution?.status;
    return (
      this.reportTasks().some((task) => !!task.blocked_reason) ||
      status === 'ambiguous' ||
      status === 'not_found' ||
      status === 'unavailable'
    );
  });
  readonly paused = this.operations.paused;
  readonly hasQueuedOrders = computed(() =>
    this.reportTasks().some((task) => task.status === 'dispatching'),
  );
  readonly taskLabels: Record<string, string> = {
    awaiting_approval: 'Pendiente de confirmación',
    proposed: 'Decidida; esperando una unidad disponible',
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
              radiusMeters: incident.radiusMeters,
            },
          ]
        : [],
    ),
    ...this.units(),
  ]);

  constructor() {
    this.operations.start();
    this.log.start();
    this.route?.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const id = params.get('incidencia');
      if (id) this.selectedIncidentId.set(id);
      if (params.get('registro') === 'misiones') {
        this.log.incidentFilter.set(id);
        this.log.view.set('missions');
        this.log.open.set(true);
      }
    });
    effect(() => {
      if (
        (this.operations.snapshot() || this.operations.connection() === 'live') &&
        !this.incidents().some((incident) => incident.id === this.selectedIncidentId())
      )
        this.selectedIncidentId.set(null);
      if (!this.units().some((unit) => unit.id === this.selectedUnitId()))
        this.selectedUnitId.set(null);
    });
    let lastCoordinates = '';
    effect(() => {
      const point = this.selectedIncident()?.coordinates;
      const version = JSON.stringify([this.selectedIncidentId(), point?.lat, point?.lng]);
      if (version === lastCoordinates) return;
      lastCoordinates = version;
      this.latitude.set(point?.lat.toString() || '');
      this.longitude.set(point?.lng.toString() || '');
    });
    // Si la decisión se bloquea mientras la incidencia ya está abierta, saca los controles
    // de ubicación a la vista. Solo abre: cerrarlo a mano se respeta.
    effect(() => {
      if (this.needsLocationHelp()) this.locationOpen.set(true);
    });
    effect((onCleanup) => {
      if (!this.log.open() || !this.logOverlay()) return;
      const previous = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      onCleanup(() => {
        document.body.style.overflow = previous;
      });
    });
    afterNextRender(() => {
      const media = window.matchMedia?.('(max-width: 1199px)');
      if (!media) return;
      const update = () => this.logOverlay.set(media.matches);
      update();
      media.addEventListener('change', update);
      this.destroyRef.onDestroy(() => media.removeEventListener('change', update));
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

  protected closeLog(): void {
    this.log.open.set(false);
    queueMicrotask(() => document.getElementById('log-toggle')?.focus({ preventScroll: true }));
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
      if (!event.repeat) void this.log.generateDemoQuestion();
    } else if (event.key === 'Escape' && this.log.open()) {
      event.preventDefault();
      this.closeLog();
    }
  }

  selectIncident(id: string): void {
    if (!this.incidents().some((incident) => incident.id === id)) return;
    this.selectedUnitId.set(null);
    this.selectedIncidentId.update((selected) => (selected === id ? null : id));
    this.reviewedLocation.set(null);
    this.operatorMessage.set('');
    this.locationOpen.set(this.needsLocationHelp());
  }

  async searchLocation(): Promise<void> {
    const report = this.selectedReport();
    if (report) await this.runOperatorAction(() => this.operations.geocode(report));
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
    if (approved && (!this.operations.meta() || !this.locationReviewed() || !task.target_location))
      return;
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
      this.selectedUnitId.update((selected) => (selected === id ? null : id));
    }
  }
}

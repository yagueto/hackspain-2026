import { HttpClient } from '@angular/common/http';
import {
  DOCUMENT,
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  inject,
  signal,
} from '@angular/core';
import { firstValueFrom, Subscription } from 'rxjs';
import {
  Communication,
  CommunicationStatus,
  Coordinates,
  IconName,
  Incident,
  MapLocation,
} from '../models/operations';
import {
  GeocodedPlace,
  IncomingCall,
  OperationalTask,
  ReportedLocation,
  WorldSnapshot,
} from '../models/world';

export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () =>
    inject(DOCUMENT).querySelector<HTMLMetaElement>('meta[name="api-base-url"]')?.content ||
    '/api/v1',
});

export const STREAM_FACTORY = new InjectionToken<(url: string) => EventSource | null>(
  'STREAM_FACTORY',
  {
    providedIn: 'root',
    factory: () => (url) => (typeof EventSource === 'undefined' ? null : new EventSource(url)),
  },
);

const resourceTypes: Record<string, { icon: IconName; service: string }> = {
  fire_engine: { icon: 'fire-truck', service: 'Bomberos' },
  ambulance: { icon: 'medical', service: 'Sanitarios' },
  police_unit: { icon: 'shield', service: 'Policía' },
  helicopter: { icon: 'helicopter', service: 'Medios aéreos' },
  bulldozer: { icon: 'tools', service: 'Maquinaria' },
  evacuation_bus: { icon: 'bus', service: 'Evacuación' },
};
const resourceStatuses: Record<string, CommunicationStatus> = {
  available: 'Disponible',
  reserved: 'Reservado',
  en_route: 'En ruta',
  dispatched: 'Enviado',
  on_scene: 'En intervención',
  returning: 'Regresando',
  out_of_service: 'Fuera de servicio',
};
const emergencyIcons: Record<string, IconName> = {
  sanitaria: 'heart',
  incendio: 'fire',
  seguridad: 'shield',
  trafico: 'barrier',
  rescate: 'walk',
};
const timeFormatter = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });

function coordinates(value: { lat?: number | null; lng?: number | null }): Coordinates | undefined {
  return typeof value.lat === 'number' &&
    typeof value.lng === 'number' &&
    Number.isFinite(value.lat) &&
    Number.isFinite(value.lng) &&
    Math.abs(value.lat) <= 90 &&
    Math.abs(value.lng) <= 180
    ? { lat: value.lat, lng: value.lng }
    : undefined;
}

function address(location: ReportedLocation): string {
  return (
    location.raw_text ||
    [
      location.street,
      location.number,
      location.floor_door,
      location.city,
      location.road,
      location.kilometer ? `km ${location.kilometer}` : '',
      location.direction,
    ]
      .filter(Boolean)
      .join(', ') ||
    'Ubicación desconocida'
  );
}

function priority(severity: string): Incident['priority'] {
  return ['vital', 'critical'].includes(severity)
    ? 'P0'
    : ['grave', 'high'].includes(severity)
      ? 'P1'
      : 'P2';
}

export function toOperations(state: WorldSnapshot): {
  incidents: Incident[];
  units: MapLocation[];
  communications: Communication[];
} {
  const incidents: Incident[] = (state.incoming_calls ?? []).map((call) => {
    const resolution = call.resolution;
    const resolved = resolution?.selected ? coordinates(resolution.selected) : undefined;
    const reported = call.location.confirmed ? coordinates(call.location) : undefined;
    const point = resolution?.status === 'confirmed' ? resolved : reported || resolved;
    const locationStatus =
      resolution?.status === 'confirmed'
        ? 'Ubicación revisada por operador · no es GPS automático'
        : reported
          ? 'Coordenadas confirmadas por el informante'
          : resolved
            ? 'Ubicación aproximada de OpenStreetMap · revisar antes de aprobar'
            : resolution?.status === 'ambiguous'
              ? 'Coincidencias ambiguas o precisión insuficiente'
              : 'Ubicación pendiente de confirmar en el mapa';
    const tasks = state.tasks.filter((task) => task.incoming_call_id === call.run_id);
    return {
      id: `call:${call.run_id}`,
      title: `Aviso: ${call.emergency_type}`,
      area: address(call.location),
      address: address(call.location),
      priority: priority(call.severity),
      status: !point
        ? 'Ubicación pendiente'
        : tasks.some((task) => task.status === 'awaiting_approval')
          ? 'Pendiente de aprobación'
          : tasks.some((task) => task.status === 'dispatching')
            ? 'Orden pendiente'
            : tasks.some((task) => task.status === 'dispatched')
              ? 'Respuesta pendiente'
              : call.escalation_required
                ? 'Revisión urgente'
                : 'Recibida',
      coordinates: point,
      icon: emergencyIcons[call.emergency_type] ?? 'pin',
      locationStatus,
      description: [
        call.notes,
        call.victims.count != null ? `Personas afectadas: ${call.victims.count}` : '',
        call.escalation_required ? 'Requiere revisión de un operador.' : '',
        call.location.accuracy_m ? `Precisión declarada: ${call.location.accuracy_m} m.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  });
  incidents.push(
    ...state.fronts
      .filter((front) => front.contained_pct < 100)
      .map((front): Incident => ({
        id: front.id,
        title: front.name,
        area: front.location.label || front.name,
        address: front.location.label || front.name,
        coordinates: coordinates(front.location),
        priority: priority(front.intensity),
        icon: 'fire',
        status: `Contenido ${front.contained_pct}%`,
      })),
  );
  incidents.push(
    ...state.zones
      .filter(
        (zone) =>
          zone.injured > 0 ||
          ['high', 'critical'].includes(zone.threat) ||
          !['none', 'completed'].includes(zone.evacuation_status),
      )
      .map((zone): Incident => ({
        id: zone.id,
        title: zone.name,
        area: zone.location.label || zone.name,
        address: zone.location.label || zone.name,
        coordinates: coordinates(zone.location),
        priority: priority(zone.threat),
        icon: zone.injured ? 'heart' : 'walk',
        status: zone.injured
          ? `${zone.injured} heridos`
          : zone.evacuation_status === 'none'
            ? 'En seguimiento'
            : 'Evacuación',
        description: `${zone.civilians_present} personas presentes. ${zone.injured} heridos.`,
        locationStatus: 'Centro de zona; no representa la posición exacta de una persona',
      })),
  );
  const units: MapLocation[] = [];
  const communications: Communication[] = [];
  for (const resource of state.resources) {
    const type = resourceTypes[resource.type] ?? {
      icon: 'truck' as const,
      service: 'Otros medios',
    };
    const task = state.tasks.find((item) => item.id === resource.assigned_task_id);
    const action = state.recent_actions
      .filter(
        (item) =>
          item.kind === 'call' &&
          (task
            ? item.task_id === task.id
            : !!resource.contact_id && item.contact_id === resource.contact_id),
      )
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
    const incidentId = task?.incoming_call_id
      ? `call:${task.incoming_call_id}`
      : resource.assigned_zone_id || task?.zone_id || '';
    const point = coordinates(resource.location);
    if (point)
      units.push({
        id: resource.id,
        label: resource.name,
        address: resource.location.label || resource.name,
        coordinates: point,
        kind: 'unit',
        detail: task?.target_location
          ? `Destino aprobado: ${task.target_location.label} · ${task.target_location.lat}, ${task.target_location.lng}`
          : undefined,
        incidentId,
        icon: type.icon,
      });
    const timestamp = resource.reported_at || action?.ts;
    communications.push({
      id: resource.id,
      vehicle: resource.id,
      vehicleLabel: resource.name,
      time:
        timestamp && Number.isFinite(Date.parse(timestamp))
          ? timeFormatter.format(new Date(timestamp))
          : '—',
      status: resourceStatuses[resource.status] ?? 'Desconocido',
      message:
        action?.result.webhook?.summary ||
        action?.summary ||
        task?.title ||
        `${resource.name}: ${resourceStatuses[resource.status] ?? resource.status}`,
      service: type.service,
      agent:
        state.contacts.find(
          (contact) => contact.id === (task?.assignee_contact_id || resource.contact_id),
        )?.name || 'Sin asignar',
      incidentId,
      icon: type.icon,
    });
  }
  return { incidents, units, communications };
}

function validSnapshot(value: unknown): value is WorldSnapshot {
  if (!value || typeof value !== 'object') return false;
  const state = value as WorldSnapshot;
  return (
    Number.isInteger(state.version) &&
    typeof state.generated_at === 'string' &&
    Number.isFinite(Date.parse(state.generated_at)) &&
    typeof state.incident?.id === 'string' &&
    ['zones', 'fronts', 'resources', 'contacts', 'tasks', 'recent_actions'].every((key) =>
      Array.isArray((state as unknown as Record<string, unknown>)[key]),
    ) &&
    (state.incoming_calls === undefined || Array.isArray(state.incoming_calls))
  );
}

@Injectable({ providedIn: 'root' })
export class Operations {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL).replace(/\/$/, '');
  private readonly createStream = inject(STREAM_FACTORY);
  readonly snapshot = signal<WorldSnapshot | null>(null);
  readonly connection = signal<'loading' | 'live' | 'reconnecting' | 'offline'>('loading');
  readonly error = signal('');
  readonly meta = signal<{
    seed_demo: boolean;
    happyrobot_mode: string;
    nominatim_demo_enabled?: boolean;
  } | null>(null);
  private readonly data = computed(() =>
    this.snapshot()
      ? toOperations(this.snapshot()!)
      : { incidents: [], units: [], communications: [] },
  );
  readonly incidents = computed(() => this.data().incidents);
  readonly communications = computed(() => this.data().communications);
  readonly units = computed(() => this.data().units);
  readonly modeLabel = computed(() => {
    const meta = this.meta();
    return !meta
      ? 'Modo sin verificar'
      : `${meta.seed_demo ? 'Escenario demo · ' : ''}${meta.happyrobot_mode === 'simulated' ? 'Salidas simuladas' : 'Salidas reales'}`;
  });
  private started = false;
  private stream: EventSource | null = null;
  private polling?: ReturnType<typeof setInterval>;
  private request?: Subscription;
  private metaRequest?: Subscription;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.metaRequest = this.http
      .get<{ seed_demo: boolean; happyrobot_mode: string; nominatim_demo_enabled?: boolean }>(
        `${this.base}/meta`,
      )
      .subscribe({
        next: (meta) => this.meta.set(meta),
        error: () => this.meta.set(null),
      });
    this.refresh();
    this.stream = this.createStream(`${this.base}/stream`);
    this.stream?.addEventListener('snapshot', (event) => {
      try {
        if (this.accept(JSON.parse((event as MessageEvent<string>).data))) {
          this.connection.set('live');
          clearInterval(this.polling);
          this.polling = undefined;
        }
      } catch {
        this.error.set('Actualización inválida de la API. Se conserva el último estado.');
      }
    });
    for (const type of ['resync', 'reset', 'event', 'agent', 'integration']) {
      this.stream?.addEventListener(type, () => this.refresh());
    }
    this.stream?.addEventListener('error', () => {
      this.connection.set(this.snapshot() ? 'reconnecting' : 'offline');
      this.poll();
    });
    this.poll();
  }

  refresh(): void {
    if (this.request && !this.request.closed) return;
    this.request = this.http.get<WorldSnapshot>(`${this.base}/state`).subscribe({
      next: (state) => {
        if (this.accept(state) && this.connection() !== 'live') this.connection.set('reconnecting');
      },
      error: () => {
        this.error.set('No se puede conectar con la API. Se conserva el último estado recibido.');
        this.connection.set('offline');
        this.poll();
      },
    });
  }

  approve(
    task: OperationalTask,
    approved: boolean,
    key: string,
    confirmLocation: boolean,
  ): Promise<OperationalTask> {
    return this.control(
      `/tasks/${encodeURIComponent(task.id)}/approve`,
      {
        approved,
        confirm_location: confirmLocation,
        expected_updated_at: task.updated_at,
      },
      key,
    );
  }

  geocode(report: IncomingCall, key: string): Promise<unknown> {
    return this.control(
      `/incoming-calls/${encodeURIComponent(report.run_id)}/geocode`,
      {
        expected_timestamp: report.timestamp,
        public_address: true,
      },
      key,
    );
  }

  confirmLocation(
    report: IncomingCall,
    location: GeocodedPlace,
    key: string,
  ): Promise<IncomingCall> {
    return this.control(
      `/incoming-calls/${encodeURIComponent(report.run_id)}/location`,
      {
        expected_timestamp: report.timestamp,
        location,
      },
      key,
    );
  }

  resumeSimulated(key: string): Promise<unknown> {
    return this.control('/resume-simulated', {}, key);
  }

  private control<T>(path: string, body: unknown, key: string): Promise<T> {
    if (!key.trim()) return Promise.reject(new Error('Introduce la clave de operador.'));
    return firstValueFrom(
      this.http.post<T>(`${this.base}/control${path}`, body, {
        headers: { 'X-API-Key': key.trim() },
      }),
    );
  }

  stop(): void {
    this.stream?.close();
    this.stream = null;
    this.request?.unsubscribe();
    this.metaRequest?.unsubscribe();
    clearInterval(this.polling);
    this.polling = undefined;
    this.started = false;
  }

  private poll(): void {
    this.polling ??= setInterval(() => this.refresh(), 5000);
  }

  private accept(state: unknown): boolean {
    if (!validSnapshot(state)) {
      this.error.set('Respuesta inválida de la API. Se conserva el último estado.');
      return false;
    }
    const previous = this.snapshot();
    if (
      previous &&
      (Date.parse(state.generated_at) < Date.parse(previous.generated_at) ||
        (state.incident.id === previous.incident.id &&
          state.incident.started_at === previous.incident.started_at &&
          state.version < previous.version))
    )
      return true;
    try {
      toOperations(state);
      this.snapshot.set(state);
      this.error.set('');
      return true;
    } catch {
      this.error.set('Respuesta inválida de la API. Se conserva el último estado.');
      return false;
    }
  }
}

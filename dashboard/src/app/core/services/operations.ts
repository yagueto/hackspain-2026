import { HttpClient, HttpErrorResponse } from '@angular/common/http';
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
import { HumanQuestion, QuestionAnswer } from '../models/operation-log';
import {
  AgentSettings,
  GeocodedPlace,
  IncomingCall,
  OperationalAction,
  OperationalTask,
  ReportedLocation,
  TASK_LABELS,
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

export interface Meta {
  seed_demo: boolean;
  happyrobot_mode: string;
  storage?: string;
  happyrobot_environment?: string;
  happyrobot_configured?: boolean;
  llm_enabled?: boolean;
  workflows?: Record<string, boolean>;
  geocoding_enabled?: boolean;
  autonomous?: boolean;
  hold_seconds?: number;
  escalate_after_seconds?: number;
}

export function coordinates(
  value: { lat?: number | null; lng?: number | null } | null | undefined,
): Coordinates | undefined {
  return typeof value?.lat === 'number' &&
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
      : ['leve', 'low', 'no_emergencia'].includes(severity)
        ? 'P3'
        : 'P2';
}

export function taskIncidentId(task: OperationalTask | undefined, fallback = ''): string {
  return task?.incoming_call_id ? `call:${task.incoming_call_id}` : task?.zone_id || fallback;
}

export function operatorError(error: unknown): string {
  return error instanceof HttpErrorResponse
    ? error.status === 401
      ? 'Clave de operador incorrecta.'
      : typeof error.error?.detail === 'string'
        ? error.error.detail
        : error.status === 0
          ? 'No se puede conectar con la API.'
          : 'No se pudo completar la operación.'
    : error instanceof Error
      ? error.message
      : 'No se pudo completar la operación.';
}

export function toOperations(
  state: WorldSnapshot,
  allowPublicRoutes = false,
): { incidents: Incident[]; units: MapLocation[]; communications: Communication[] } {
  const incidents: Incident[] = (state.incoming_calls ?? []).map((call) => {
    const resolution = call.resolution;
    const resolved = ['resolved', 'confirmed'].includes(resolution?.status || '')
      ? coordinates(resolution?.selected)
      : undefined;
    const reported = call.location.confirmed ? coordinates(call.location) : undefined;
    const point = resolution?.status === 'confirmed' ? resolved : reported || resolved;
    const locationStatus =
      resolution?.status === 'confirmed'
        ? 'Ubicación revisada por operador · no es GPS automático'
        : reported
          ? 'Coordenadas confirmadas por el informante'
          : resolved
            ? 'Ubicación aproximada de OpenStreetMap · no es GPS del informante'
            : resolution?.status === 'ambiguous'
              ? 'Coincidencias ambiguas o precisión insuficiente'
              : 'Ubicación pendiente de confirmar en el mapa';
    const tasks = state.tasks.filter((task) => task.incoming_call_id === call.run_id);
    const active = tasks.filter(
      (task) => !['done', 'cancelled', 'failed', 'rejected'].includes(task.status),
    );
    const current = active[0] || tasks[0];
    return {
      id: `call:${call.run_id}`,
      title: `Aviso: ${call.emergency_type}`,
      area: address(call.location),
      address: address(call.location),
      priority: priority(call.severity),
      status: active.some((task) => task.status === 'awaiting_approval')
        ? 'CRÍTICO · confirmar'
        : active.some((task) => task.blocked_reason)
          ? 'Bloqueada: ubicación no resoluble'
          : !point
            ? 'Ubicación pendiente'
            : current
              ? TASK_LABELS[current.status] || current.status
              : 'Recibida',
      coordinates: point,
      icon: emergencyIcons[call.emergency_type] ?? 'pin',
      locationStatus,
      radiusMeters: reported ? (call.location.accuracy_m ?? undefined) : undefined,
      description: [
        call.notes,
        call.victims.count != null ? `Personas afectadas: ${call.victims.count}` : '',
        call.active_hazards ? `Riesgos: ${call.active_hazards}` : '',
        call.escalation_required ? 'Requiere revisión de un operador.' : '',
        call.location.accuracy_m ? `Precisión declarada: ${call.location.accuracy_m} m.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  });
  incidents.push(
    ...state.fronts.map((front): Incident => ({
      id: front.id,
      title: front.name,
      area: front.location.label || front.name,
      address: front.location.label || front.name,
      coordinates: coordinates(front.location),
      priority: priority(front.intensity),
      icon: 'fire',
      status: `Contenido ${front.contained_pct}%`,
      description:
        front.speed_kmh == null
          ? ''
          : `Avance: ${front.speed_kmh} km/h. Rumbo: ${front.heading_deg ?? 'sin confirmar'}°.`,
    })),
  );
  incidents.push(
    ...state.zones.map((zone): Incident => ({
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
          : `Evacuación: ${{ advised: 'recomendada', ordered: 'ordenada', in_progress: 'en curso', completed: 'completada' }[zone.evacuation_status] ?? zone.evacuation_status}`,
      description: `${zone.civilians_present} personas presentes. ${zone.injured} heridos. ${zone.notes?.join(' ') || ''}`,
      locationStatus: 'Centro de zona; no representa la posición exacta de una persona',
    })),
  );
  incidents.push(
    ...(state.roads ?? [])
      .filter((road) => !road.open || state.tasks.some((task) => task.zone_id === road.id))
      .map((road): Incident => ({
        id: road.id,
        title: road.name,
        area: road.name,
        address: road.name,
        icon: 'barrier',
        status: road.open ? 'Abierta' : 'Cortada',
        priority: road.open ? 'P3' : 'P1',
        description: road.reason,
        locationStatus: 'Tramo de carretera sin coordenadas confirmadas',
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
    const contact = state.contacts.find(
      (item) =>
        item.id === (task?.assignee_contact_id || resource.contact_id) ||
        item.resource_id === resource.id,
    );
    const action = state.recent_actions
      .filter(
        (item) =>
          item.kind === 'call' &&
          (task ? item.task_id === task.id : !!contact && item.contact_id === contact.id),
      )
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
    const incidentId = taskIncidentId(task, resource.assigned_zone_id || '');
    const point = coordinates(resource.location);
    const target =
      task?.target_location ||
      [...state.zones, ...state.fronts].find((item) => item.id === task?.zone_id)?.location;
    const destination = coordinates(target);
    if (point)
      units.push({
        id: resource.id,
        label: resource.name,
        address: resource.location.label || resource.name,
        coordinates: point,
        kind: 'unit',
        detail: target
          ? `Destino de la misión: ${target.label || incidentId} · ${target.lat}, ${target.lng}`
          : resourceStatuses[resource.status],
        incidentId,
        icon: type.icon,
        service: type.service,
        resourceStatus: resourceStatuses[resource.status] ?? 'Desconocido',
        capacity: resource.capacity,
        contactId: contact?.id,
        etaMinutes: resource.eta_minutes,
        reportedAt: resource.reported_at,
        route:
          allowPublicRoutes &&
          !task?.incoming_call_id &&
          resource.type !== 'helicopter' &&
          resource.status === 'en_route' &&
          destination
            ? { status: 'active', destination, destinationLabel: target?.label || incidentId }
            : undefined,
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
      agent: contact?.name || 'Sin asignar',
      incidentId,
      icon: type.icon,
    });
  }
  return { incidents, units, communications };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
const text = (value: unknown): value is string => typeof value === 'string';
const timestamp = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
const strings = (value: unknown) => Array.isArray(value) && value.every(text);
const optional = (value: unknown, check: (value: unknown) => boolean) =>
  value === undefined || check(value);
const entries = (value: unknown, check: (item: Record<string, unknown>) => boolean) =>
  Array.isArray(value) && value.every((item) => record(item) && text(item['id']) && check(item));
const validAnswer = (value: unknown) =>
  record(value) &&
  strings(value['optionIds']) &&
  text(value['text']) &&
  typeof value['custom'] === 'boolean';

function validSnapshot(value: unknown): value is WorldSnapshot {
  if (!record(value)) return false;
  const state = value;
  const incident = state['incident'];
  if (!record(incident)) return false;
  const point = (value: unknown) =>
    record(value) &&
    typeof value['lat'] === 'number' &&
    typeof value['lng'] === 'number' &&
    !!coordinates({ lat: value['lat'], lng: value['lng'] });
  const namedLocation = (item: Record<string, unknown>) =>
    text(item['name']) && point(item['location']);
  return (
    Number.isInteger(state['version']) &&
    timestamp(state['generated_at']) &&
    text(incident['id']) &&
    text(incident['name']) &&
    timestamp(incident['started_at']) &&
    entries(state['zones'], namedLocation) &&
    entries(state['fronts'], namedLocation) &&
    entries(
      state['resources'],
      (item) => namedLocation(item) && text(item['status']) && text(item['type']),
    ) &&
    entries(state['contacts'], (item) => text(item['name'])) &&
    entries(
      state['tasks'],
      (item) =>
        text(item['title']) &&
        text(item['status']) &&
        strings(item['resource_ids']) &&
        optional(item['updated_at'], timestamp),
    ) &&
    entries(
      state['recent_actions'],
      (item) =>
        timestamp(item['ts']) &&
        text(item['summary']) &&
        text(item['kind']) &&
        text(item['status']) &&
        record(item['result']),
    ) &&
    optional(
      state['incoming_calls'],
      (items) =>
        Array.isArray(items) &&
        items.every(
          (item) =>
            record(item) &&
            text(item['run_id']) &&
            timestamp(item['timestamp']) &&
            text(item['emergency_type']) &&
            text(item['severity']) &&
            record(item['location']) &&
            typeof item['location']['confirmed'] === 'boolean' &&
            record(item['victims']) &&
            optional(
              item['resolution'],
              (resolution) =>
                record(resolution) &&
                text(resolution['status']) &&
                Array.isArray(resolution['candidates']) &&
                resolution['candidates'].every(point) &&
                (resolution['selected'] === null || point(resolution['selected'])),
            ),
        ),
    ) &&
    optional(state['recent_events'], (items) =>
      entries(
        items,
        (item) =>
          timestamp(item['ts']) &&
          text(item['title']) &&
          text(item['source']) &&
          text(item['kind']) &&
          optional(item['payload'], record),
      ),
    ) &&
    optional(state['recent_decisions'], (items) =>
      entries(
        items,
        (item) =>
          timestamp(item['ts']) &&
          text(item['situation_summary']) &&
          strings(item['priorities']) &&
          strings(item['actions_taken']) &&
          optional(item['discarded_events'], strings),
      ),
    ) &&
    optional(state['coordination_questions'], (items) =>
      entries(
        items,
        (item) =>
          text(item['incidentId']) &&
          text(item['prompt']) &&
          Number.isInteger(item['sequence']) &&
          timestamp(item['receivedAt']) &&
          timestamp(item['expiresAt']) &&
          ['pending', 'resolved'].includes(String(item['status'])) &&
          ['critical', 'high', 'moderate'].includes(String(item['urgency'])) &&
          ['text', 'options', 'mixed'].includes(String(item['input'])) &&
          validAnswer(item['defaultAnswer']) &&
          optional(item['options'], (options) =>
            entries(options, (option) => text(option['label'])),
          ),
      ),
    ) &&
    optional(state['roads'], (items) =>
      entries(
        items,
        (item) =>
          text(item['name']) && typeof item['open'] === 'boolean' && strings(item['connects']),
      ),
    ) &&
    optional(
      state['agent'],
      (agent) =>
        record(agent) &&
        ['running', 'paused'].includes(String(agent['mode'])) &&
        optional(agent['approval_required_for'], strings) &&
        optional(agent['approval_required_severities'], strings),
    )
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
  /** Clave del operador: solo en memoria, nunca en almacenamiento del navegador. */
  readonly operatorKey = signal('');
  readonly meta = signal<Meta | null>(null);
  /** Reloj compartido: alimenta las cuentas atrás sin un temporizador por tarjeta. */
  readonly now = signal(Date.now());
  readonly paused = computed(() => this.snapshot()?.agent?.mode === 'paused');
  private readonly data = computed(() =>
    this.snapshot()
      ? toOperations(this.snapshot()!, this.meta()?.seed_demo === true)
      : { incidents: [], units: [], communications: [] },
  );
  readonly incidents = computed(() => this.data().incidents, {
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });
  readonly communications = computed(() => this.data().communications);
  readonly units = computed(() => this.data().units, {
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });
  readonly modeLabel = computed(() => {
    const meta = this.meta();
    return !meta
      ? 'Modo sin verificar'
      : `${meta.seed_demo ? 'Escenario demo · ' : ''}${meta.happyrobot_mode === 'simulated' ? 'Salidas simuladas' : 'Salidas reales'}`;
  });
  private started = false;
  private stream: EventSource | null = null;
  private clock?: ReturnType<typeof setInterval>;
  private polling?: ReturnType<typeof setInterval>;
  private request?: Subscription;
  private metaRequest?: Subscription;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.clock ??= setInterval(() => this.now.set(Date.now()), 1000);
    this.refresh();
    try {
      this.stream = this.createStream(`${this.base}/stream`);
    } catch {
      this.connection.set('reconnecting');
    }
    this.stream?.addEventListener('snapshot', (event) => {
      try {
        if (this.accept(JSON.parse((event as MessageEvent<string>).data))) {
          this.connection.set('live');
          if (this.meta()) {
            clearInterval(this.polling);
            this.polling = undefined;
          }
          return;
        }
      } catch {
        this.error.set('Actualización inválida de la API. Se conserva el último estado.');
      }
      this.connection.set(this.snapshot() ? 'reconnecting' : 'offline');
      this.poll();
    });
    for (const type of [
      'resync',
      'reset',
      'event',
      'agent',
      'integration',
      'task',
      'resource',
      'zone',
      'front',
      'road',
      'decision',
      'action',
    ]) {
      this.stream?.addEventListener(type, () => this.refresh());
    }
    this.stream?.addEventListener('error', () => {
      this.connection.set(this.snapshot() ? 'reconnecting' : 'offline');
      this.poll();
    });
    this.poll();
  }

  refresh(): void {
    if (!this.meta() && (!this.metaRequest || this.metaRequest.closed))
      this.metaRequest = this.http.get<Meta>(`${this.base}/meta`).subscribe({
        next: (meta) => {
          const valid =
            !!meta &&
            typeof meta.seed_demo === 'boolean' &&
            ['simulated', 'live'].includes(meta.happyrobot_mode);
          this.meta.set(valid ? meta : null);
          if (valid && this.connection() === 'live') {
            clearInterval(this.polling);
            this.polling = undefined;
          }
        },
        error: () => this.meta.set(null),
      });
    if (this.request && !this.request.closed) return;
    this.request = this.http.get<WorldSnapshot>(`${this.base}/state`).subscribe({
      next: (state) => {
        if (!this.accept(state)) {
          this.connection.set('reconnecting');
          this.poll();
        } else if (this.connection() !== 'live') this.connection.set('reconnecting');
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
    confirmLocation: boolean,
  ): Promise<OperationalTask> {
    return this.control(`/tasks/${encodeURIComponent(task.id)}/approve`, {
      approved,
      confirm_location: confirmLocation,
      expected_updated_at: task.updated_at,
    });
  }

  /** Override de una decisión automática: anula la misión y libera la unidad. */
  cancelTask(task: OperationalTask, note = 'Anulada por el operador'): Promise<OperationalTask> {
    return this.setTaskStatus(task, 'cancelled', note);
  }

  setTaskStatus(
    task: OperationalTask,
    status: 'done' | 'cancelled',
    outcome = '',
  ): Promise<OperationalTask> {
    return this.control(`/tasks/${encodeURIComponent(task.id)}/status`, {
      status,
      outcome,
      expected_updated_at: task.updated_at,
    });
  }

  prioritizeTask(
    task: OperationalTask,
    priority: number,
    reason: string,
  ): Promise<OperationalTask> {
    return this.control(`/tasks/${encodeURIComponent(task.id)}/priority`, {
      priority,
      reason,
      expected_updated_at: task.updated_at,
    });
  }

  createTask(body: {
    kind: string;
    title: string;
    description?: string;
    priority?: number;
    zone_id?: string | null;
    contact_id?: string | null;
  }): Promise<OperationalTask> {
    return this.control('/tasks', body);
  }

  /** Parada de emergencia: el agente deja de enviar órdenes nuevas. */
  pause(): Promise<AgentSettings> {
    return this.control('/pause', {});
  }
  resume(): Promise<AgentSettings> {
    return this.control('/resume', {});
  }
  resumeSimulated(): Promise<AgentSettings> {
    return this.control('/resume-simulated', {});
  }
  tick(): Promise<unknown> {
    return this.control('/tick', {});
  }
  dispatchPending(): Promise<unknown> {
    return this.control('/dispatch', {});
  }
  configureAgent(body: Partial<Omit<AgentSettings, 'mode'>>): Promise<AgentSettings> {
    return this.control('/agent', body, 'patch');
  }

  geocode(report: IncomingCall): Promise<unknown> {
    return this.control(`/incoming-calls/${encodeURIComponent(report.run_id)}/geocode`, {
      expected_timestamp: report.timestamp,
    });
  }

  confirmLocation(report: IncomingCall, location: GeocodedPlace): Promise<IncomingCall> {
    return this.control(`/incoming-calls/${encodeURIComponent(report.run_id)}/location`, {
      expected_timestamp: report.timestamp,
      location,
    });
  }

  call(contactId: string, instructions: string): Promise<OperationalAction> {
    return this.control('/call', { contact_id: contactId, instructions });
  }

  telegram(contactId: string, message: string): Promise<OperationalAction> {
    return this.control('/telegram', { contact_id: contactId, message });
  }

  reconcile(action: OperationalAction): Promise<OperationalAction> {
    return this.control(`/actions/${encodeURIComponent(action.id)}/reconcile`, {});
  }

  generateDemoQuestion(): Promise<HumanQuestion> {
    return this.control('/questions/demo', {});
  }
  answerQuestion(id: string, answer: QuestionAnswer): Promise<HumanQuestion> {
    return this.control(`/questions/${encodeURIComponent(id)}/answer`, answer);
  }
  addNote(title: string, incidentId: string | null): Promise<unknown> {
    return this.control('/note', { title, incident_id: incidentId });
  }

  private control<T>(path: string, body: unknown, method: 'post' | 'patch' = 'post'): Promise<T> {
    const key = this.operatorKey().trim();
    if (!key) return Promise.reject(new Error('Introduce la clave de operador.'));
    return firstValueFrom(
      this.http.request<T>(method, `${this.base}/control${path}`, {
        body,
        headers: { 'X-API-Key': key },
      }),
    );
  }

  stop(): void {
    this.stream?.close();
    this.stream = null;
    this.request?.unsubscribe();
    this.metaRequest?.unsubscribe();
    clearInterval(this.polling);
    clearInterval(this.clock);
    this.polling = this.clock = undefined;
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
      this.snapshot.set({ ...state, incoming_calls: state.incoming_calls ?? [] });
      this.error.set('');
      return true;
    } catch {
      this.error.set('Respuesta inválida de la API. Se conserva el último estado.');
      return false;
    }
  }
}

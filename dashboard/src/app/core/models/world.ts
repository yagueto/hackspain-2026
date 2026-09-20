import { Coordinates } from './operations';
import { HumanQuestion } from './operation-log';

export interface ReportedLocation {
  raw_text?: string | null;
  street?: string | null;
  number?: string | null;
  floor_door?: string | null;
  city?: string | null;
  road?: string | null;
  kilometer?: string | null;
  direction?: string | null;
  lat?: number | null;
  lng?: number | null;
  confirmed: boolean;
  accuracy_m?: number | null;
  public_search_allowed?: boolean;
}

export interface GeocodedPlace extends Coordinates {
  label: string;
  kind: string;
}

export interface LocationResolution {
  status: 'not_requested' | 'resolved' | 'ambiguous' | 'not_found' | 'unavailable' | 'confirmed';
  candidates: GeocodedPlace[];
  selected: GeocodedPlace | null;
  provider: 'nominatim' | 'operator';
  error: string;
}

export interface OperationalTask {
  id: string;
  title: string;
  kind?: string;
  description?: string;
  priority?: number;
  zone_id: string | null;
  resource_ids: string[];
  action_ids?: string[];
  status: string;
  created_at?: string;
  updated_at?: string;
  resource_types?: string[];
  assignee_contact_id?: string | null;
  incoming_call_id?: string | null;
  incoming_call_timestamp?: string | null;
  target_location?: (Coordinates & { label: string }) | null;
  outcome?: string;
  /** La decidió el agente; el operador puede anularla mientras dure `hold_until`. */
  autonomous?: boolean;
  hold_until?: string | null;
  blocked_reason?: string;
  priority_reason?: string;
  requires_approval?: boolean;
  approved_at?: string | null;
  escalated_at?: string | null;
}

export interface IncomingCall {
  run_id: string;
  timestamp: string;
  emergency_type: string;
  severity: 'vital' | 'grave' | 'moderada' | 'leve' | 'no_emergencia';
  escalation_required: boolean;
  location: ReportedLocation;
  victims: {
    count?: number | null;
    conscious?: boolean | null;
    breathing?: boolean | null;
    trapped?: boolean | null;
    minors_involved?: boolean | null;
  };
  caller?: { name?: string | null; phone?: string | null; is_victim?: boolean | null };
  active_hazards?: string | null;
  notes?: string | null;
  resolution?: LocationResolution;
}

export interface OperationalAction {
  id: string;
  ts: string;
  kind: string;
  status: string;
  task_id: string | null;
  contact_id: string | null;
  summary: string;
  workflow?: string | null;
  happyrobot_run_id?: string | null;
  attempts?: number;
  error?: string;
  hold_until?: string | null;
  next_attempt_at?: string | null;
  expires_at?: string | null;
  request?: { task_id?: string | null; message?: string; instructions?: string };
  result: {
    simulated?: boolean;
    webhook?: {
      summary?: string;
      transcript?: string;
      outcome?: string;
      eta_minutes?: number | null;
    };
    run?: { status?: string };
  };
}

export interface OperationalEvent {
  id: string;
  ts: string;
  source: string;
  kind: string;
  title: string;
  severity?: string;
  zone_id?: string | null;
  relevant?: boolean | null;
  relevance_reason?: string;
  payload?: Record<string, unknown>;
}

export interface AgentDecision {
  id: string;
  ts: string;
  trigger: string;
  situation_summary: string;
  priorities: string[];
  actions_taken: string[];
  discarded_events?: string[];
  replan: boolean;
  replan_reason?: string;
  model: string;
}

export interface AgentSettings {
  mode: 'running' | 'paused';
  autonomous?: boolean;
  approval_required_for?: string[];
  approval_required_severities?: string[];
  tick_seconds?: number;
  hold_seconds?: number;
  escalate_after_seconds?: number;
}

export interface WorldSnapshot {
  version: number;
  generated_at: string;
  incident: { id: string; name: string; started_at: string; summary?: string; status?: string };
  zones: {
    id: string;
    name: string;
    location: Coordinates & { label?: string };
    threat: string;
    population?: number;
    civilians_present: number;
    injured: number;
    evacuation_status: string;
    shelter_capacity?: number;
    notes?: string[];
  }[];
  fronts: {
    id: string;
    name: string;
    location: Coordinates & { label?: string };
    intensity: string;
    contained_pct: number;
    heading_deg?: number;
    speed_kmh?: number;
    threatens_zone_ids?: string[];
    eta_minutes_to_zone?: Record<string, number>;
  }[];
  resources: {
    id: string;
    name: string;
    type: string;
    status: string;
    location: Coordinates & { label?: string };
    assigned_task_id: string | null;
    assigned_zone_id: string | null;
    contact_id: string | null;
    reported_at: string | null;
    capacity?: number;
    eta_minutes?: number | null;
    notes?: string[];
  }[];
  contacts: {
    id: string;
    name: string;
    role?: string;
    phone?: string;
    resource_id?: string | null;
    zone_id?: string | null;
    reliability?: number;
    last_contacted_at?: string | null;
    language?: string;
  }[];
  tasks: OperationalTask[];
  agent?: AgentSettings;
  recent_actions: OperationalAction[];
  recent_events?: OperationalEvent[];
  recent_decisions?: AgentDecision[];
  incoming_calls: IncomingCall[];
  coordination_questions?: HumanQuestion[];
  integrations?: Record<string, boolean>;
  last_synced_at?: string | null;
  weather?: {
    wind_from_deg: number;
    wind_kmh: number;
    temperature_c: number;
    humidity_pct: number;
    forecast?: string;
  };
  roads?: { id: string; name: string; connects: string[]; open: boolean; reason: string }[];
}

export const TASK_LABELS: Record<string, string> = {
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

export const ACTION_LABELS: Record<string, string> = {
  pending: 'Pendiente de envío',
  sending: 'Enviando',
  dispatched: 'Enviada · resultado pendiente',
  completed: 'Resultado confirmado',
  failed: 'Fallida',
  skipped: 'No enviada',
  unknown: 'Resultado desconocido · revisar',
};

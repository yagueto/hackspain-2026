import { Coordinates } from './operations';

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
  zone_id: string | null;
  resource_ids: string[];
  status: string;
  updated_at?: string;
  resource_types?: string[];
  assignee_contact_id?: string | null;
  incoming_call_id?: string | null;
  target_location?: (Coordinates & { label: string }) | null;
  outcome?: string;
}

export interface IncomingCall {
  run_id: string;
  timestamp: string;
  emergency_type: string;
  severity: 'vital' | 'grave' | 'moderada' | 'leve' | 'no_emergencia';
  escalation_required: boolean;
  location: ReportedLocation;
  victims: { count?: number | null };
  notes?: string | null;
  resolution?: LocationResolution;
}

export interface WorldSnapshot {
  version: number;
  generated_at: string;
  incident: { id: string; name: string; started_at: string };
  zones: {
    id: string;
    name: string;
    location: Coordinates & { label?: string };
    threat: string;
    civilians_present: number;
    injured: number;
    evacuation_status: string;
  }[];
  fronts: {
    id: string;
    name: string;
    location: Coordinates & { label?: string };
    intensity: string;
    contained_pct: number;
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
  }[];
  contacts: { id: string; name: string }[];
  tasks: OperationalTask[];
  agent?: { mode: 'running' | 'paused' };
  recent_actions: {
    id: string;
    ts: string;
    kind: string;
    status: string;
    task_id: string | null;
    contact_id: string | null;
    summary: string;
    result: { webhook?: { summary?: string } };
  }[];
  incoming_calls: IncomingCall[];
}

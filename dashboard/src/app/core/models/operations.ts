export type IconName =
  | 'fire'
  | 'walk'
  | 'heart'
  | 'barrier'
  | 'fire-truck'
  | 'bus'
  | 'helicopter'
  | 'medical'
  | 'truck'
  | 'tools'
  | 'shield'
  | 'hospital'
  | 'shelter'
  | 'filter'
  | 'locate'
  | 'layers'
  | 'chevron'
  | 'back'
  | 'close'
  | 'pin'
  | 'radio'
  | 'log'
  | 'disabled'
  | 'municipal'
  | 'civil-protection'
  | 'infrastructure'
  | 'plus'
  | 'minus'
  | 'sun'
  | 'moon'
  | 'search';

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface ResourceRoute {
  status: 'active' | 'completed';
  destination: Coordinates;
  destinationLabel?: string;
  via?: readonly Coordinates[];
  navigation?: RouteNavigation;
}

export type RouteNavigation =
  { status: 'loading' | 'unavailable' | 'error' } | { status: 'ready'; route: CalculatedRoute };

export interface CalculatedRoute {
  path: readonly Coordinates[];
  durationSeconds: number;
  distanceMeters: number;
}

export interface MapLocation {
  id: string;
  label: string;
  address: string;
  coordinates: Coordinates;
  icon: IconName;
  kind: 'incident' | 'unit' | 'place';
  incidentId?: string;
  radiusMeters?: number;
  route?: ResourceRoute;
}

export interface Incident {
  id: string;
  title: string;
  area: string;
  address: string;
  priority?: 'P0' | 'P1' | 'P2' | 'P3' | null;
  status: string;
  icon: IconName;
  coordinates: Coordinates;
  radiusMeters?: number;
}

export const PRIORITY_LEVEL: Record<NonNullable<Incident['priority']>, number> = {
  P0: 1,
  P1: 2,
  P2: 3,
  P3: 4,
};

export type CommunicationStatus =
  'Recibida' | 'Aceptada' | 'En ejecución' | 'Confirmada' | 'Asignado';

export interface Communication {
  id: string;
  time: string;
  status: CommunicationStatus;
  message: string;
  service: string;
  vehicle: string;
  agent: string;
  incidentId: string;
  icon: IconName;
}

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
  | 'user'
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
  detail?: string;
  incidentId?: string;
  radiusMeters?: number;
  route?: ResourceRoute;
  resourceStatus?: CommunicationStatus;
  service?: string;
  capacity?: number;
  contactId?: string | null;
  etaMinutes?: number | null;
  reportedAt?: string | null;
  /** Salida y duración del trayecto según el backend: la posición mostrada es estimada. */
  travelStartedAt?: string | null;
  travelMinutes?: number | null;
  positionEstimated?: boolean;
  /** Extremos del trayecto, para interpolar cuando no hay ruta por carretera que seguir. */
  travelFrom?: Coordinates;
  travelTo?: Coordinates;
}

export interface Incident {
  id: string;
  title: string;
  area: string;
  address: string;
  priority?: 'P0' | 'P1' | 'P2' | 'P3' | null;
  status: string;
  icon: IconName;
  coordinates?: Coordinates;
  description?: string;
  locationStatus?: string;
  radiusMeters?: number;
  /** El agente no puede seguir solo: `blocked` necesita ubicación, `critical` confirmación. */
  alert?: 'blocked' | 'critical';
}

export const PRIORITY_LEVEL: Record<NonNullable<Incident['priority']>, number> = {
  P0: 1,
  P1: 2,
  P2: 3,
  P3: 4,
};

export type CommunicationStatus =
  | 'Recibida'
  | 'Aceptada'
  | 'En ejecución'
  | 'Confirmada'
  | 'Asignado'
  | 'Disponible'
  | 'Reservado'
  | 'En ruta'
  | 'Enviado'
  | 'En intervención'
  | 'Regresando'
  | 'Fuera de servicio'
  | 'Desconocido';

export interface Communication {
  id: string;
  time: string;
  status: CommunicationStatus;
  message: string;
  service: string;
  vehicle: string;
  vehicleLabel?: string;
  agent: string;
  incidentId: string;
  icon: IconName;
}

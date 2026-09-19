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
  | 'close'
  | 'pin'
  | 'radio';

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface MapLocation {
  id: string;
  label: string;
  address: string;
  coordinates: Coordinates;
  icon: IconName;
  kind: 'incident' | 'unit' | 'place';
  incidentId?: string;
}

export interface Incident {
  id: string;
  title: string;
  area: string;
  address: string;
  priority: 'P0' | 'P1' | 'P2';
  status: string;
  icon: IconName;
  coordinates: Coordinates;
}

export type CommunicationStatus = 'Recibida' | 'Aceptada' | 'En ejecución' | 'Confirmada';

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

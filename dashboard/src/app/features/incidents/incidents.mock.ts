import { OperationLogEvent } from '../../core/models/operation-log';

export interface IncidentDetails {
  category: string;
  openedAt: string;
  affected: number | null;
  assistanceNeeded?: number | null;
  affectedNote: string;
}

export type IncidentEvent = OperationLogEvent;

export const MOCK_INCIDENT_DETAILS: Record<string, IncidentDetails> = {
  'INC-001': {
    category: 'Forestal',
    openedAt: '2026-09-19T14:20:00+02:00',
    affected: 5,
    assistanceNeeded: 1,
    affectedNote: 'Senderistas en la zona · 1 con movilidad reducida',
  },
  'INC-002': {
    category: 'Evacuación',
    openedAt: '2026-09-19T14:24:00+02:00',
    affected: 32,
    affectedNote: 'Vecinos pendientes de traslado al punto de acogida',
  },
  'INC-003': {
    category: 'Sanitaria',
    openedAt: '2026-09-19T14:26:00+02:00',
    affected: 8,
    assistanceNeeded: 3,
    affectedNote: 'Residentes · 3 requieren asistencia para el traslado',
  },
  'INC-004': {
    category: 'Tráfico',
    openedAt: '2026-09-19T14:28:00+02:00',
    affected: null,
    affectedNote: 'Número de personas pendiente de confirmar',
  },
  'INC-005': {
    category: 'Tráfico',
    openedAt: '2026-09-19T14:02:00+02:00',
    affected: 4,
    affectedNote: 'Dos vehículos implicados · asistencia sanitaria desplegada',
  },
  'INC-006': {
    category: 'Urbana',
    openedAt: '2026-09-19T14:04:00+02:00',
    affected: 6,
    affectedNote: 'Personal evacuado del almacén y del edificio contiguo',
  },
  'INC-007': {
    category: 'Sanitaria',
    openedAt: '2026-09-19T14:06:00+02:00',
    affected: 1,
    assistanceNeeded: 1,
    affectedNote: 'Conductor con necesidad de soporte vital',
  },
  'INC-008': {
    category: 'Meteorológica',
    openedAt: '2026-09-19T14:08:00+02:00',
    affected: null,
    affectedNote: 'Carril bloqueado · sin heridos confirmados',
  },
  'INC-009': {
    category: 'Evacuación',
    openedAt: '2026-09-19T14:10:00+02:00',
    affected: 18,
    affectedNote: 'Grupo de senderistas pendiente de recogida',
  },
  'INC-010': {
    category: 'Rescate',
    openedAt: '2026-09-19T14:12:00+02:00',
    affected: 1,
    affectedNote: 'Búsqueda coordinada con equipos terrestres y apoyo aéreo',
  },
};

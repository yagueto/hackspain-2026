import { OperationLogEvent } from '../../core/models/operation-log';

export interface IncidentDetails {
  category: string;
  openedAt: string;
  affected: number | null;
  affectedNote: string;
}

export type IncidentEvent = OperationLogEvent;

const openedAt = new Date(Date.now() - 20 * 60000).toISOString();

export const MOCK_INCIDENT_DETAILS: Record<string, IncidentDetails> = {
  'INC-004': {
    category: 'Tráfico',
    openedAt,
    affected: 2,
    affectedNote:
      'Dos ocupantes atrapados. B-07 realiza la excarcelación y no puede abandonar el rescate.',
  },
  'INC-008': {
    category: 'Rescate',
    openedAt,
    affected: 3,
    affectedNote: 'Tres vecinos atrapados. B-09 asegura la estructura y mantiene el rescate.',
  },
};

export const DEMO_INCIDENT_DETAILS: Record<string, Omit<IncidentDetails, 'openedAt'>> = {
  'INC-001': {
    category: 'Industrial',
    affected: 6,
    affectedNote:
      'Almacén evacuado. Dos trabajadores con inhalación leve de humo; se movilizan B-03 y A-01.',
  },
  'INC-002': {
    category: 'Suministro eléctrico',
    affected: 45,
    affectedNote:
      'Fallo del transformador principal. Producción detenida; T-01 espera la decisión del coordinador.',
  },
  'INC-003': {
    category: 'Forestal',
    affected: 12,
    affectedNote:
      'Fuego próximo a cuatro viviendas. Las tres unidades de bomberos están ocupadas; se prioriza el riesgo para las personas.',
  },
};

import { OperationLogEvent } from '../../core/models/operation-log';

export interface IncidentDetails {
  category: string;
  openedAt: string;
  affected: number | null;
  assistanceNeeded?: number;
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
    affectedNote:
      'Tres vecinos atrapados. B-09 mantiene el rescate y B-11 asegura la estructura; ninguno puede abandonar la intervención.',
  },
};

export const DEMO_INCIDENT_DETAILS: Record<string, Omit<IncidentDetails, 'openedAt'>> = {
  'INC-001': {
    category: 'Riesgo químico · Fuga de gas',
    affected: null,
    affectedNote:
      'Varios afectados, todos fuera de la planta. No queda nadie dentro. Se necesita asistencia médica y un equipo de bomberos para controlar la fuga de gas.',
  },
  'INC-002': {
    category: 'Industrial · Continuidad de producción',
    affected: null,
    affectedNote:
      'Una explosión ha detenido la producción. El informante permanece en una zona segura. T-01 espera la decisión empresarial: activar la línea alternativa o reparar la principal.',
  },
  'INC-003': {
    category: 'Industrial · Rescate de personas atrapadas',
    affected: null,
    affectedNote:
      'Segunda explosión en el edificio B, con personas atrapadas. Se solicita otro equipo de emergencia.',
  },
};

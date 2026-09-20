import { IncomingQuestion, OperationLogEvent } from '../../../core/models/operation-log';
import { Incident } from '../../../core/models/operations';

export function createDemoQuestion(incident: Incident): IncomingQuestion {
  return {
    id: 'demo:production-decision',
    incidentId: incident.id,
    urgency: 'high',
    input: 'options',
    prompt: 'La explosión ha detenido la producción. ¿Cómo procedemos?',
    options: [
      {
        id: 'alternative',
        label: 'Activar la línea de producción alternativa',
        action: {
          type: 'production-plan',
          strategy: 'alternative',
          expectedStatus: incident.status,
        },
      },
      {
        id: 'repair',
        label: 'Reparar la línea principal',
        action: { type: 'production-plan', strategy: 'repair', expectedStatus: incident.status },
      },
    ],
    defaultAnswer: { custom: false, optionIds: ['alternative'], text: '' },
  };
}

export function createDemoCallEvents(incidentId: string, occurredAt: string): OperationLogEvent[] {
  const conversations: Record<string, readonly [string, string][]> = {
    'INC-001': [
      ['Informante', 'Hay una fuga de gas en la planta.'],
      ['Agente', '¿Hay alguien herido o atrapado?'],
      ['Informante', 'Hay varios afectados, pero están fuera. No queda nadie dentro.'],
      [
        'Agente',
        'Entendido. Envío asistencia médica y activo el equipo de emergencia para controlar la fuga.',
      ],
    ],
    'INC-002': [
      ['Informante', 'Ha habido una explosión. La producción se ha detenido.'],
      ['Agente', 'Entendido. Queda registrado. Mantente en una zona segura.'],
    ],
    'INC-003': [
      ['Informante', 'Ha habido otra explosión en otro edificio. Hay personas atrapadas.'],
      ['Agente', 'Entendido. Estoy buscando otro equipo de emergencia.'],
    ],
  };
  return (conversations[incidentId] ?? []).map(([source, description], index) => ({
    id: `demo:${incidentId}:call:${index}`,
    incidentId,
    occurredAt,
    kind: 'call',
    title: `Llamada · ${source}`,
    description,
    source,
  }));
}

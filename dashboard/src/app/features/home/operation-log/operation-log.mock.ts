import { IncomingQuestion } from '../../../core/models/operation-log';
import { Incident } from '../../../core/models/operations';

export function createDemoQuestion(incident: Incident): IncomingQuestion {
  return {
    id: 'demo:power-decision',
    incidentId: incident.id,
    urgency: 'high',
    input: 'options',
    prompt:
      'Intervención humana: el transformador principal ha fallado y la planta está sin luz. ¿Cómo recuperamos la producción?',
    options: [
      {
        id: 'backup',
        label: 'Opción A: activar transformador de respaldo → Producción parcial inmediata',
        action: { type: 'power-plan', strategy: 'backup', expectedStatus: incident.status },
      },
      {
        id: 'repair',
        label:
          'Opción B: reparar transformador principal → Más tiempo parado, pero mayor capacidad',
        action: { type: 'power-plan', strategy: 'repair', expectedStatus: incident.status },
      },
    ],
    defaultAnswer: { custom: false, optionIds: ['backup'], text: '' },
  };
}

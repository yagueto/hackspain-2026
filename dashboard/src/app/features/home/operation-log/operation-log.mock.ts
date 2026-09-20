import { IncomingQuestion } from '../../../core/models/operation-log';
import { Incident, MapLocation } from '../../../core/models/operations';

export function createDemoQuestion(
  sequence: number,
  incidents: readonly Incident[],
  units: readonly MapLocation[],
): IncomingQuestion | null {
  if (!incidents.length) return null;
  const incident = incidents[(sequence - 1) % incidents.length];
  const kind = (sequence - 1) % 3;
  const base = {
    id: `question-${crypto.randomUUID()}`,
    incidentId: incident.id,
    context: `${incident.title} en ${incident.area}. Estado actual: ${incident.status}.`,
    urgency: (['moderate', 'critical', 'high'] as const)[kind],
  };
  const coordination = {
    type: 'set-status' as const,
    status: 'En coordinación',
    expectedStatus: incident.status,
  };
  if (kind === 1) {
    return {
      ...base,
      input: 'text',
      prompt: `¿Qué instrucciones debe transmitir el coordinador a los equipos de ${incident.id}?`,
      textAction: coordination,
      defaultAnswer: {
        custom: true,
        optionIds: [],
        text: 'Mantener los recursos asignados y solicitar validación del coordinador.',
      },
    };
  }
  if (kind === 2) {
    return {
      ...base,
      input: 'mixed',
      prompt: `Se necesita confirmar cómo continuar la gestión de ${incident.id}.`,
      options: [
        { id: 'coordinate', label: 'Pasar a coordinación', action: coordination },
        { id: 'maintain', label: 'Mantener la actuación actual', action: { type: 'none' } },
      ],
      textAction: { type: 'note' },
      defaultAnswer: { custom: false, optionIds: ['coordinate'], text: '' },
    };
  }
  const services = new Set(
    units.filter((unit) => unit.incidentId === incident.id).map((unit) => unit.icon),
  );
  const available = units.find(
    (unit) =>
      unit.kind === 'unit' &&
      unit.incidentId !== incident.id &&
      unit.route?.status !== 'active' &&
      services.has(unit.icon),
  );
  return {
    ...base,
    input: 'options',
    prompt: available
      ? `¿Reasignar ${available.id} desde ${available.incidentId ?? 'reserva'} como refuerzo para ${incident.id}?`
      : `¿Solicitar coordinación adicional para ${incident.id}?`,
    options: [
      {
        id: 'confirm',
        label: available ? `Asignar ${available.id}` : 'Solicitar coordinación',
        action: available
          ? {
              type: 'assign-resource',
              resourceId: available.id,
              expectedIncidentId: available.incidentId ?? null,
            }
          : coordination,
      },
      { id: 'maintain', label: 'Mantener las asignaciones actuales', action: { type: 'none' } },
    ],
    defaultAnswer: { custom: false, optionIds: ['maintain'], text: '' },
  };
}

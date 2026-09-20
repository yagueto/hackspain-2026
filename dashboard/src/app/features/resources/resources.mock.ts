import { IconName } from '../../core/models/operations';

export interface ResourceProfile {
  service: string;
  type: string;
  crew: number;
  base: string;
  capabilities: readonly string[];
}

export interface ResourceIntervention {
  resourceIds: readonly string[];
  incidentId: string;
  completedAt: string;
  summary: string;
}

export const MOCK_RESOURCE_PROFILES: Partial<Record<IconName, ResourceProfile>> = {
  'fire-truck': {
    service: 'Bomberos',
    type: 'Autobomba y equipo de intervención',
    crew: 5,
    base: 'Base de bomberos · Zona este de Tres Cantos',
    capabilities: ['Control de fugas de gas', 'Rescate', 'Extinción', 'Apertura de accesos'],
  },
  helicopter: {
    service: 'Apoyo aéreo',
    type: 'Helicóptero de coordinación',
    crew: 3,
    base: 'Punto de apoyo aéreo · Periferia norte de Tres Cantos',
    capabilities: ['Reconocimiento', 'Búsqueda', 'Coordinación aérea'],
  },
  bus: {
    service: 'Transporte',
    type: 'Autobús de evacuación',
    crew: 2,
    base: 'Transporte de reserva · Estación de Tres Cantos',
    capabilities: ['40 plazas', 'Evacuación', 'Traslado a albergue'],
  },
  medical: {
    service: 'Sanitarios',
    type: 'Ambulancia de soporte vital',
    crew: 3,
    base: 'Puesto sanitario · Centro de Tres Cantos',
    capabilities: ['Triaje', 'Soporte vital', 'Traslado sanitario'],
  },
  shield: {
    service: 'Policía',
    type: 'Patrulla de coordinación',
    crew: 2,
    base: 'Policía local · Tres Cantos',
    capabilities: ['Evacuación', 'Seguridad', 'Control de tráfico'],
  },
  tools: {
    service: 'Mantenimiento industrial',
    type: 'Equipo técnico de producción',
    crew: 3,
    base: 'Mantenimiento · Edificio A, planta industrial de demostración',
    capabilities: [
      'Línea de producción alternativa',
      'Reparación de la línea principal',
      'Continuidad de producción',
    ],
  },
  truck: {
    service: 'Logística',
    type: 'Vehículo de apoyo logístico',
    crew: 2,
    base: 'Base logística · Zona industrial de Tres Cantos',
    capabilities: ['Suministros', 'Material de intervención', 'Apoyo al mando'],
  },
};

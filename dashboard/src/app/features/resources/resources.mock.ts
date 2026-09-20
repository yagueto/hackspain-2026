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
    base: 'Parque de bomberos · Sierra Norte',
    capabilities: ['Extinción', 'Rescate', 'Apertura de accesos'],
  },
  helicopter: {
    service: 'Apoyo aéreo',
    type: 'Helicóptero de coordinación',
    crew: 3,
    base: 'Helipuerto · Sierra Norte',
    capabilities: ['Reconocimiento', 'Búsqueda', 'Coordinación aérea'],
  },
  bus: {
    service: 'Transporte',
    type: 'Autobús de evacuación',
    crew: 2,
    base: 'Centro de transporte · Manzanares',
    capabilities: ['40 plazas', 'Evacuación', 'Traslado a albergue'],
  },
  medical: {
    service: 'Sanitarios',
    type: 'Ambulancia de soporte vital',
    crew: 3,
    base: 'Puesto sanitario · Manzanares',
    capabilities: ['Triaje', 'Soporte vital', 'Traslado sanitario'],
  },
  shield: {
    service: 'Policía',
    type: 'Patrulla de coordinación',
    crew: 2,
    base: 'Policía local · Manzanares',
    capabilities: ['Evacuación', 'Seguridad', 'Control de tráfico'],
  },
  tools: {
    service: 'Guardia Civil',
    type: 'Patrulla de seguridad vial',
    crew: 2,
    base: 'Puesto de la Guardia Civil · Sierra',
    capabilities: ['Cortes de vía', 'Control de accesos', 'Escolta'],
  },
  truck: {
    service: 'Logística',
    type: 'Vehículo de apoyo logístico',
    crew: 2,
    base: 'Centro logístico · Manzanares',
    capabilities: ['Suministros', 'Material de intervención', 'Apoyo al mando'],
  },
};

export const MOCK_RESOURCE_HISTORY: readonly ResourceIntervention[] = [
  {
    resourceIds: ['B-03', 'B-07'],
    incidentId: 'INC-006',
    completedAt: '2026-09-19T14:18:00+02:00',
    summary: 'Primer ataque al fuego y relevo al equipo de extinción.',
  },
  {
    resourceIds: ['B-03', 'B-09', 'B-12'],
    incidentId: 'INC-008',
    completedAt: '2026-09-19T14:12:00+02:00',
    summary: 'Retirada inicial de ramas y apertura de un paso seguro.',
  },
  {
    resourceIds: ['B-14'],
    incidentId: 'INC-006',
    completedAt: '2026-09-19T14:11:00+02:00',
    summary: 'Revisión del perímetro y protección del edificio contiguo.',
  },
  {
    resourceIds: ['H-01', 'H-02'],
    incidentId: 'INC-006',
    completedAt: '2026-09-19T14:10:00+02:00',
    summary: 'Reconocimiento aéreo y localización de accesos.',
  },
  {
    resourceIds: ['BUS-04', 'BUS-05'],
    incidentId: 'INC-009',
    completedAt: '2026-09-19T14:16:00+02:00',
    summary: 'Primer traslado de senderistas al punto de acogida.',
  },
  {
    resourceIds: ['BUS-06', 'BUS-07'],
    incidentId: 'INC-005',
    completedAt: '2026-09-19T14:12:00+02:00',
    summary: 'Traslado de ocupantes ilesos a una zona segura.',
  },
  {
    resourceIds: ['A-01', 'A-03', 'A-04'],
    incidentId: 'INC-005',
    completedAt: '2026-09-19T14:10:00+02:00',
    summary: 'Valoración inicial y estabilización de los ocupantes.',
  },
  {
    resourceIds: ['A-02'],
    incidentId: 'INC-006',
    completedAt: '2026-09-19T14:10:00+02:00',
    summary: 'Evaluación por inhalación de humo del personal evacuado.',
  },
  {
    resourceIds: ['P-01', 'P-03'],
    incidentId: 'INC-005',
    completedAt: '2026-09-19T14:10:00+02:00',
    summary: 'Señalización y desvío de tráfico para el acceso sanitario.',
  },
  {
    resourceIds: ['P-02'],
    incidentId: 'INC-006',
    completedAt: '2026-09-19T14:11:00+02:00',
    summary: 'Desalojo preventivo y aseguramiento del perímetro.',
  },
  {
    resourceIds: ['GC-01', 'GC-02', 'GC-03', 'GC-04'],
    incidentId: 'INC-005',
    completedAt: '2026-09-19T14:10:00+02:00',
    summary: 'Control de accesos y escolta de los servicios de emergencia.',
  },
  {
    resourceIds: ['L-01', 'L-03'],
    incidentId: 'INC-005',
    completedAt: '2026-09-19T14:09:00+02:00',
    summary: 'Entrega de material de señalización y apoyo sanitario.',
  },
  {
    resourceIds: ['L-02'],
    incidentId: 'INC-008',
    completedAt: '2026-09-19T14:12:00+02:00',
    summary: 'Entrega de herramientas y retirada de material.',
  },
];

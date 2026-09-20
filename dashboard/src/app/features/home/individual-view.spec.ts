import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import * as L from 'leaflet/dist/leaflet-src.esm.js';
import { vi } from 'vitest';
import { routes } from '../../app.routes';
import { Communication, Incident, MapLocation } from '../../core/models/operations';
import { WorldSnapshot } from '../../core/models/world';
import { Geocoding } from '../../core/services/geocoding';
import { Operations } from '../../core/services/operations';
import { Routing } from '../../core/services/routing';
import { Home } from './home';

// Las vistas de detalle se sirven del backend, no de los mocks de la maqueta: el escenario se
// define aquí a partir de un snapshot como el que publica la API.
const REPORT_AT = '2026-09-19T12:00:00Z';
const INCIDENT: Incident = {
  id: 'zone-centro',
  title: 'Incendio en nave industrial',
  area: 'Centro',
  address: 'Calle Mayor 3, Madrid',
  priority: 'P0',
  status: 'En atención',
  icon: 'fire',
  coordinates: { lat: 40.41, lng: -3.7 },
};
const UNIT: MapLocation = {
  id: 'B-03',
  label: 'B-03',
  address: 'Parque de bomberos 2',
  coordinates: { lat: 40.42, lng: -3.71 },
  icon: 'fire-truck',
  kind: 'unit',
  incidentId: INCIDENT.id,
  resourceStatus: 'En ruta',
  service: 'Bomberos',
  contactId: 'contact-1',
};
const OTHER_UNIT: MapLocation = {
  ...UNIT,
  id: 'A-01',
  label: 'A-01',
  coordinates: { lat: 40.43, lng: -3.72 },
  icon: 'medical',
  service: 'Sanitarios',
  contactId: 'contact-2',
};
const COMMUNICATION: Communication = {
  id: UNIT.id,
  vehicle: UNIT.id,
  vehicleLabel: UNIT.label,
  time: '12:00',
  status: 'En ruta',
  message: 'Unidad en camino al punto indicado.',
  service: 'Bomberos',
  agent: 'E. Gil',
  incidentId: INCIDENT.id,
  icon: 'fire-truck',
};

function snapshot(): WorldSnapshot {
  return {
    version: 1,
    generated_at: REPORT_AT,
    incident: { id: INCIDENT.id, name: 'Crisis', started_at: REPORT_AT },
    zones: [
      {
        id: INCIDENT.id,
        name: 'Centro',
        civilians_present: 8,
        injured: 3,
        shelter_capacity: 40,
      },
    ],
    fronts: [],
    resources: [
      {
        id: UNIT.id,
        name: 'Autobomba B-03',
        type: 'fire_engine',
        status: 'en_route',
        capacity: 6,
        location: { lat: UNIT.coordinates.lat, lng: UNIT.coordinates.lng, label: 'Parque 2' },
        notes: ['Escala', 'Excarcelación'],
        assigned_task_id: 'task-done',
      },
    ],
    contacts: [{ id: 'contact-1', name: 'E. Gil', resource_id: UNIT.id, reliability: 0.8 }],
    tasks: [
      {
        id: 'task-done',
        title: 'Extinción en Calle Mayor',
        zone_id: INCIDENT.id,
        resource_ids: [UNIT.id],
        status: 'done',
        updated_at: REPORT_AT,
        outcome: 'Fuego controlado.',
      },
    ],
    recent_actions: [],
    incoming_calls: [],
    agent: { mode: 'running', autonomous: true },
  } as unknown as WorldSnapshot;
}

describe('Individual dashboard views', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        {
          provide: Operations,
          useValue: {
            incidents: signal([INCIDENT]),
            units: signal([UNIT, OTHER_UNIT]),
            communications: signal([COMMUNICATION]),
            snapshot: signal(snapshot()),
            meta: signal({ happyrobot_mode: 'simulated', geocoding_enabled: true }),
            connection: signal('live'),
            error: signal(''),
            operatorKey: signal(''),
            now: signal(Date.parse(REPORT_AT)),
            paused: signal(false),
            modeLabel: signal('Órdenes simuladas'),
            start: vi.fn(),
            refresh: vi.fn(),
            approve: vi.fn().mockResolvedValue({}),
            cancelTask: vi.fn().mockResolvedValue({}),
            geocode: vi.fn().mockResolvedValue({}),
            confirmLocation: vi.fn().mockResolvedValue({}),
            resumeSimulated: vi.fn().mockResolvedValue({}),
            generateDemoQuestion: vi.fn().mockResolvedValue({}),
            answerQuestion: vi.fn().mockResolvedValue({}),
          },
        },
        { provide: Geocoding, useValue: { geocode: vi.fn() } },
        { provide: Routing, useValue: { calculate: vi.fn().mockResolvedValue(null) } },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens incident details in place, reusing the same map, and returns to both widgets', async () => {
    const harness = await RouterTestingHarness.create('/');
    const element = harness.routeNativeElement!;
    const map = element.querySelector('.leaflet-container');
    expect(element.querySelector('.overview-widgets')?.hasAttribute('hidden')).toBe(false);
    await harness.navigateByUrl(`/?incidencia=${INCIDENT.id}`, Home);
    await harness.fixture.whenStable();
    expect(element.querySelectorAll('app-operational-map')).toHaveLength(1);
    expect(element.querySelector('.leaflet-container')).toBe(map);
    expect(element.querySelector('.overview-widgets')?.hasAttribute('hidden')).toBe(true);
    expect(element.querySelector('app-incidents')).not.toBeNull();
    expect(element.querySelector('.detail-heading')?.textContent).toContain(INCIDENT.id);
    element.querySelector<HTMLAnchorElement>('.back-button')!.click();
    await harness.fixture.whenStable();
    expect(element.querySelector('.overview-widgets')?.hasAttribute('hidden')).toBe(false);
    expect(element.querySelector('app-incidents')).toBeNull();
    expect(element.querySelector('.leaflet-container')).toBe(map);
  });

  it('focuses the located marker on direct entry to a resource and keeps backend fields', async () => {
    const focus = vi.spyOn(L.Map.prototype, 'flyTo');
    const harness = await RouterTestingHarness.create(`/?recurso=${UNIT.id}`);
    const element = harness.routeNativeElement!;
    expect(element.querySelector('.detail-heading')?.textContent).toContain(UNIT.id);
    // Perfil, capacidad e historial vienen del snapshot, no de perfiles mock.
    expect(element.textContent).toContain('Autobomba B-03');
    expect(element.textContent).toContain('Capacidad declarada: 6');
    expect(element.textContent).toContain('Intervenciones previas');
    expect(focus).toHaveBeenCalledWith(
      [UNIT.coordinates.lat, UNIT.coordinates.lng],
      15,
      expect.objectContaining({ animate: true }),
    );
    element.querySelector<HTMLAnchorElement>('.current-assignment')!.click();
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe(`/?incidencia=${INCIDENT.id}`);
    expect(element.querySelectorAll('app-operational-map')).toHaveLength(1);
  });

  it('ignores detail IDs the backend does not know once a snapshot has arrived', async () => {
    const harness = await RouterTestingHarness.create();
    const home = await harness.navigateByUrl(`/?incidencia=${INCIDENT.id}`, Home);
    await harness.fixture.whenStable();
    expect(home.detail()).toBe('incident');
    await harness.navigateByUrl('/?incidencia=missing', Home);
    await harness.fixture.whenStable();
    expect(home.detail()).toBeNull();
    expect(home.selectedIncidentId()).toBeNull();
    expect(
      harness.routeNativeElement?.querySelector('.overview-widgets')?.hasAttribute('hidden'),
    ).toBe(false);
  });

  it('shows the incident triage note and its associated resources in the embedded detail', async () => {
    const harness = await RouterTestingHarness.create(`/?incidencia=${INCIDENT.id}`);
    const element = harness.routeNativeElement!;
    const people = element.querySelector('[aria-label="Personas implicadas"]')!;
    expect(people.textContent).toContain('8 personas');
    expect(people.textContent).toContain('3 necesitan asistencia');
    expect(people.querySelector('.affected-note')?.textContent).toContain('heridos');
    const services = element.querySelector('app-incident-activity app-service-feed')!;
    expect(services.querySelector('.resource-agent')?.textContent).toContain('E. Gil');
    expect(services.querySelector('.locate-button')).not.toBeNull();
    expect(element.querySelector('app-operation-timeline')).not.toBeNull();
  });

  it('keeps the operator controls out of the detail when the incident is not a citizen report', async () => {
    const harness = await RouterTestingHarness.create(`/?incidencia=${INCIDENT.id}`);
    expect(harness.routeNativeElement?.querySelector('.operator-controls')).toBeNull();
  });
});

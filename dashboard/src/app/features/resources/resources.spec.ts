import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { vi } from 'vitest';
import { Subject } from 'rxjs';
import { OperationLogEvent } from '../../core/models/operation-log';
import { MapLocation } from '../../core/models/operations';
import { DemoRouteSimulation } from '../../core/services/demo-route-simulation';
import { routes } from '../../app.routes';
import { MOCK_UNITS } from '../../core/data/operations.mock';
import { Geocoding } from '../../core/services/geocoding';
import { Routing } from '../../core/services/routing';
import { Incidents } from '../incidents/incidents';
import { Resources } from './resources';
import { OperationLogStore } from '../home/operation-log/operation-log-store';
import { IncidentStore } from '../incidents/incident-store';

describe('Scripted emergency demo', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [{ provide: Routing, useValue: { calculate: vi.fn().mockResolvedValue(null) } }],
    }),
  );

  it('waits for a second Space before dispatching the gas leak resources or announcing their departure', () => {
    const log = TestBed.inject(OperationLogStore);
    const store = TestBed.inject(IncidentStore);
    const units = store.units();
    const communications = store.communications();
    const simulation = vi.spyOn(TestBed.inject(DemoRouteSimulation), 'start');
    log.advanceDemo();
    expect(store.incidents()).toHaveLength(3);
    expect(store.incidents().find((incident) => incident.id === 'INC-001')?.status).toBe(
      'Pendiente de movilización',
    );
    expect(store.units()).toEqual(units);
    expect(store.communications()).toEqual(communications);
    expect(simulation).not.toHaveBeenCalled();
    expect(store.events().filter((event) => event.incidentId === 'INC-001')).toHaveLength(4);
    expect(
      store
        .events()
        .some((event) => event.id === 'demo:coordination' || event.id === 'demo:INC-001:call:3'),
    ).toBe(false);
    log.advanceDemo();
    expect(store.incidents()).toHaveLength(3);
    expect(store.incidents().find((incident) => incident.id === 'INC-001')?.status).toBe(
      'Recursos en camino',
    );
    for (const id of ['B-03', 'A-01']) {
      expect(store.units().find((unit) => unit.id === id)).toMatchObject({
        incidentId: 'INC-001',
        route: { status: 'active' },
      });
    }
    expect(store.events().filter((event) => event.id === 'demo:coordination')).toHaveLength(1);
    expect(store.events().filter((event) => event.id === 'demo:INC-001:call:3')).toHaveLength(1);
    expect(
      store
        .events()
        .filter((event) => event.incidentId === 'INC-001' && event.kind === 'assignment'),
    ).toHaveLength(2);
    expect(log.pending()).toHaveLength(0);
    log.advanceDemo();
    expect(log.pending()).toHaveLength(1);
    expect(store.events().filter((event) => event.id === 'demo:coordination')).toHaveLength(1);
  });

  it.each([1000, 100000])(
    'reroutes B-03 only when Space reveals its rescue assignment (%i ms into the original journey)',
    async (elapsed) => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
      try {
        const calculate = vi.mocked(TestBed.inject(Routing).calculate);
        calculate.mockImplementation(async (origin, route) => ({
          path: [origin, route.destination],
          durationSeconds: 1000,
          distanceMeters: 2000,
        }));
        const log = TestBed.inject(OperationLogStore);
        const store = TestBed.inject(IncidentStore);
        const simulation = TestBed.inject(DemoRouteSimulation);
        const unit = () => store.units().find((item) => item.id === 'B-03')!;
        const timeline = () =>
          log.visibleTimelineEvents(
            store.events().filter((event) => event.incidentId === 'INC-003'),
          );
        log.advanceDemo();
        log.advanceDemo();
        await vi.advanceTimersByTimeAsync(elapsed);
        const original = unit();
        log.advanceDemo();
        log.advanceDemo();
        expect(unit()).toBe(original);
        expect(store.incidents().find((incident) => incident.id === 'INC-003')?.status).toBe(
          'Rescate prioritario · Buscando equipo',
        );
        expect(store.resourceHistory()).toHaveLength(0);
        expect(store.events().some((event) => event.id === 'INC-003:assigned:B-03')).toBe(false);
        for (let index = 0; index < 4; index++) {
          log.advanceDemo();
          await vi.advanceTimersByTimeAsync(200);
          expect(unit()).toBe(original);
          expect(unit().incidentId).toBe('INC-001');
          expect(timeline()).toHaveLength(4 + index);
        }
        expect(calculate.mock.calls.some(([, route]) => route.destination.lat === 40.6112)).toBe(
          false,
        );
        expect(timeline().at(-1)?.id).toBe('demo:rescue-decision');
        const position = simulation.project(unit()).coordinates;
        expect(position).not.toEqual(original.coordinates);
        log.advanceDemo();
        expect(timeline().at(-1)).toMatchObject({
          id: 'INC-003:assigned:B-03',
          title: 'Recurso asignado',
          description: 'B-03 asignado a INC-003 desde INC-001. Recurso en camino.',
        });
        expect(unit()).toMatchObject({
          incidentId: 'INC-003',
          coordinates: position,
          route: { status: 'active', destination: { lat: 40.6112, lng: -3.7049 } },
        });
        expect(store.incidents().find((incident) => incident.id === 'INC-001')?.status).toBe(
          'Fuga pendiente · Recursos reducidos',
        );
        expect(store.incidents().find((incident) => incident.id === 'INC-003')?.status).toBe(
          'Rescate prioritario · Recursos en camino',
        );
        expect(store.units().find((item) => item.id === 'A-01')?.incidentId).toBe('INC-001');
        expect(store.resourceHistory()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(200);
        expect(simulation.project(unit()).coordinates).not.toEqual(position);
        const rescueRequests = () =>
          calculate.mock.calls.filter(([, route]) => route.destination.lat === 40.6112);
        expect(rescueRequests()).toHaveLength(1);
        expect(rescueRequests()[0][0]).toEqual(position);
        const assigned = unit();
        log.advanceDemo();
        log.advanceDemo();
        expect(unit()).toBe(assigned);
        expect(rescueRequests()).toHaveLength(1);
        expect(store.events().filter((event) => event.id === 'INC-003:assigned:B-03')).toHaveLength(
          1,
        );
      } finally {
        TestBed.resetTestingModule();
        vi.useRealTimers();
      }
    },
  );

  it('creates incidents progressively and transfers the only available fire crew without duplicates', () => {
    const log = TestBed.inject(OperationLogStore);
    const store = TestBed.inject(IncidentStore);
    expect(store.incidents().some((incident) => incident.id === 'INC-001')).toBe(false);
    expect(store.units().filter((unit) => unit.icon === 'fire-truck')).toHaveLength(4);
    log.advanceDemo();
    log.advanceDemo();
    expect(
      store
        .units()
        .filter((unit) => unit.incidentId === 'INC-001')
        .map((unit) => unit.id)
        .sort(),
    ).toEqual(['A-01', 'B-03']);
    expect(store.units().find((unit) => unit.id === 'B-03')?.route?.status).toBe('active');
    expect(store.incidents().find((incident) => incident.id === 'INC-001')?.title).toBe(
      'Fuga de gas en la planta',
    );
    expect(
      store
        .events()
        .some(
          (event) =>
            event.description === 'Hay varios afectados, pero están fuera. No queda nadie dentro.',
        ),
    ).toBe(true);
    expect(store.communications().find((item) => item.vehicle === 'A-01')?.message).toContain(
      'afectados',
    );
    log.advanceDemo();
    expect(store.incidents().find((incident) => incident.id === 'INC-002')?.status).toBe(
      'Producción detenida · Pendiente de decisión',
    );
    expect(log.pending()).toHaveLength(1);
    expect(log.pending()[0].incidentId).toBe('INC-002');
    expect(log.pending()[0].options).toHaveLength(2);
    log.advanceDemo();
    expect(store.units().find((unit) => unit.id === 'B-03')?.incidentId).toBe('INC-001');
    for (let step = 0; step < 5; step++) log.advanceDemo();
    expect(store.units().find((unit) => unit.id === 'B-03')?.incidentId).toBe('INC-003');
    expect(store.incidents().find((incident) => incident.id === 'INC-003')).toMatchObject({
      title: 'Segunda explosión · Personas atrapadas',
      priority: 'P0',
      status: 'Rescate prioritario · Recursos en camino',
    });
    expect(store.incidents().find((incident) => incident.id === 'INC-001')?.status).toBe(
      'Fuga pendiente · Recursos reducidos',
    );
    expect(
      store
        .events()
        .filter((event) => event.id.startsWith('demo:unavailable:'))
        .map((event) => event.title),
    ).toEqual([
      'Equipo 2 · B-07 → No disponible',
      'Equipo 3 · B-09 → No disponible',
      'Equipo 4 · B-11 → No disponible',
    ]);
    expect(store.units().find((unit) => unit.id === 'B-07')?.incidentId).toBe('INC-004');
    expect(store.units().find((unit) => unit.id === 'B-09')?.incidentId).toBe('INC-008');
    expect(store.units().find((unit) => unit.id === 'B-11')?.incidentId).toBe('INC-008');
    expect(store.communications().find((item) => item.vehicle === 'B-03')?.message).toContain(
      'rescatar',
    );
    expect(
      store
        .units()
        .filter((unit) => unit.incidentId === 'INC-001')
        .map((unit) => unit.id),
    ).toEqual(['A-01']);
    expect(new Set(store.units().map((unit) => unit.id)).size).toBe(store.units().length);
    expect(
      store
        .events()
        .some((event) => event.incidentId === 'INC-001' && event.title === 'Recurso reasignado'),
    ).toBe(true);
    expect(store.communications().find((item) => item.vehicle === 'B-03')?.incidentId).toBe(
      'INC-003',
    );
    expect(
      store
        .resourceHistory()
        .some((entry) => entry.incidentId === 'INC-001' && entry.resourceIds.includes('B-03')),
    ).toBe(true);
    const count = store.events().length;
    log.advanceDemo();
    expect(store.events()).toHaveLength(count);
    expect(log.pending()).toHaveLength(1);
  });

  it.each([
    ['alternative', 'Producción parcial recuperada'],
    ['repair', 'Línea principal en reparación · Producción detenida'],
  ])('applies the %s decision consistently and only once', (option, status) => {
    const log = TestBed.inject(OperationLogStore);
    const store = TestBed.inject(IncidentStore);
    log.advanceDemo();
    log.advanceDemo();
    log.advanceDemo();
    const question = log.pending()[0];
    log.updateDraft(question, { custom: false, optionIds: [option], text: '' });
    log.submit(question.id);
    expect(store.incidents().find((incident) => incident.id === 'INC-002')?.status).toBe(status);
    expect(store.details()['INC-002'].affectedNote).toContain(
      option === 'alternative' ? 'línea de producción alternativa' : 'mayor capacidad',
    );
    expect(log.pending()).toHaveLength(0);
    expect(log.questions()[0].resolution?.applied).toBe(true);
    expect(store.events().some((event) => event.title === 'Plan actualizado')).toBe(true);
    expect(store.events().some((event) => event.title === status)).toBe(true);
    log.advanceDemo();
    expect(store.incidents().find((incident) => incident.id === 'INC-002')?.status).toBe(status);
    const count = store.events().length;
    log.submit(question.id);
    expect(store.events()).toHaveLength(count);
  });
});

describe('Industrial demo arrivals', () => {
  it('advances gas control and rescue on arrival without erasing the reduced coverage', () => {
    const arrivals = new Subject<OperationLogEvent>();
    const completed = new Set<string>();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DemoRouteSimulation,
          useValue: {
            start: vi.fn(),
            arrivals$: arrivals.asObservable(),
            project: (unit: MapLocation) =>
              completed.has(unit.id) && unit.route
                ? { ...unit, route: { ...unit.route, status: 'completed' as const } }
                : unit,
          },
        },
      ],
    });
    const log = TestBed.inject(OperationLogStore);
    const store = TestBed.inject(IncidentStore);
    const arrive = (unitId: string, incidentId: string) => {
      completed.add(unitId);
      arrivals.next({
        id: `${incidentId}:arrival:${unitId}`,
        incidentId,
        occurredAt: new Date().toISOString(),
        kind: 'arrival',
        title: 'Recurso en destino',
        description: unitId,
        source: 'Seguimiento de recursos',
      });
    };
    log.advanceDemo();
    log.advanceDemo();
    arrive('B-03', 'INC-001');
    expect(store.incidents().find((incident) => incident.id === 'INC-001')?.status).toBe(
      'Recursos en camino',
    );
    arrive('A-01', 'INC-001');
    expect(store.incidents().find((incident) => incident.id === 'INC-001')?.status).toBe(
      'Control de fuga y atención sanitaria',
    );
    log.advanceDemo();
    log.advanceDemo();
    for (let step = 0; step < 5; step++) log.advanceDemo();
    completed.delete('B-03');
    arrive('A-01', 'INC-001');
    expect(store.incidents().find((incident) => incident.id === 'INC-001')?.status).toBe(
      'Fuga pendiente · Recursos reducidos',
    );
    arrive('B-03', 'INC-003');
    expect(store.incidents().find((incident) => incident.id === 'INC-003')?.status).toBe(
      'Rescate en curso · Prioridad máxima',
    );
    expect(
      store.events().some((event) => event.title === 'Rescate en curso · Prioridad máxima'),
    ).toBe(true);
  });
});

describe('Resources smoke checks', () => {
  beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false })));
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        { provide: Geocoding, useValue: { geocode: vi.fn() } },
        { provide: Routing, useValue: { calculate: vi.fn().mockResolvedValue(null) } },
      ],
    }),
  );

  it('lists only units and combines filters without clearing them on selection', async () => {
    TestBed.inject(OperationLogStore).advanceDemo();
    TestBed.inject(OperationLogStore).advanceDemo();
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('/recursos', Resources);
    expect(page.units()).toHaveLength(MOCK_UNITS.filter((unit) => unit.kind === 'unit').length);
    expect(page.selectedUnit()).toBeUndefined();
    page.setFilter('service', 'Bomberos');
    page.setFilter('incident', 'INC-001');
    page.setFilter('query', 'B-03');
    await harness.fixture.whenStable();
    expect(page.filteredUnits().map((unit) => unit.id)).toEqual(['B-03']);
    page.selectResource('B-03');
    await harness.fixture.whenStable();
    expect(page.filteredUnits().map((unit) => unit.id)).toEqual(['B-03']);
    expect(harness.routeNativeElement?.querySelector('.current-assignment')?.textContent).toContain(
      'INC-001',
    );
    expect(harness.routeNativeElement?.querySelectorAll('.history-list a')).toHaveLength(0);
    expect(harness.routeNativeElement?.querySelectorAll('.map-marker.kind-unit')).toHaveLength(1);
  });

  it('opens the linked incident from the current assignment and history', async () => {
    const log = TestBed.inject(OperationLogStore);
    log.advanceDemo();
    log.advanceDemo();
    log.advanceDemo();
    log.advanceDemo();
    for (let step = 0; step < 5; step++) log.advanceDemo();
    const harness = await RouterTestingHarness.create('/recursos?recurso=B-03');
    const link =
      harness.routeNativeElement!.querySelector<HTMLAnchorElement>('.current-assignment')!;
    link.click();
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/incidencias?incidencia=INC-003');
    expect(harness.routeNativeElement?.querySelector('.detail-heading')?.textContent).toContain(
      'INC-003',
    );
    await harness.navigateByUrl('/recursos?recurso=B-03', Resources);
    harness.routeNativeElement!.querySelector<HTMLAnchorElement>('.history-list a')!.click();
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/incidencias?incidencia=INC-001');
    expect(harness.routeNativeElement?.querySelector('.detail-heading')?.textContent).toContain(
      'INC-001',
    );
  });

  it('supports direct links, missing IDs and empty filter results', async () => {
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('/recursos?recurso=A-01', Resources);
    expect(page.selectedUnit()?.id).toBe('A-01');
    page.setFilter('status', 'Disponible');
    await harness.fixture.whenStable();
    expect(page.filteredUnits().some((unit) => unit.id === 'A-01')).toBe(true);
    page.setFilter('query', 'recurso inexistente');
    await harness.fixture.whenStable();
    expect(page.filteredUnits()).toHaveLength(0);
    expect(page.selectedUnit()).toBeUndefined();
    expect(harness.routeNativeElement?.textContent).toContain('No hay coincidencias');
    await harness.navigateByUrl('/recursos?recurso=unknown', Resources);
    expect(page.selectedUnit()).toBeUndefined();
    const incident = await harness.navigateByUrl('/incidencias?incidencia=unknown', Incidents);
    expect(incident.selectedIncident()).toBeUndefined();
  });
});

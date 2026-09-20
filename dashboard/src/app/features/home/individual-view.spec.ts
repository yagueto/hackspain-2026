import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { vi } from 'vitest';
import { filter, firstValueFrom } from 'rxjs';
import * as L from 'leaflet/dist/leaflet-src.esm.js';
import { CalculatedRoute } from '../../core/models/operations';
import { DemoRouteSimulation } from '../../core/services/demo-route-simulation';
import { Incidents } from '../incidents/incidents';
import { routes } from '../../app.routes';
import { Geocoding } from '../../core/services/geocoding';
import { Routing } from '../../core/services/routing';
import { IncidentStore } from '../incidents/incident-store';
import { Home } from './home';
import { OperationLogStore } from './operation-log/operation-log-store';

describe('Individual demo views', () => {
  const svgSupported = L.Browser.svg;
  beforeAll(() => Object.defineProperty(L.Browser, 'svg', { value: true, configurable: true }));
  afterAll(() =>
    Object.defineProperty(L.Browser, 'svg', { value: svgSupported, configurable: true }),
  );
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        { provide: Geocoding, useValue: { geocode: vi.fn() } },
        { provide: Routing, useValue: { calculate: vi.fn().mockResolvedValue(null) } },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens details in place and returns to the overview without replacing the map', async () => {
    const harness = await RouterTestingHarness.create('/');
    const element = harness.routeNativeElement!;
    const map = element.querySelector('.leaflet-container');
    element.querySelector<HTMLAnchorElement>('.incident-row .detail-link')!.click();
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/?incidencia=INC-004');
    expect(element.querySelectorAll('app-operational-map')).toHaveLength(1);
    expect(element.querySelector('.leaflet-container')).toBe(map);
    expect(element.querySelector('.overview-widgets')?.hasAttribute('hidden')).toBe(true);
    element.querySelector<HTMLAnchorElement>('.back-button')!.click();
    await harness.fixture.whenStable();
    expect(element.querySelector('.overview-widgets')?.hasAttribute('hidden')).toBe(false);
    expect(element.querySelector('.leaflet-container')).toBe(map);
  });

  it('preserves the production decision draft across views and resolves it in the resource timeline', async () => {
    const log = TestBed.inject(OperationLogStore);
    log.advanceDemo();
    log.advanceDemo();
    log.advanceDemo();
    const harness = await RouterTestingHarness.create('/?incidencia=INC-002');
    harness.routeNativeElement!.querySelector<HTMLInputElement>('input[value="repair"]')!.click();
    await harness.navigateByUrl('/', Home);
    await harness.navigateByUrl('/?recurso=T-01', Home);
    const element = harness.routeNativeElement!;
    expect(element.querySelector<HTMLInputElement>('input[value="repair"]')?.checked).toBe(true);
    element.querySelector<HTMLButtonElement>('.submit-answer')!.click();
    await harness.fixture.whenStable();
    expect(log.pending()).toHaveLength(0);
    expect(element.textContent).toContain('Línea principal en reparación · Producción detenida');
    expect(element.textContent).toContain('Respuesta del coordinador');
    expect(
      TestBed.inject(IncidentStore)
        .communications()
        .find((item) => item.vehicle === 'T-01')?.message,
    ).toContain('mayor capacidad');
  });

  it('opens a pending decision from the incident list without the former log overlay', async () => {
    const log = TestBed.inject(OperationLogStore);
    log.advanceDemo();
    log.advanceDemo();
    log.advanceDemo();
    const harness = await RouterTestingHarness.create('/');
    harness
      .routeNativeElement!.querySelector<HTMLButtonElement>('.awaiting-human .incident-select')!
      .click();
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/?incidencia=INC-002');
    expect(harness.routeNativeElement?.querySelector('app-urgent-question-card')).not.toBeNull();
    expect(harness.routeNativeElement?.querySelector('app-operation-log-panel')).toBeNull();
  });

  it.each(['.awaiting-human', '.awaiting-human .incident-select', '.awaiting-human .detail-link'])(
    'opens a newly created pending incident on the first %s click when its URL was already selected',
    async (selector) => {
      const harness = await RouterTestingHarness.create('/?incidencia=INC-002');
      const element = harness.routeNativeElement!;
      const map = element.querySelector('.leaflet-container');
      expect(element.querySelector('app-incidents')).toBeNull();
      const log = TestBed.inject(OperationLogStore);
      log.advanceDemo();
      log.advanceDemo();
      await harness.fixture.whenStable();
      log.advanceDemo();
      await harness.fixture.whenStable();
      expect(TestBed.inject(Router).url).toBe('/?incidencia=INC-002');
      expect(element.querySelector('app-incidents')).toBeNull();
      expect(element.querySelector('.overview-widgets')?.hasAttribute('hidden')).toBe(false);
      element.querySelector<HTMLElement>(selector)!.click();
      await harness.fixture.whenStable();
      expect(TestBed.inject(Router).url).toBe('/?incidencia=INC-002');
      expect(element.querySelector('.detail-heading')?.textContent).toContain('INC-002');
      expect(element.querySelector('app-urgent-question-card')).not.toBeNull();
      expect(element.querySelector('.overview-widgets')?.hasAttribute('hidden')).toBe(true);
      expect(element.querySelector('.leaflet-container')).toBe(map);
      expect(log.pending()).toHaveLength(1);
    },
  );

  it('reveals the second explosion timeline one event per Space and preserves progress across views', async () => {
    const log = TestBed.inject(OperationLogStore);
    const store = TestBed.inject(IncidentStore);
    log.advanceDemo();
    log.advanceDemo();
    log.advanceDemo();
    log.advanceDemo();
    const harness = await RouterTestingHarness.create('/?incidencia=INC-003');
    const rows = () => [...harness.routeNativeElement!.querySelectorAll('.timeline-event')];
    expect(rows().map((row) => row.querySelector('h3')?.textContent)).toEqual([
      'Incidencia notificada',
      'Llamada · Informante',
      'Llamada · Agente',
    ]);
    const first = rows()[0];
    const expected = [
      'Equipo 2 · B-07 → No disponible',
      'Equipo 3 · B-09 → No disponible',
      'Equipo 4 · B-11 → No disponible',
      'Agente · Reasignación autónoma',
      'Recurso asignado',
      'Rescate segunda zona → Prioridad máxima',
    ];
    for (const [index, title] of expected.entries()) {
      log.advanceDemo();
      await harness.fixture.whenStable();
      expect(rows()).toHaveLength(4 + index);
      expect(store.units().find((unit) => unit.id === 'B-03')?.incidentId).toBe(
        index < 4 ? 'INC-001' : 'INC-003',
      );
      expect(rows().at(-1)?.querySelector('h3')?.textContent).toBe(title);
      expect(rows()[0]).toBe(first);
      expect(TestBed.inject(Router).url).toBe('/?incidencia=INC-003');
    }
    const eventCount = store.events().length;
    log.advanceDemo();
    log.advanceDemo();
    await harness.fixture.whenStable();
    expect(rows()).toHaveLength(9);
    expect(store.events()).toHaveLength(eventCount);
    await harness.navigateByUrl('/?recurso=B-03', Home);
    expect(rows()).toHaveLength(9);
    await harness.navigateByUrl('/?incidencia=INC-003', Home);
    expect(rows()).toHaveLength(9);
    expect(log.pending()).toHaveLength(1);
    await harness.navigateByUrl('/?incidencia=INC-002', Home);
    expect(harness.routeNativeElement?.querySelector('app-urgent-question-card')).not.toBeNull();
    await harness.navigateByUrl('/?incidencia=INC-003', Home);
    for (const [index, title] of [
      'Recurso en destino',
      'Rescate en curso · Prioridad máxima',
    ].entries()) {
      store.appendEvent({
        id: `late:${index}`,
        incidentId: 'INC-003',
        occurredAt: new Date().toISOString(),
        title,
        description: title,
        source: 'Seguimiento de recursos',
        kind: 'arrival',
      });
    }
    await harness.fixture.whenStable();
    expect(rows()).toHaveLength(9);
    log.advanceDemo();
    await harness.fixture.whenStable();
    expect(rows()).toHaveLength(10);
    expect(rows().at(-1)?.querySelector('h3')?.textContent).toBe('Recurso en destino');
    log.advanceDemo();
    await harness.fixture.whenStable();
    expect(rows()).toHaveLength(11);
    expect(rows().at(-1)?.querySelector('h3')?.textContent).toBe(
      'Rescate en curso · Prioridad máxima',
    );
    log.advanceDemo();
    await harness.fixture.whenStable();
    expect(rows()).toHaveLength(11);
  });

  it.each(['/', '/?incidencia=INC-003', '/incidencias?incidencia=INC-003'])(
    'focuses B-03 once the rescue route is ready without leaving %s',
    async (url) => {
      let finish!: (route: CalculatedRoute) => void;
      const pendingRoute = new Promise<CalculatedRoute>((resolve) => {
        finish = resolve;
      });
      const calculate = vi.mocked(TestBed.inject(Routing).calculate);
      calculate.mockImplementation(async (origin, route) =>
        route.destination.lat === 40.6112
          ? pendingRoute
          : { path: [origin, route.destination], durationSeconds: 1000, distanceMeters: 2000 },
      );
      const log = TestBed.inject(OperationLogStore);
      for (let step = 0; step < 4; step++) log.advanceDemo();
      const harness = await RouterTestingHarness.create(url);
      const page = harness.routeDebugElement!.componentInstance as Home | Incidents;
      expect(page.selectedUnitId()).toBeNull();
      if (page instanceof Home && url === '/') page.visibleUnitIds.set(['A-01']);
      for (let step = 0; step < 5; step++) log.advanceDemo();
      await harness.fixture.whenStable();
      const store = TestBed.inject(IncidentStore);
      const unit = store.units().find((item) => item.id === 'B-03')!;
      expect(unit.incidentId).toBe('INC-003');
      expect(page.selectedUnitId()).toBeNull();
      const focus = vi.spyOn(L.Map.prototype, 'flyTo');
      const started = firstValueFrom(
        TestBed.inject(DemoRouteSimulation).journeyStarts$.pipe(
          filter((unit) => unit.id === 'B-03' && unit.incidentId === 'INC-003'),
        ),
      );
      finish({
        path: [unit.coordinates, unit.route!.destination],
        durationSeconds: 1000,
        distanceMeters: 2000,
      });
      await started;
      await harness.fixture.whenStable();
      expect(page.selectedUnitId()).toBe('B-03');
      expect(
        harness.routeNativeElement?.querySelector('[aria-label="B-03"] .map-marker.is-selected'),
      ).not.toBeNull();
      expect(focus).toHaveBeenCalled();
      expect(TestBed.inject(Router).url).toBe(url);
      if (page instanceof Home) page.selectedUnitId.set(null);
      else page.selectIncident('INC-003');
      await harness.fixture.whenStable();
      TestBed.inject(DemoRouteSimulation).start(store.units());
      await new Promise((resolve) => setTimeout(resolve, 250));
      await harness.fixture.whenStable();
      expect(page.selectedUnitId()).toBeNull();
      expect(TestBed.inject(Router).url).toBe(url);
    },
  );

  it('keeps the selection on a failed rescue route and focuses B-03 only after a successful retry', async () => {
    const log = TestBed.inject(OperationLogStore);
    for (let step = 0; step < 4; step++) log.advanceDemo();
    const harness = await RouterTestingHarness.create('/?incidencia=INC-003');
    const home = harness.routeDebugElement!.componentInstance as Home;
    const calculate = vi.mocked(TestBed.inject(Routing).calculate);
    calculate.mockRejectedValueOnce(new Error('offline'));
    for (let step = 0; step < 5; step++) log.advanceDemo();
    await harness.fixture.whenStable();
    const unit = TestBed.inject(IncidentStore)
      .units()
      .find((item) => item.id === 'B-03')!;
    const simulation = TestBed.inject(DemoRouteSimulation);
    expect(simulation.project(unit).route?.navigation?.status).toBe('error');
    expect(home.selectedUnitId()).toBeNull();
    calculate.mockResolvedValueOnce({
      path: [unit.coordinates, unit.route!.destination],
      durationSeconds: 1000,
      distanceMeters: 2000,
    });
    simulation.retry('B-03');
    await harness.fixture.whenStable();
    expect(home.selectedUnitId()).toBe('B-03');
    expect(TestBed.inject(Router).url).toBe('/?incidencia=INC-003');
  });

  it('retains the unanswered decision when Space creates the third incident', async () => {
    const log = TestBed.inject(OperationLogStore);
    log.advanceDemo();
    log.advanceDemo();
    log.advanceDemo();
    log.advanceDemo();
    const harness = await RouterTestingHarness.create('/?incidencia=INC-002');
    expect(harness.routeNativeElement?.querySelector('app-urgent-question-card')).not.toBeNull();
    expect(log.attention().get('INC-002')?.count).toBe(1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(log.pending()[0].expiresAt) + 1);
    log.expireDue();
    await harness.fixture.whenStable();
    expect(log.pending()).toHaveLength(0);
    expect(harness.routeNativeElement?.textContent).toContain(
      'Respuesta automática por vencimiento',
    );
    expect(
      TestBed.inject(IncidentStore)
        .incidents()
        .find((incident) => incident.id === 'INC-002')?.status,
    ).toBe('Producción parcial recuperada');
  });
});

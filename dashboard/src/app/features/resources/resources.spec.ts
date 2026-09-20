import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { vi } from 'vitest';
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

  it('creates incidents progressively and transfers the only available fire crew without duplicates', () => {
    const log = TestBed.inject(OperationLogStore);
    const store = TestBed.inject(IncidentStore);
    expect(store.incidents().some((incident) => incident.id === 'INC-001')).toBe(false);
    expect(store.units().filter((unit) => unit.icon === 'fire-truck')).toHaveLength(3);
    log.advanceDemo();
    expect(
      store
        .units()
        .filter((unit) => unit.incidentId === 'INC-001')
        .map((unit) => unit.id)
        .sort(),
    ).toEqual(['A-01', 'B-03']);
    expect(store.units().find((unit) => unit.id === 'B-03')?.route?.status).toBe('active');
    log.advanceDemo();
    expect(log.pending()).toHaveLength(1);
    expect(log.pending()[0].incidentId).toBe('INC-002');
    expect(log.pending()[0].options).toHaveLength(2);
    log.advanceDemo();
    expect(store.units().find((unit) => unit.id === 'B-03')?.incidentId).toBe('INC-003');
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
    ['backup', 'Producción parcial · 40 %'],
    ['repair', 'Reparación principal · producción parada'],
  ])('applies the %s decision consistently and only once', (option, status) => {
    const log = TestBed.inject(OperationLogStore);
    const store = TestBed.inject(IncidentStore);
    log.advanceDemo();
    log.advanceDemo();
    const question = log.pending()[0];
    log.updateDraft(question, { custom: false, optionIds: [option], text: '' });
    log.submit(question.id);
    expect(store.incidents().find((incident) => incident.id === 'INC-002')?.status).toBe(status);
    expect(store.details()['INC-002'].affectedNote).toContain(
      option === 'backup' ? '40 %' : '90 minutos',
    );
    expect(log.pending()).toHaveLength(0);
    expect(log.questions()[0].resolution?.applied).toBe(true);
    const count = store.events().length;
    log.submit(question.id);
    expect(store.events()).toHaveLength(count);
  });
});

describe('Resources smoke checks', () => {
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

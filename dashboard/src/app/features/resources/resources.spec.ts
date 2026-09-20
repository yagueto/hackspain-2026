import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { vi } from 'vitest';
import { routes } from '../../app.routes';
import { createOperationsMock, MOCK_UNITS } from '../../core/data/operations.mock';
import { Operations } from '../../core/services/operations';
import { MOCK_RESOURCE_HISTORY } from './resources.mock';
import { Geocoding } from '../../core/services/geocoding';
import { Routing } from '../../core/services/routing';
import { Incidents } from '../incidents/incidents';
import { Resources } from './resources';

describe('Resources smoke checks', () => {
  beforeEach(() => {
    const operations = createOperationsMock();
    operations.snapshot.update((state) => ({
      ...state!,
      tasks: MOCK_RESOURCE_HISTORY.map((entry, index) => ({
        id: `history-${index}`,
        title: entry.summary,
        outcome: entry.summary,
        status: 'done',
        resource_ids: [...entry.resourceIds],
        zone_id: entry.incidentId,
        updated_at: entry.completedAt,
      })),
    }));
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        { provide: Operations, useValue: operations },
        { provide: Geocoding, useValue: { geocode: vi.fn() } },
        { provide: Routing, useValue: { calculate: vi.fn().mockResolvedValue(null) } },
      ],
    });
  });

  it('lists only units and combines filters without clearing them on selection', async () => {
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
    expect(harness.routeNativeElement?.querySelectorAll('.history-list li')).toHaveLength(2);
    expect(harness.routeNativeElement?.querySelectorAll('.map-marker.kind-unit')).toHaveLength(1);
  });

  it('opens the linked incident from the current assignment and history', async () => {
    const harness = await RouterTestingHarness.create('/recursos?recurso=B-03');
    const link =
      harness.routeNativeElement!.querySelector<HTMLAnchorElement>('.current-assignment')!;
    link.click();
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/incidencias?incidencia=INC-001');
    expect(harness.routeNativeElement?.querySelector('.detail-heading')?.textContent).toContain(
      'INC-001',
    );
    await harness.navigateByUrl('/recursos?recurso=B-03', Resources);
    harness.routeNativeElement!.querySelector<HTMLAnchorElement>('.history-list a')!.click();
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/incidencias?incidencia=INC-006');
    expect(harness.routeNativeElement?.querySelector('.detail-heading')?.textContent).toContain(
      'INC-006',
    );
  });

  it('supports direct links, missing IDs and empty filter results', async () => {
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('/recursos?recurso=A-01', Resources);
    expect(page.selectedUnit()?.id).toBe('A-01');
    page.setFilter('status', 'Disponible');
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

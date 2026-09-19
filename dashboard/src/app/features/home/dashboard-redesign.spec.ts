import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import * as L from 'leaflet/dist/leaflet-src.esm.js';
import { vi } from 'vitest';
import { MOCK_COMMUNICATIONS, MOCK_INCIDENTS, MOCK_UNITS } from '../../core/data/operations.mock';
import { Incident, MapLocation } from '../../core/models/operations';
import { Geocoding } from '../../core/services/geocoding';
import { Routing } from '../../core/services/routing';
import { Theme } from '../../core/services/theme';
import { IncidentList } from './incident-list/incident-list';
import { OperationalMap } from './operational-map/operational-map';
import { ServiceFeed } from './service-feed/service-feed';

describe('Dashboard redesign contracts', () => {
  const svgSupported = L.Browser.svg;
  beforeAll(() => Object.defineProperty(L.Browser, 'svg', { value: true, configurable: true }));
  afterAll(() =>
    Object.defineProperty(L.Browser, 'svg', { value: svgSupported, configurable: true }),
  );
  beforeEach(() => {
    localStorage.removeItem('dashboard-theme');
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: Geocoding, useValue: { geocode: vi.fn() } },
        { provide: Routing, useValue: { calculate: vi.fn().mockResolvedValue(null) } },
      ],
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem('dashboard-theme');
    delete document.documentElement.dataset['theme'];
  });

  it('sorts priorities stably, keeps missing priorities last and preserves selection', async () => {
    const incidents: Incident[] = [
      { ...MOCK_INCIDENTS[0], id: 'unknown', priority: null },
      { ...MOCK_INCIDENTS[0], id: 'one-a', priority: 'P1' },
      { ...MOCK_INCIDENTS[0], id: 'three', priority: 'P3' },
      { ...MOCK_INCIDENTS[0], id: 'one-b', priority: 'P1' },
      { ...MOCK_INCIDENTS[0], id: 'zero', priority: 'P0' },
      { ...MOCK_INCIDENTS[0], id: 'missing', priority: undefined },
    ];
    const fixture = TestBed.createComponent(IncidentList);
    fixture.componentRef.setInput('incidents', incidents);
    fixture.componentRef.setInput('selectedId', 'one-b');
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(
      [...element.querySelectorAll('.incident-id')].map((row) => row.textContent?.trim()),
    ).toEqual(['zero', 'one-a', 'one-b', 'three', 'unknown', 'missing']);
    expect(
      [...element.querySelectorAll('.priority')].map((row) => row.textContent?.trim()),
    ).toEqual(['0', '1', '1', '3', '—', '—']);
    expect(element.querySelector('.selected .incident-id')?.textContent).toBe('one-b');
    expect(element.querySelector('app-pagination')).toBeNull();
    expect(incidents[0].id).toBe('unknown');
  });

  it('separates detail navigation from map selection', async () => {
    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(IncidentList);
    fixture.componentRef.setInput('incidents', MOCK_INCIDENTS);
    const select = vi.fn();
    fixture.componentInstance.incidentSelected.subscribe(select);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    element.querySelector<HTMLAnchorElement>('.detail-link')!.click();
    expect(select).not.toHaveBeenCalled();
    element.querySelector<HTMLButtonElement>('.incident-select')!.click();
    expect(select).toHaveBeenCalledWith('INC-003');
  });

  it('filters list and map IDs together, preserves selection and restores Todos', async () => {
    const fixture = TestBed.createComponent(ServiceFeed);
    fixture.componentRef.setInput('communications', MOCK_COMMUNICATIONS);
    fixture.componentRef.setInput('resources', MOCK_UNITS);
    fixture.componentRef.setInput('selectedUnitId', 'B-03');
    const visible = vi.fn();
    fixture.componentInstance.visibleUnitsChanged.subscribe(visible);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelectorAll('.communication')).toHaveLength(MOCK_COMMUNICATIONS.length);
    element.querySelector<HTMLButtonElement>('.filter-button')!.click();
    await fixture.whenStable();
    const buttons = [...element.querySelectorAll<HTMLButtonElement>('.category-chip')];
    buttons.find((button) => button.textContent?.trim() === 'Sanitarios')!.click();
    await fixture.whenStable();
    expect(visible).toHaveBeenLastCalledWith(
      MOCK_COMMUNICATIONS.filter((item) => item.service === 'Sanitarios').map(
        (item) => item.vehicle,
      ),
    );
    expect(fixture.componentInstance.selectedUnitId()).toBe('B-03');
    buttons.find((button) => button.textContent?.trim() === 'Todos')!.click();
    await fixture.whenStable();
    expect(visible).toHaveBeenLastCalledWith(null);
    expect(element.querySelector('.related .resource-code')?.textContent).toBe('B-03');
    expect(element.querySelector('app-pagination')).toBeNull();
  });

  it('keeps operational statuses and unassigned agents readable', async () => {
    const fixture = TestBed.createComponent(ServiceFeed);
    fixture.componentRef.setInput('communications', [{ ...MOCK_COMMUNICATIONS[0], agent: '' }]);
    fixture.componentRef.setInput('resources', MOCK_UNITS);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.resource-agent')?.textContent).toBe('Sin asignar');
    expect(element.querySelector('.en-route')?.textContent).toBe('En ruta');
    fixture.componentRef.setInput('resources', [
      { ...MOCK_UNITS[0], route: { ...MOCK_UNITS[0].route!, status: 'completed' } },
    ]);
    await fixture.whenStable();
    expect(element.querySelector('.destination')?.textContent).toBe('En destino');
  });

  it('persists theme, swaps actual map tiles and preserves marker geometry and selection', async () => {
    localStorage.setItem('dashboard-theme', 'dark');
    const theme = TestBed.inject(Theme);
    expect(theme.current()).toBe('dark');
    const fixture = TestBed.createComponent(OperationalMap);
    fixture.componentRef.setInput('locations', [MOCK_UNITS[0]]);
    fixture.componentRef.setInput('selectedUnitId', 'B-03');
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    const geometry = element.querySelector('.marker-symbol')?.innerHTML;
    expect(element.querySelector('.leaflet-control-attribution')?.textContent).toContain('CARTO');
    theme.set('light');
    await fixture.whenStable();
    expect(localStorage.getItem('dashboard-theme')).toBe('light');
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(element.querySelector('.leaflet-control-attribution')?.textContent).not.toContain(
      'CARTO',
    );
    expect(element.querySelector('.leaflet-control-attribution')?.textContent).toContain(
      'OpenStreetMap',
    );
    expect(element.querySelector('.marker-symbol')?.innerHTML).toBe(geometry);
    expect(element.querySelector('.is-selected .marker-label')?.textContent).toBe('B-03');
  });

  it('draws geographic halos only for incidents and filters units without losing incidents', async () => {
    const radii: number[] = [];
    const onAdd = L.Circle.prototype.onAdd;
    vi.spyOn(L.Circle.prototype, 'onAdd').mockImplementation(function (this: L.Circle, map: L.Map) {
      radii.push(this.getRadius());
      return onAdd.call(this, map);
    });
    const incident: MapLocation = {
      ...MOCK_INCIDENTS[0],
      label: 'INC-001',
      kind: 'incident',
      incidentId: 'INC-001',
    };
    const fixture = TestBed.createComponent(OperationalMap);
    fixture.componentRef.setInput('locations', [
      incident,
      { ...MOCK_UNITS[0], radiusMeters: 900 },
      MOCK_UNITS[1],
    ]);
    await fixture.whenStable();
    expect(radii).toHaveLength(2);
    expect(radii[0]).toBe(650);
    expect(radii[1]).toBeCloseTo(455);
    fixture.componentRef.setInput('visibleUnitIds', ['B-03']);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelectorAll('.kind-unit')).toHaveLength(1);
    expect(element.querySelectorAll('.kind-incident')).toHaveLength(1);
  });
});

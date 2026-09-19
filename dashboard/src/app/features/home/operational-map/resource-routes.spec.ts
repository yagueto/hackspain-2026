import { TestBed } from '@angular/core/testing';
import * as L from 'leaflet/dist/leaflet-src.esm.js';
import { vi } from 'vitest';
import { MOCK_UNITS } from '../../../core/data/operations.mock';
import {
  CalculatedRoute,
  Coordinates,
  MapLocation,
  ResourceRoute,
} from '../../../core/models/operations';
import { Geocoding } from '../../../core/services/geocoding';
import { Routing } from '../../../core/services/routing';
import { OperationalMap } from './operational-map';
import { routeMidpoint } from './resource-route-layer';

const journey: ResourceRoute = {
  status: 'active',
  destination: { lat: 40.75, lng: -3.89 },
  destinationLabel: 'Destino de prueba',
};
const activeUnit: MapLocation = { ...MOCK_UNITS[0], route: journey };
const computedRoute = (origin: Coordinates, route: ResourceRoute): CalculatedRoute => ({
  path: [origin, route.destination],
  durationSeconds: 336,
  distanceMeters: 2695,
});

describe('Resource routes on the map', () => {
  const calculate = vi.fn();
  const svgSupported = L.Browser.svg;

  beforeAll(() => Object.defineProperty(L.Browser, 'svg', { value: true, configurable: true }));
  afterAll(() =>
    Object.defineProperty(L.Browser, 'svg', { value: svgSupported, configurable: true }),
  );
  beforeEach(() => {
    calculate
      .mockReset()
      .mockImplementation(async (origin: Coordinates, route: ResourceRoute) =>
        computedRoute(origin, route),
      );
    TestBed.configureTestingModule({
      providers: [
        { provide: Routing, useValue: { calculate } },
        { provide: Geocoding, useValue: { geocode: vi.fn() } },
      ],
    });
  });

  async function setup(locations: readonly MapLocation[] = [activeUnit]) {
    const fixture = TestBed.createComponent(OperationalMap);
    fixture.componentRef.setInput('locations', locations);
    await fixture.whenStable();
    return fixture;
  }

  it('draws only active routes and shows ETA only for the selected resource', async () => {
    const second: MapLocation = { ...MOCK_UNITS[3], route: journey };
    const fixture = await setup([
      activeUnit,
      second,
      { ...MOCK_UNITS[5], route: { ...journey, status: 'completed' } },
      MOCK_UNITS[2],
    ]);
    const element = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => expect(element.querySelectorAll('.resource-route').length).toBe(2));
    expect(calculate).toHaveBeenCalledTimes(2);
    expect(element.querySelector('.route-eta')).toBeNull();
    fixture.componentRef.setInput('selectedUnitId', activeUnit.id);
    await fixture.whenStable();
    expect(element.querySelector('.resource-route.is-selected')?.getAttribute('data-unit-id')).toBe(
      activeUnit.id,
    );
    expect(element.querySelector('.route-eta')?.textContent).toContain('≈ 6 min');
    expect(element.querySelector('.route-eta')?.textContent).toContain('B-03');
    expect(element.querySelectorAll('.route-destination').length).toBe(1);
    fixture.componentRef.setInput('selectedUnitId', second.id);
    await fixture.whenStable();
    expect(element.querySelector('.resource-route.is-selected')?.getAttribute('data-unit-id')).toBe(
      second.id,
    );
    expect(element.querySelectorAll('.route-eta').length).toBe(1);
    expect(element.querySelector('.route-eta')?.textContent).toContain(second.id);
    expect(calculate).toHaveBeenCalledTimes(2);
  });

  it('selects the resource when its route is clicked and hides routes with the units layer', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    const selections: string[] = [];
    fixture.componentInstance.unitSelected.subscribe((id) => selections.push(id));
    await vi.waitFor(() => expect(element.querySelector('.resource-route')).not.toBeNull());
    element
      .querySelector('.resource-route')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(selections).toEqual([activeUnit.id]);
    fixture.componentRef.setInput('selectedUnitId', activeUnit.id);
    await fixture.whenStable();
    element.querySelectorAll<HTMLButtonElement>('.map-legend button')[1].click();
    await fixture.whenStable();
    expect(element.querySelector('.resource-route')).toBeNull();
    expect(element.querySelector('.route-eta')).toBeNull();
  });

  it('removes the route and ETA when the journey finishes', async () => {
    const fixture = await setup();
    fixture.componentRef.setInput('selectedUnitId', activeUnit.id);
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(fixture.nativeElement.querySelector('.route-eta')).not.toBeNull(),
    );
    fixture.componentRef.setInput('locations', [
      { ...activeUnit, route: { ...journey, status: 'completed' } },
    ]);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.resource-route')).toBeNull();
    expect(fixture.nativeElement.querySelector('.route-eta')).toBeNull();
    expect(fixture.nativeElement.querySelector('.map-popup')?.textContent).toContain(
      'Ruta finalizada',
    );
    expect(calculate).toHaveBeenCalledTimes(1);
  });

  it('shows a missing-route state without inventing an ETA', async () => {
    calculate.mockResolvedValue(null);
    const fixture = await setup();
    fixture.componentRef.setInput('selectedUnitId', activeUnit.id);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.route-eta')).toBeNull();
    expect(fixture.nativeElement.querySelector('.map-popup')?.textContent).toContain(
      'No se ha encontrado una ruta',
    );
  });

  it('retries a failed lookup explicitly', async () => {
    calculate.mockRejectedValueOnce(new Error('offline'));
    const fixture = await setup();
    fixture.componentRef.setInput('selectedUnitId', activeUnit.id);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.map-popup')?.textContent).toContain(
      'No se ha podido calcular',
    );
    fixture.nativeElement.querySelector('.map-popup button').click();
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(fixture.nativeElement.querySelector('.route-eta')?.textContent).toContain('6 min'),
    );
    expect(calculate).toHaveBeenCalledTimes(2);
  });

  it('discards a stale route when the destination changes', async () => {
    let finish!: (route: CalculatedRoute) => void;
    calculate.mockImplementationOnce(
      () => new Promise<CalculatedRoute>((resolve) => (finish = resolve)),
    );
    const fixture = await setup();
    const newJourney: ResourceRoute = { ...journey, destination: { lat: 40.73, lng: -3.87 } };
    fixture.componentRef.setInput('locations', [{ ...activeUnit, route: newJourney }]);
    fixture.componentRef.setInput('selectedUnitId', activeUnit.id);
    await fixture.whenStable();
    finish({ ...computedRoute(activeUnit.coordinates, journey), durationSeconds: 7200 });
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(fixture.nativeElement.querySelector('.route-eta')?.textContent).toContain('6 min'),
    );
    expect(fixture.nativeElement.querySelector('.route-eta')?.textContent).not.toContain('2 h');
  });

  it('removes an open error popup when retry restores the marker ETA', async () => {
    calculate.mockRejectedValueOnce(new Error('offline'));
    const fixture = await setup();
    fixture.componentRef.setInput('selectedUnitId', activeUnit.id);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.map-popup')?.textContent).toContain('No se ha podido calcular');
    element.querySelector<HTMLButtonElement>('.map-popup button')!.click();
    await fixture.whenStable();
    await vi.waitFor(() => expect(element.querySelector('.route-eta')).not.toBeNull());
    expect(element.querySelector('.leaflet-popup')).toBeNull();
    expect(element.querySelector('.marker-label')?.textContent).toContain('≈ 6 min');
  });

  it('places the label on the route rather than at the bounding-box center', () => {
    const position = routeMidpoint([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 2 },
      { lat: 1, lng: 2 },
    ]);
    expect(position.lat).toBeCloseTo(0);
    expect(position.lng).toBeCloseTo(1.5);
  });
});

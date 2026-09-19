import { TestBed } from '@angular/core/testing';
import * as L from 'leaflet/dist/leaflet-src.esm.js';
import { vi } from 'vitest';
import { MOCK_UNITS } from '../../core/data/operations.mock';
import { Geocoding } from '../../core/services/geocoding';
import { Home } from './home';

describe('Home resource selection', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: Geocoding, useValue: { geocode: vi.fn() } }],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  async function setup() {
    const fixture = TestBed.createComponent(Home);
    await fixture.whenStable();
    return fixture;
  }

  it('focuses the resource from the feed, including another resource in the same incident', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    const panTo = vi.spyOn(L.Map.prototype, 'panTo');
    for (const [row, unitId] of [
      [0, 'B-03'],
      [2, 'H-01'],
    ] as const) {
      element.querySelectorAll<HTMLButtonElement>('.communication')[row].click();
      await fixture.whenStable();
      expect(element.querySelector('.map-marker.is-selected .marker-label')?.textContent).toBe(
        unitId,
      );
      expect(element.querySelector('.map-popup strong')?.textContent).toBe(unitId);
      expect(element.querySelectorAll('.incident-row[aria-pressed="true"]').length).toBe(0);
      expect(element.querySelectorAll('.communication[aria-pressed="true"]').length).toBe(1);
      expect(element.querySelectorAll('.communication.related').length).toBe(1);
      expect(panTo).toHaveBeenCalledWith(
        expect.objectContaining(MOCK_UNITS.find((unit) => unit.id === unitId)!.coordinates),
        { animate: false },
      );
    }
  });

  it('selects a map resource without selecting its incident', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    element.querySelector<HTMLElement>('.operation-marker[title^="BUS-04 ·"]')!.click();
    await fixture.whenStable();
    expect(element.querySelector('.map-marker.is-selected .marker-label')?.textContent).toBe(
      'BUS-04',
    );
    expect(element.querySelector('.map-popup strong')?.textContent).toBe('BUS-04');
    expect(element.querySelector('.communication[aria-pressed="true"]')?.textContent).toContain(
      'BUS-04',
    );
    expect(element.querySelectorAll('.incident-row.selected').length).toBe(0);
  });

  it('reveals the units layer when a resource is selected from the feed', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    element.querySelectorAll<HTMLButtonElement>('.map-legend button')[1].click();
    await fixture.whenStable();
    expect(element.querySelectorAll('.map-marker.kind-unit').length).toBe(0);
    element.querySelector<HTMLButtonElement>('.communication')!.click();
    await fixture.whenStable();
    expect(element.querySelector('.map-marker.is-selected .marker-label')?.textContent).toBe(
      'B-03',
    );
    expect(element.querySelector('.map-popup strong')?.textContent).toBe('B-03');
    expect(element.querySelectorAll('.map-marker.kind-unit').length).toBe(10);
  });

  it('supports resources without a communication in the feed', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    element.querySelector<HTMLElement>('.operation-marker[title^="B-07 ·"]')!.click();
    await fixture.whenStable();
    expect(element.querySelector('.map-marker.is-selected .marker-label')?.textContent).toBe(
      'B-07',
    );
    expect(element.querySelector('.map-popup strong')?.textContent).toBe('B-07');
    expect(element.querySelectorAll('.communication.related').length).toBe(0);
    expect(element.querySelectorAll('.incident-row.selected').length).toBe(0);
  });

  it('restores incident selection and associated resources after selecting a resource', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    element.querySelector<HTMLButtonElement>('.communication')!.click();
    await fixture.whenStable();
    element.querySelectorAll<HTMLButtonElement>('.incident-row')[1].click();
    await fixture.whenStable();
    expect(element.querySelector('.map-marker.is-selected .marker-label')?.textContent).toBe(
      'INC-002',
    );
    expect(element.querySelector('.map-popup strong')?.textContent).toBe('INC-002');
    expect(element.querySelectorAll('.communication[aria-pressed="true"]').length).toBe(0);
    expect(element.querySelectorAll('.communication.related').length).toBe(1);
    expect(element.querySelectorAll('.map-marker.kind-unit.is-related').length).toBe(3);
  });
});

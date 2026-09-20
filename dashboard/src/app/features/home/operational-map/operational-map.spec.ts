import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import * as L from 'leaflet/dist/leaflet-src.esm.js';
import { MOCK_UNITS } from '../../../core/data/operations.mock';
import { Coordinates } from '../../../core/models/operations';
import { Geocoding } from '../../../core/services/geocoding';
import { Routing } from '../../../core/services/routing';
import { OperationalMap } from './operational-map';

describe('OperationalMap', () => {
  const geocode = vi.fn();

  beforeEach(() => {
    geocode.mockReset();
    TestBed.configureTestingModule({
      providers: [
        { provide: Geocoding, useValue: { geocode } },
        { provide: Routing, useValue: { calculate: vi.fn().mockResolvedValue(null) } },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('fits markers only after the map layout has a measurable viewport', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const fit = vi.spyOn(L.Map.prototype, 'fitBounds');
    const fixture = TestBed.createComponent(OperationalMap);
    fixture.componentRef.setInput('locations', [MOCK_UNITS[0], MOCK_UNITS[1]]);
    await fixture.whenStable();
    expect(fit).not.toHaveBeenCalled();
    const canvas = fixture.nativeElement.querySelector('.map-canvas') as HTMLElement;
    Object.defineProperties(canvas, {
      clientWidth: { configurable: true, value: 640 },
      clientHeight: { configurable: true, value: 600 },
    });
    for (const frame of frames.splice(0)) frame(0);
    expect(fit).toHaveBeenCalled();
  });

  it('uses provided coordinates and geocodes only unique unknown addresses', async () => {
    geocode.mockResolvedValue({ lat: 40.425, lng: -3.689 });
    const fixture = TestBed.createComponent(OperationalMap);
    fixture.componentRef.setInput('locations', [MOCK_UNITS[0]]);
    fixture.componentRef.setInput('addresses', [
      MOCK_UNITS[0].address,
      'Paseo de la Castellana 12, Madrid',
      '  PASEO de la Castellana 12, Madrid ',
    ]);
    await fixture.whenStable();
    await vi.waitFor(() => expect(geocode).toHaveBeenCalledTimes(1));
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('.operation-marker').length).toBe(2);
    expect(
      fixture.nativeElement.querySelector('.map-provider, .map-sector, .map-footer'),
    ).toBeNull();
    expect(
      fixture.nativeElement.querySelector('.leaflet-control-attribution')?.textContent,
    ).toContain('OpenStreetMap');
  });

  it('toggles unit visibility and emits selections from markers', async () => {
    const fixture = TestBed.createComponent(OperationalMap);
    fixture.componentRef.setInput('locations', [MOCK_UNITS[0]]);
    const selected: string[] = [];
    const selectedIncidents: string[] = [];
    fixture.componentInstance.unitSelected.subscribe((id) => selected.push(id));
    fixture.componentInstance.incidentSelected.subscribe((id) => selectedIncidents.push(id));
    await fixture.whenStable();
    fixture.nativeElement.querySelector('.operation-marker').click();
    expect(selected).toEqual(['B-03']);
    expect(selectedIncidents).toEqual([]);
    fixture.nativeElement.querySelectorAll('.map-legend button')[1].click();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('.operation-marker').length).toBe(0);
    expect(geocode).not.toHaveBeenCalled();
    expect(
      fixture.nativeElement.querySelectorAll('.map-legend button')[1].getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('reports addresses without a match rather than displaying a guessed location', async () => {
    geocode.mockResolvedValue(null);
    const fixture = TestBed.createComponent(OperationalMap);
    fixture.componentRef.setInput('addresses', ['Dirección inexistente']);
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(fixture.nativeElement.textContent).toContain('1 dirección sin ubicar'),
    );
    expect(fixture.nativeElement.querySelectorAll('.operation-marker').length).toBe(0);
  });

  it('stops the batch on a network failure and supports an explicit retry', async () => {
    geocode.mockRejectedValueOnce(new Error('offline'));
    const fixture = TestBed.createComponent(OperationalMap);
    fixture.componentRef.setInput('addresses', ['Madrid', 'Toledo']);
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(fixture.nativeElement.textContent).toContain('2 direcciones sin ubicar'),
    );
    expect(geocode).toHaveBeenCalledTimes(1);
    geocode.mockResolvedValue({ lat: 40.4, lng: -3.7 });
    fixture.nativeElement.querySelector('.warning button').click();
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(fixture.nativeElement.querySelectorAll('.operation-marker').length).toBe(2),
    );
    expect(fixture.nativeElement.querySelector('.warning')).toBeNull();
  });

  it('ignores stale geocoding results after inputs change', async () => {
    let finishOldRequest!: (value: Coordinates) => void;
    geocode.mockImplementationOnce(
      () => new Promise<Coordinates>((resolve) => (finishOldRequest = resolve)),
    );
    geocode.mockResolvedValue({ lat: 40.4, lng: -3.7 });
    const fixture = TestBed.createComponent(OperationalMap);
    fixture.componentRef.setInput('addresses', ['Dirección anterior']);
    await fixture.whenStable();
    fixture.componentRef.setInput('addresses', ['Dirección nueva']);
    await fixture.whenStable();
    finishOldRequest({ lat: 41, lng: -4 });
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(fixture.nativeElement.querySelector('.marker-label')?.textContent).toBe(
        'Dirección nueva',
      ),
    );
    expect(fixture.nativeElement.querySelectorAll('.operation-marker').length).toBe(1);
  });

  it('treats address labels as text, not HTML', async () => {
    geocode.mockResolvedValue({ lat: 40.4, lng: -3.7 });
    const fixture = TestBed.createComponent(OperationalMap);
    fixture.componentRef.setInput('addresses', ['<img src=x onerror=alert(1)>']);
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(fixture.nativeElement.querySelector('.marker-label')?.textContent).toContain('<img'),
    );
    expect(fixture.nativeElement.querySelector('.marker-label img')).toBeNull();
  });
});

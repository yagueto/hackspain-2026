import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { GEOCODING_ENDPOINT, Geocoding, normalizeAddress } from './geocoding';

describe('Geocoding', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    sessionStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({
      providers: [{ provide: GEOCODING_ENDPOINT, useValue: 'https://example.test/search' }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const response = (results: unknown) => ({ ok: true, json: async () => results });

  it('normalizes whitespace and case without changing address accents', () => {
    expect(normalizeAddress('  Calle  de Alcalá, Madrid ')).toBe('calle de alcalá, madrid');
  });

  it('geocodes addresses and caches equivalent requests', async () => {
    fetchMock.mockResolvedValue(response([{ lat: '40.425', lon: '-3.689' }]));
    const service = TestBed.inject(Geocoding);
    const expected = { lat: 40.425, lng: -3.689 };
    expect(await service.geocode('Paseo de la Castellana 12, Madrid')).toEqual(expected);
    expect(await service.geocode('  PASEO de la Castellana 12, Madrid ')).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0].searchParams.get('q')).toBe(
      'Paseo de la Castellana 12, Madrid',
    );
    expect(fetchMock.mock.calls[0][0].searchParams.get('limit')).toBe('1');
    expect(sessionStorage.getItem('operations.geocoding.v1')).toContain('40.425');
  });

  it('serializes requests at least 1100 ms apart', async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    fetchMock.mockImplementation(async () => {
      starts.push(Date.now());
      return response([{ lat: '40.4', lon: '-3.7' }]);
    });
    const service = TestBed.inject(Geocoding);
    const requests = Promise.all([service.geocode('Madrid'), service.geocode('Toledo')]);
    await vi.advanceTimersByTimeAsync(1100);
    await requests;
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1100);
  });

  it('returns and caches missing results without inventing coordinates', async () => {
    fetchMock.mockResolvedValue(response([]));
    const service = TestBed.inject(Geocoding);
    expect(await service.geocode('Dirección inexistente')).toBeNull();
    expect(await service.geocode('Dirección inexistente')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await service.geocode('  ')).toBeNull();
  });

  it('rejects invalid coordinates', async () => {
    fetchMock.mockResolvedValue(response([{ lat: '200', lon: '-3.7' }]));
    await expect(TestBed.inject(Geocoding).geocode('Madrid')).rejects.toThrow('fuera de rango');
  });

  it('does not fetch cancelled requests', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(TestBed.inject(Geocoding).geocode('Madrid', controller.signal)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recovers the queue after network failures', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(response([{ lat: '40.4', lon: '-3.7' }]));
    const service = TestBed.inject(Geocoding);
    await expect(service.geocode('Madrid')).rejects.toThrow('offline');
    const retry = service.geocode('Madrid');
    await vi.advanceTimersByTimeAsync(1100);
    expect(await retry).toEqual({ lat: 40.4, lng: -3.7 });
  });

  it('restores valid cached coordinates after a page reload', async () => {
    sessionStorage.setItem(
      'operations.geocoding.v1',
      JSON.stringify([
        ['madrid', { coordinates: { lat: 40.4, lng: -3.7 }, expiresAt: Date.now() + 60000 }],
      ]),
    );
    expect(await TestBed.inject(Geocoding).geocode('Madrid')).toEqual({ lat: 40.4, lng: -3.7 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { ResourceRoute } from '../models/operations';
import { formatRouteDuration, ROUTING_ENDPOINT, Routing } from './routing';

describe('Routing', () => {
  const fetchMock = vi.fn();
  const origin = { lat: 40.72, lng: -3.88 };
  const journey: ResourceRoute = { status: 'active', destination: { lat: 40.75, lng: -3.89 } };
  const result = {
    code: 'Ok',
    routes: [
      {
        duration: 336.8,
        distance: 2695.1,
        geometry: {
          type: 'LineString',
          coordinates: [
            [-3.88, 40.72],
            [-3.885, 40.73],
            [-3.89, 40.75],
          ],
        },
      },
    ],
  };
  const response = (data: unknown, ok = true) => ({ ok, json: async () => data });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({
      providers: [{ provide: ROUTING_ENDPOINT, useValue: 'https://example.test/route/v1/driving' }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('requests road geometry in longitude/latitude order and caches repeated routes', async () => {
    fetchMock.mockResolvedValue(response(result));
    const service = TestBed.inject(Routing);
    const route = await service.calculate(origin, journey);
    expect(route?.durationSeconds).toBe(336.8);
    expect(route?.distanceMeters).toBe(2695.1);
    expect(route?.path[0]).toEqual(origin);
    expect(fetchMock.mock.calls[0][0].pathname).toContain('-3.88,40.72;-3.89,40.75');
    expect(fetchMock.mock.calls[0][0].searchParams.get('radiuses')).toBe('250;250');
    expect(await service.calculate(origin, journey)).toEqual(route);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('includes intermediate points in the requested route', async () => {
    fetchMock.mockResolvedValue(response(result));
    await TestBed.inject(Routing).calculate(origin, {
      ...journey,
      via: [{ lat: 40.73, lng: -3.885 }],
    });
    expect(fetchMock.mock.calls[0][0].pathname).toContain('-3.88,40.72;-3.885,40.73;-3.89,40.75');
  });

  it('does not request a completed route', async () => {
    expect(
      await TestBed.inject(Routing).calculate(origin, { ...journey, status: 'completed' }),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['NoRoute', 'NoSegment'])('handles %s without fabricating a route', async (code) => {
    fetchMock.mockResolvedValue(response({ code }, false));
    expect(await TestBed.inject(Routing).calculate(origin, journey)).toBeNull();
  });

  it('rejects invalid coordinates before sending requests', async () => {
    await expect(TestBed.inject(Routing).calculate({ lat: 200, lng: 0 }, journey)).rejects.toThrow(
      'puntos',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed geometry and negative travel times', async () => {
    fetchMock.mockResolvedValue(
      response({
        code: 'Ok',
        routes: [
          {
            duration: -1,
            distance: 1,
            geometry: {
              type: 'LineString',
              coordinates: [
                [-3, 40],
                [-4, 41],
              ],
            },
          },
        ],
      }),
    );
    await expect(TestBed.inject(Routing).calculate(origin, journey)).rejects.toThrow('respuesta');
  });

  it('serializes network calls with at least 1100 ms between starts', async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    fetchMock.mockImplementation(async () => {
      starts.push(Date.now());
      return response(result);
    });
    const service = TestBed.inject(Routing);
    const requests = Promise.all([
      service.calculate(origin, journey),
      service.calculate({ lat: 40.71, lng: -3.88 }, journey),
    ]);
    await vi.advanceTimersByTimeAsync(1100);
    await requests;
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1100);
  });

  it('cancels queued requests without sending them', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      TestBed.inject(Routing).calculate(origin, journey, controller.signal),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recovers after a network failure', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response(result));
    const service = TestBed.inject(Routing);
    await expect(service.calculate(origin, journey)).rejects.toThrow('offline');
    const retry = service.calculate(origin, journey);
    await vi.advanceTimersByTimeAsync(1100);
    expect((await retry)?.durationSeconds).toBe(336.8);
  });

  it('formats approximate durations in minutes and hours', () => {
    expect(formatRouteDuration(0)).toBe('1 min');
    expect(formatRouteDuration(336.8)).toBe('6 min');
    expect(formatRouteDuration(3600)).toBe('1 h');
    expect(formatRouteDuration(3900)).toBe('1 h 5 min');
  });
});

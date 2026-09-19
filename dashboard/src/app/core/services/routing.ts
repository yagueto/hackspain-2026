import { DOCUMENT, inject, Injectable, InjectionToken } from '@angular/core';
import { CalculatedRoute, Coordinates, ResourceRoute } from '../models/operations';

export const ROUTING_ENDPOINT = new InjectionToken<string>('ROUTING_ENDPOINT', {
  providedIn: 'root',
  factory: () =>
    inject(DOCUMENT).querySelector<HTMLMetaElement>('meta[name="routing-endpoint"]')?.content ??
    'https://router.project-osrm.org/route/v1/driving',
});

export function formatRouteDuration(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const remainder = minutes % 60;
  return `${Math.floor(minutes / 60)} h${remainder ? ` ${remainder} min` : ''}`;
}

@Injectable({ providedIn: 'root' })
export class Routing {
  private readonly endpoint = inject(ROUTING_ENDPOINT);
  private readonly cache = new Map<string, { route: CalculatedRoute | null; expiresAt: number }>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  calculate(
    origin: Coordinates,
    journey: ResourceRoute,
    signal?: AbortSignal,
  ): Promise<CalculatedRoute | null> {
    if (journey.status !== 'active') return Promise.resolve(null);
    const points = [origin, ...(journey.via ?? []), journey.destination];
    if (
      points.length > 25 ||
      points.some(
        (point) =>
          !point ||
          !Number.isFinite(point.lat) ||
          !Number.isFinite(point.lng) ||
          Math.abs(point.lat) > 90 ||
          Math.abs(point.lng) > 180,
      )
    ) {
      return Promise.reject(new Error('Los puntos de la ruta no son válidos.'));
    }
    const key = points.map((point) => `${point.lng},${point.lat}`).join(';');
    const request = this.queue.then(async () => {
      signal?.throwIfAborted();
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.route;
      const delay = Math.max(0, 1100 - (Date.now() - this.lastRequestAt));
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      signal?.throwIfAborted();
      this.lastRequestAt = Date.now();
      const url = new URL(`${this.endpoint.replace(/\/$/, '')}/${key}`, document.baseURI);
      url.search = new URLSearchParams({
        overview: 'full',
        geometries: 'geojson',
        steps: 'false',
        radiuses: points.map(() => '250').join(';'),
      }).toString();
      const timeout = AbortSignal.timeout(12000);
      const response = await fetch(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Accept: 'application/json' },
      });
      const data = (await response.json()) as {
        code?: string;
        routes?: {
          duration?: number;
          distance?: number;
          geometry?: { type?: string; coordinates?: unknown };
        }[];
      } | null;
      if (data?.code === 'NoRoute' || data?.code === 'NoSegment') {
        this.remember(key, null);
        return null;
      }
      if (!response.ok || data?.code !== 'Ok') throw new Error('No se pudo calcular la ruta.');
      const first = Array.isArray(data.routes) ? data.routes[0] : undefined;
      const geometry = first?.geometry?.coordinates;
      if (
        !Number.isFinite(first?.duration) ||
        first!.duration! < 0 ||
        !Number.isFinite(first?.distance) ||
        first!.distance! < 0 ||
        first?.geometry?.type !== 'LineString' ||
        !Array.isArray(geometry) ||
        geometry.length < 2 ||
        geometry.some(
          (point) =>
            !Array.isArray(point) ||
            point.length < 2 ||
            !Number.isFinite(point[0]) ||
            !Number.isFinite(point[1]) ||
            Math.abs(point[0]) > 180 ||
            Math.abs(point[1]) > 90,
        )
      ) {
        throw new Error('La respuesta del servicio de rutas no es válida.');
      }
      const route: CalculatedRoute = {
        path: geometry.map((point) => ({ lng: point[0], lat: point[1] })),
        durationSeconds: first!.duration!,
        distanceMeters: first!.distance!,
      };
      this.remember(key, route);
      return route;
    });
    this.queue = request.catch(() => undefined);
    return request;
  }

  private remember(key: string, route: CalculatedRoute | null): void {
    this.cache.set(key, { route, expiresAt: Date.now() + 300000 });
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
  }
}

import { DOCUMENT, inject, Injectable, InjectionToken } from '@angular/core';
import { Coordinates } from '../models/operations';

export const GEOCODING_ENDPOINT = new InjectionToken<string>('GEOCODING_ENDPOINT', {
  providedIn: 'root',
  factory: () =>
    inject(DOCUMENT).querySelector<HTMLMetaElement>('meta[name="geocoding-endpoint"]')?.content ??
    'https://nominatim.openstreetmap.org/search',
});

interface CachedLocation {
  coordinates: Coordinates | null;
  expiresAt: number;
}

export function normalizeAddress(address: string): string {
  return address.trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
}

@Injectable({ providedIn: 'root' })
export class Geocoding {
  private readonly endpoint = inject(GEOCODING_ENDPOINT);
  private readonly storageKey = 'operations.geocoding.v1';
  private readonly cache = new Map<string, CachedLocation>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor() {
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(this.storageKey) ?? '[]');
      if (Array.isArray(stored)) {
        for (const entry of stored.slice(-200)) {
          if (
            Array.isArray(entry) &&
            typeof entry[0] === 'string' &&
            entry[1]?.expiresAt > Date.now() &&
            (entry[1].coordinates === null || this.validCoordinates(entry[1].coordinates))
          ) {
            this.cache.set(entry[0], entry[1]);
          }
        }
      }
    } catch {
      this.cache.clear();
    }
  }

  geocode(address: string, signal?: AbortSignal): Promise<Coordinates | null> {
    const key = normalizeAddress(address);
    if (!key) return Promise.resolve(null);
    const request = this.queue.then(async () => {
      signal?.throwIfAborted();
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.coordinates;
      const delay = Math.max(0, 1100 - (Date.now() - this.lastRequestAt));
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      signal?.throwIfAborted();
      this.lastRequestAt = Date.now();
      const url = new URL(this.endpoint, document.baseURI);
      url.search = new URLSearchParams({
        q: address.trim(),
        format: 'jsonv2',
        limit: '1',
        'accept-language': 'es',
      }).toString();
      const timeout = AbortSignal.timeout(10000);
      const response = await fetch(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok)
        throw new Error(`No se pudo consultar el geocodificador (${response.status}).`);
      const results: unknown = await response.json();
      if (!Array.isArray(results)) throw new Error('Respuesta de geocodificación no válida.');
      let coordinates: Coordinates | null = null;
      if (results.length) {
        const first = results[0];
        if (
          typeof first?.lat !== 'string' ||
          !first.lat.trim() ||
          typeof first?.lon !== 'string' ||
          !first.lon.trim()
        ) {
          throw new Error('Coordenadas de geocodificación no válidas.');
        }
        coordinates = { lat: Number(first.lat), lng: Number(first.lon) };
        if (!this.validCoordinates(coordinates)) throw new Error('Coordenadas fuera de rango.');
      }
      this.cache.set(key, {
        coordinates,
        expiresAt: Date.now() + (coordinates ? 86400000 : 3600000),
      });
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
      this.persistCache();
      return coordinates;
    });
    this.queue = request.catch(() => undefined);
    return request;
  }

  private validCoordinates(value: Coordinates | undefined): boolean {
    return (
      !!value &&
      Number.isFinite(value.lat) &&
      Number.isFinite(value.lng) &&
      Math.abs(value.lat) <= 90 &&
      Math.abs(value.lng) <= 180
    );
  }

  private persistCache(): void {
    try {
      sessionStorage.setItem(this.storageKey, JSON.stringify([...this.cache]));
    } catch {
      return;
    }
  }
}

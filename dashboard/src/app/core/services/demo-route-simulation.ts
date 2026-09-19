import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { Coordinates, MapLocation, RouteNavigation } from '../models/operations';
import { advanceRoute, prepareRoute, RoutePlan } from './route-progress';
import { Routing } from './routing';

interface DemoFrame {
  key: string;
  position: Coordinates;
  completed: boolean;
  navigation: RouteNavigation;
}

@Injectable({ providedIn: 'root' })
export class DemoRouteSimulation {
  private readonly routing = inject(Routing);
  private readonly destroyRef = inject(DestroyRef);
  private readonly frames = signal<ReadonlyMap<string, DemoFrame>>(new Map());
  private readonly sources = new Map<string, MapLocation>();
  private readonly journeys = new Map<string, { plan: RoutePlan; startedAt: number }>();
  private readonly controller = new AbortController();
  private started = false;

  start(locations: readonly MapLocation[]): void {
    if (this.started) return;
    this.started = true;
    for (const location of locations) {
      if (location.kind !== 'unit' || location.route?.status !== 'active') continue;
      this.sources.set(location.id, location);
      void this.load(location);
    }
    const timer = setInterval(() => this.advance(), 200);
    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
      this.controller.abort();
    });
  }

  isManaged(location: MapLocation): boolean {
    return this.frames().get(location.id)?.key === this.key(location);
  }

  project(location: MapLocation): MapLocation {
    const frame = this.frames().get(location.id);
    if (!frame || location.route?.status !== 'active' || frame.key !== this.key(location))
      return location;
    return {
      ...location,
      coordinates: frame.position,
      address: frame.completed
        ? (location.route.destinationLabel ?? 'Destino alcanzado')
        : `En ruta hacia ${location.route.destinationLabel ?? 'el destino asignado'}`,
      route: {
        ...location.route,
        status: frame.completed ? 'completed' : 'active',
        navigation: frame.completed ? undefined : frame.navigation,
      },
    };
  }

  retry(id: string): void {
    const source = this.sources.get(id);
    if (source && this.frames().get(id)?.navigation.status === 'error') void this.load(source);
  }

  private key(location: MapLocation): string {
    const route = location.route;
    return JSON.stringify([
      location.kind,
      location.coordinates,
      route?.status,
      route?.destination,
      route?.via,
    ]);
  }

  private async load(location: MapLocation): Promise<void> {
    const frame: DemoFrame = {
      key: this.key(location),
      position: location.coordinates,
      completed: false,
      navigation: { status: 'loading' },
    };
    this.frames.update((frames) => new Map(frames).set(location.id, frame));
    try {
      const route = await this.routing.calculate(
        location.coordinates,
        location.route!,
        this.controller.signal,
      );
      if (this.controller.signal.aborted) return;
      if (route) {
        this.journeys.set(location.id, { plan: prepareRoute(route), startedAt: performance.now() });
        this.frames.update((frames) =>
          new Map(frames).set(location.id, {
            ...frame,
            position: route.path[0],
            navigation: { status: 'ready', route },
          }),
        );
      } else {
        this.frames.update((frames) =>
          new Map(frames).set(location.id, { ...frame, navigation: { status: 'unavailable' } }),
        );
      }
    } catch {
      if (!this.controller.signal.aborted) {
        this.frames.update((frames) =>
          new Map(frames).set(location.id, { ...frame, navigation: { status: 'error' } }),
        );
      }
    }
  }

  private advance(): void {
    if (!this.journeys.size) return;
    const now = performance.now();
    const frames = new Map(this.frames());
    for (const [id, journey] of this.journeys) {
      const progress = advanceRoute(journey.plan, ((now - journey.startedAt) / 1000) * 10);
      frames.set(id, {
        ...frames.get(id)!,
        position: progress.position,
        completed: progress.completed,
        navigation: { status: 'ready', route: progress.remaining },
      });
      if (progress.completed) this.journeys.delete(id);
    }
    this.frames.set(frames);
  }
}

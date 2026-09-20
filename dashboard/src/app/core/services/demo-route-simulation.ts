import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { OperationLogEvent } from '../models/operation-log';
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
  private readonly arrivalEvents = new Subject<OperationLogEvent>();
  readonly arrivals$ = this.arrivalEvents.asObservable();
  private readonly journeyStartEvents = new Subject<MapLocation>();
  readonly journeyStarts$ = this.journeyStartEvents.asObservable();

  start(locations: readonly MapLocation[]): void {
    const active = new Map(
      locations
        .filter((location) => location.kind === 'unit' && location.route?.status === 'active')
        .map((location) => [location.id, location]),
    );
    for (const [id, source] of this.sources) {
      const next = active.get(id);
      if (next && this.key(next) === this.key(source)) continue;
      this.sources.delete(id);
      this.journeys.delete(id);
      this.frames.update((frames) => {
        const nextFrames = new Map(frames);
        nextFrames.delete(id);
        return nextFrames;
      });
    }
    for (const location of active.values()) {
      if (this.sources.has(location.id)) continue;
      this.sources.set(location.id, location);
      void this.load(location);
    }
    if (this.started) return;
    this.started = true;
    const timer = setInterval(() => this.advance(), 200);
    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
      this.controller.abort();
      this.arrivalEvents.complete();
      this.journeyStartEvents.complete();
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
      location.incidentId,
      route?.destinationLabel,
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
      if (this.controller.signal.aborted || this.sources.get(location.id) !== location) return;
      if (route) {
        this.journeys.set(location.id, { plan: prepareRoute(route), startedAt: performance.now() });
        this.frames.update((frames) =>
          new Map(frames).set(location.id, {
            ...frame,
            position: route.path[0],
            navigation: { status: 'ready', route },
          }),
        );
        this.journeyStartEvents.next(location);
      } else {
        this.frames.update((frames) =>
          new Map(frames).set(location.id, { ...frame, navigation: { status: 'unavailable' } }),
        );
      }
    } catch {
      if (!this.controller.signal.aborted && this.sources.get(location.id) === location) {
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
      if (progress.completed) {
        this.journeys.delete(id);
        const unit = this.sources.get(id);
        this.frames.set(new Map(frames));
        if (unit?.incidentId)
          this.arrivalEvents.next({
            id: `arrival:${id}`,
            incidentId: unit.incidentId,
            occurredAt: new Date().toISOString(),
            kind: 'arrival',
            title: 'Recurso en destino',
            description: `${id} ha llegado a ${unit.route?.destinationLabel ?? 'su destino'}.`,
            source: 'Seguimiento de recursos',
          });
      }
    }
    this.frames.set(frames);
  }
}

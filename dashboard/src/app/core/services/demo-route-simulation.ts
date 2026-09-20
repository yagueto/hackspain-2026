import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { OperationLogEvent } from '../models/operation-log';
import { Coordinates, MapLocation, RouteNavigation } from '../models/operations';
import { advanceRoute, prepareRoute, RoutePlan } from './route-progress';

interface DemoFrame {
  key: string;
  position: Coordinates;
  completed: boolean;
  navigation: RouteNavigation;
}

/**
 * Coloca cada unidad sobre su ruta de carretera según el avance que publica el backend.
 *
 * No inventa el movimiento: la salida (`travelStartedAt`) y la duración (`travelMinutes`) las
 * decide el backend, y esto solo interpola entre sus muestras para que el marcador no vaya a
 * saltos. La posición resultante es una estimación, nunca GPS, y un parte de campo la corrige
 * porque reinicia esos dos valores en el origen.
 */
@Injectable({ providedIn: 'root' })
export class DemoRouteSimulation {
  private readonly destroyRef = inject(DestroyRef);
  private readonly frames = signal<ReadonlyMap<string, DemoFrame>>(new Map());
  private readonly sources = new Map<string, MapLocation>();
  private readonly journeys = new Map<string, { plan: RoutePlan }>();
  /** Reloj compartido del avance: hace recalcular la posición mostrada entre muestras. */
  private readonly tick = signal(Date.now());
  private timer?: ReturnType<typeof setInterval>;
  private readonly arrivalEvents = new Subject<OperationLogEvent>();
  readonly arrivals$ = this.arrivalEvents.asObservable();

  /**
   * Se llama en cada actualización, así que engancha también a las unidades que aceptan la
   * llamada más tarde. No descarga rutas: reutiliza la que ya trajo el mapa, para no pedir
   * dos veces lo mismo al proveedor público.
   */
  sync(locations: readonly MapLocation[], routes: ReadonlyMap<string, RouteNavigation>): void {
    const active = new Set<string>();
    for (const location of locations) {
      if (location.kind !== 'unit' || location.route?.status !== 'active') continue;
      active.add(location.id);
      const previous = this.sources.get(location.id);
      this.sources.set(location.id, location);
      const navigation = routes.get(location.id) ?? location.route.navigation;
      const key = this.key(location);
      if (navigation?.status !== 'ready') {
        this.journeys.delete(location.id);
        continue;
      }
      if (previous && this.key(previous) === key && this.journeys.has(location.id)) continue;
      this.journeys.set(location.id, { plan: prepareRoute(navigation.route) });
      this.frames.update((frames) =>
        new Map(frames).set(location.id, {
          key,
          position: navigation.route.path[0] ?? location.coordinates,
          completed: false,
          navigation,
        }),
      );
    }
    for (const id of [...this.sources.keys()]) {
      if (active.has(id)) continue;
      this.sources.delete(id);
      this.journeys.delete(id);
      this.frames.update((frames) => {
        const next = new Map(frames);
        next.delete(id);
        return next;
      });
    }
    this.timer ??= setInterval(() => {
      this.tick.set(Date.now());
      this.advance();
    }, 500);
    this.destroyRef.onDestroy(() => this.stop());
  }

  private stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.arrivalEvents.complete();
  }

  isManaged(location: MapLocation): boolean {
    return this.frames().get(location.id)?.key === this.key(location);
  }

  project(location: MapLocation): MapLocation {
    const frame = this.frames().get(location.id);
    if (!frame || location.route?.status !== 'active' || frame.key !== this.key(location))
      // Sin ruta por carretera (p. ej. un aviso ciudadano) el avance se interpola en recta
      // con los mismos datos del backend, en vez de quedarse clavado entre sus muestras.
      return this.projectWithoutRoute(location);
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

  private projectWithoutRoute(location: MapLocation): MapLocation {
    const { travelFrom, travelTo } = location;
    if (location.kind !== 'unit' || !travelFrom || !travelTo) return location;
    const fraction = this.fraction(location, this.tick());
    if (fraction === null) return location;
    return {
      ...location,
      coordinates: {
        lat: travelFrom.lat + (travelTo.lat - travelFrom.lat) * fraction,
        lng: travelFrom.lng + (travelTo.lng - travelFrom.lng) * fraction,
      },
    };
  }

  private key(location: MapLocation): string {
    const route = location.route;
    // La posición no entra en la clave: cambia en cada muestra y recalcular la ruta a cada
    // paso dispararía el proveedor público sin necesidad. El origen del trayecto sí.
    return JSON.stringify([
      location.kind,
      location.travelStartedAt ?? location.coordinates,
      route?.status,
      route?.destination,
      route?.via,
    ]);
  }

  /** Fracción del trayecto según el backend; sin datos de salida, no hay avance que mostrar. */
  private fraction(location: MapLocation, at: number): number | null {
    const started = location.travelStartedAt ? Date.parse(location.travelStartedAt) : NaN;
    const minutes = location.travelMinutes ?? 0;
    if (!Number.isFinite(started) || minutes <= 0) return null;
    return Math.min(1, Math.max(0, (at - started) / (minutes * 60_000)));
  }

  private advance(): void {
    if (!this.journeys.size) return;
    const at = this.tick();
    const frames = new Map(this.frames());
    let changed = false;
    for (const [id, journey] of this.journeys) {
      const unit = this.sources.get(id);
      const fraction = unit ? this.fraction(unit, at) : null;
      if (fraction === null) continue;
      const progress = advanceRoute(journey.plan, fraction * journey.plan.route.durationSeconds);
      const previous = frames.get(id);
      if (!previous) continue;
      changed = true;
      frames.set(id, {
        ...previous,
        position: progress.position,
        completed: progress.completed,
        navigation: { status: 'ready', route: progress.remaining },
      });
      if (progress.completed) {
        this.journeys.delete(id);
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
    if (changed) this.frames.set(frames);
  }
}

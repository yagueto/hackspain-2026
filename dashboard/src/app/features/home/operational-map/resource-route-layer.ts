import * as L from 'leaflet/dist/leaflet-src.esm.js';
import {
  CalculatedRoute,
  Coordinates,
  MapLocation,
  RouteNavigation,
} from '../../../core/models/operations';

export type ResourceRouteState = RouteNavigation;

export function routeMidpoint(path: readonly Coordinates[]): L.LatLng {
  const points = path.map((point) => L.latLng(point.lat, point.lng));
  const lengths = points.slice(1).map((point, index) => points[index].distanceTo(point));
  let remaining = lengths.reduce((sum, length) => sum + length, 0) / 2;
  for (const [index, length] of lengths.entries()) {
    if (remaining <= length && length > 0) {
      const ratio = remaining / length;
      return L.latLng(
        points[index].lat + (points[index + 1].lat - points[index].lat) * ratio,
        points[index].lng + (points[index + 1].lng - points[index].lng) * ratio,
      );
    }
    remaining -= length;
  }
  return points[0];
}

export class ResourceRouteLayer {
  private readonly layer: L.LayerGroup;
  private readonly shapes = new Map<
    string,
    { outline: L.Polyline; line: L.Polyline; route?: CalculatedRoute; selected?: boolean }
  >();
  private destination?: L.Marker;
  private focusedJourney: string | null = null;

  constructor(
    private readonly map: L.Map,
    private readonly selectUnit: (id: string) => void,
  ) {
    this.layer = L.layerGroup().addTo(map);
  }

  render(
    locations: readonly MapLocation[],
    states: ReadonlyMap<string, ResourceRouteState>,
    selectedId: string | null,
    visible: boolean,
  ): void {
    const active = visible
      ? locations.filter(
          (location) =>
            location.kind === 'unit' &&
            location.route?.status === 'active' &&
            states.get(location.id)?.status === 'ready',
        )
      : [];
    const ids = new Set(active.map((location) => location.id));
    for (const [id, shape] of this.shapes) {
      if (ids.has(id)) continue;
      this.layer.removeLayer(shape.outline);
      this.layer.removeLayer(shape.line);
      this.shapes.delete(id);
    }
    let selectedRoute: CalculatedRoute | undefined;
    let selectedLocation: MapLocation | undefined;
    for (const location of active) {
      const state = states.get(location.id);
      if (state?.status !== 'ready') continue;
      const selected = location.id === selectedId;
      let shape = this.shapes.get(location.id);
      if (!shape) {
        const outline = L.polyline([], { interactive: false, opacity: 0.75 }).addTo(this.layer);
        const line = L.polyline([], {
          className: 'resource-route',
          bubblingMouseEvents: false,
        }).addTo(this.layer);
        line.getElement()?.setAttribute('data-unit-id', location.id);
        line.on('click', () => this.selectUnit(location.id));
        shape = { outline, line };
        this.shapes.set(location.id, shape);
      }
      if (shape.route !== state.route) {
        const points = state.route.path.map((point) => L.latLng(point.lat, point.lng));
        shape.outline.setLatLngs(points);
        shape.line.setLatLngs(points);
        shape.route = state.route;
      }
      if (shape.selected !== selected) {
        shape.outline.setStyle({
          color: 'var(--panel)',
          weight: selected ? 8 : 5,
        });
        shape.line.setStyle({
          color: selected ? 'var(--en-route)' : 'var(--icon)',
          weight: selected ? 5 : 3,
          opacity: selected ? 1 : 0.65,
        });
        shape.line.getElement()?.classList.toggle('is-selected', selected);
        shape.selected = selected;
      }
      if (selected) {
        selectedRoute = state.route;
        selectedLocation = location;
      }
    }
    if (!selectedRoute || !selectedLocation) {
      if (this.destination) this.layer.removeLayer(this.destination);
      this.destination = undefined;
      this.focusedJourney = null;
      return;
    }
    const shape = this.shapes.get(selectedLocation.id)!;
    shape.outline.bringToFront();
    shape.line.bringToFront();
    const end = selectedRoute.path[selectedRoute.path.length - 1];
    if (!this.destination) {
      const dot = document.createElement('span');
      dot.className = 'route-destination-dot';
      this.destination = L.marker([end.lat, end.lng], {
        icon: L.divIcon({
          html: dot,
          className: 'route-destination',
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        }),
        keyboard: false,
        interactive: false,
      }).addTo(this.layer);
    } else {
      this.destination.setLatLng([end.lat, end.lng]);
    }
    this.destination
      .getElement()
      ?.setAttribute('title', selectedLocation.route?.destinationLabel ?? 'Destino');
    const journey = JSON.stringify([
      selectedLocation.id,
      selectedLocation.route?.destination,
      selectedLocation.route?.via,
    ]);
    if (journey !== this.focusedJourney) {
      this.map.flyToBounds(
        L.latLngBounds(selectedRoute.path.map((point) => [point.lat, point.lng])),
        {
          paddingTopLeft: [75, 100],
          paddingBottomRight: [75, 65],
          maxZoom: 15,
          animate: !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
          duration: 0.65,
        },
      );
      this.focusedJourney = journey;
    }
  }

  remove(): void {
    this.layer.remove();
  }
}

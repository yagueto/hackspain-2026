import * as L from 'leaflet/dist/leaflet-src.esm.js';
import { CalculatedRoute, Coordinates, MapLocation } from '../../../core/models/operations';
import { formatRouteDuration } from '../../../core/services/routing';

export type ResourceRouteState =
  { status: 'loading' | 'unavailable' | 'error' } | { status: 'ready'; route: CalculatedRoute };

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
  private focusedRoute?: CalculatedRoute;
  private focusedUnit?: string;

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
    this.layer.clearLayers();
    let selectedRoute: CalculatedRoute | undefined;
    if (visible) {
      const ordered = [...locations].sort(
        (a, b) => Number(a.id === selectedId) - Number(b.id === selectedId),
      );
      for (const location of ordered) {
        const state = states.get(location.id);
        if (
          location.kind !== 'unit' ||
          location.route?.status !== 'active' ||
          state?.status !== 'ready'
        )
          continue;
        const selected = location.id === selectedId;
        const points = state.route.path.map((point) => L.latLng(point.lat, point.lng));
        L.polyline(points, {
          color: selected ? '#07447a' : '#25333e',
          weight: selected ? 8 : 5,
          opacity: 0.75,
          interactive: false,
        }).addTo(this.layer);
        const line = L.polyline(points, {
          className: `resource-route${selected ? ' is-selected' : ''}`,
          color: selected ? '#169bff' : '#8ca9ba',
          weight: selected ? 5 : 3,
          opacity: selected ? 1 : 0.65,
          bubblingMouseEvents: false,
        }).addTo(this.layer);
        line.getElement()?.setAttribute('data-unit-id', location.id);
        line.on('click', () => this.selectUnit(location.id));
        if (!selected) continue;
        selectedRoute = state.route;
        const destination = document.createElement('span');
        destination.className = 'route-destination-dot';
        L.marker(points[points.length - 1], {
          icon: L.divIcon({
            html: destination,
            className: 'route-destination',
            iconSize: [16, 16],
            iconAnchor: [8, 8],
          }),
          title: location.route.destinationLabel ?? 'Destino',
          keyboard: false,
          interactive: false,
        }).addTo(this.layer);
        const label = document.createElement('div');
        label.className = 'route-eta-content';
        label.title = 'Tiempo aproximado por carretera, sin tráfico en tiempo real';
        const time = document.createElement('strong');
        time.textContent = `≈ ${formatRouteDuration(state.route.durationSeconds)}`;
        const details = document.createElement('span');
        const distance =
          state.route.distanceMeters >= 1000
            ? `${(state.route.distanceMeters / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} km`
            : `${Math.round(state.route.distanceMeters)} m`;
        details.textContent = `${location.label} · ${distance}`;
        label.append(time, details);
        L.tooltip({
          permanent: true,
          direction: 'top',
          offset: [0, -8],
          className: 'route-eta',
          opacity: 1,
        })
          .setLatLng(routeMidpoint(state.route.path))
          .setContent(label)
          .addTo(this.layer);
      }
    }
    if (selectedRoute && (selectedRoute !== this.focusedRoute || selectedId !== this.focusedUnit)) {
      this.map.fitBounds(
        L.latLngBounds(selectedRoute.path.map((point) => [point.lat, point.lng])),
        { paddingTopLeft: [75, 100], paddingBottomRight: [75, 65], maxZoom: 15, animate: false },
      );
    }
    this.focusedRoute = selectedRoute;
    this.focusedUnit = selectedId ?? undefined;
  }

  remove(): void {
    this.layer.remove();
  }
}

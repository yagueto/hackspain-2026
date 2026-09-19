import * as L from 'leaflet/dist/leaflet-src.esm.js';
import { MapLocation, RouteNavigation } from '../../../core/models/operations';
import { formatRouteDuration } from '../../../core/services/routing';

export function groupMarkers(map: L.Map, locations: readonly MapLocation[]): MapLocation[][] {
  const points = new Map(
    locations.map((location) => [
      location.id,
      map.latLngToLayerPoint([location.coordinates.lat, location.coordinates.lng]),
    ]),
  );
  const remaining = new Set(locations);
  const groups: MapLocation[][] = [];
  for (const location of locations) {
    if (!remaining.delete(location)) continue;
    const group = [location];
    for (const member of group) {
      for (const other of remaining) {
        const radius =
          (member.kind === 'incident' ? 23 : 17) + (other.kind === 'incident' ? 23 : 17);
        if (points.get(member.id)!.distanceTo(points.get(other.id)!) > radius) continue;
        remaining.delete(other);
        group.push(other);
      }
    }
    group.sort(
      (a, b) =>
        Number(b.kind === 'incident') - Number(a.kind === 'incident') ||
        a.label.localeCompare(b.label),
    );
    groups.push(group);
  }
  return groups;
}

interface LabelRow {
  element: HTMLButtonElement;
  title: HTMLElement;
  summary: HTMLElement;
  details: HTMLElement;
  incident: HTMLElement;
  destination: HTMLElement;
}

export class MarkerLabels {
  private readonly rows = new Map<string, LabelRow>();
  private readonly groups = new Map<string, HTMLElement>();
  private readonly membership = new Map<string, HTMLElement>();
  private readonly hovered = new Set<string>();
  private readonly hoveredGroups = new Set<HTMLElement>();
  private readonly anchors = new Map<HTMLElement, { marker: L.Marker; offset: number }>();

  constructor(
    private readonly map: L.Map,
    private readonly select: (location: MapLocation) => void,
  ) {}

  hover(id: string, active: boolean): void {
    if (active) this.hovered.add(id);
    else this.hovered.delete(id);
    this.refreshHover();
  }

  private refreshHover(): void {
    for (const group of this.groups.values()) {
      const active =
        this.hoveredGroups.has(group) ||
        group.contains(document.activeElement) ||
        [...this.hovered].some((id) => this.membership.get(id) === group);
      group.classList.toggle('is-hovered', active);
      const anchor = this.anchors.get(group);
      anchor?.marker.setZIndexOffset(active ? 10000 : anchor.offset);
    }
  }

  render(
    locations: readonly MapLocation[],
    markers: ReadonlyMap<string, L.Marker>,
    states: ReadonlyMap<string, RouteNavigation>,
    selectedUnit: string | null,
    selectedIncident: string | null,
  ): void {
    const activeGroups = new Set<string>();
    const ids = new Set(locations.map((location) => location.id));
    this.membership.clear();
    this.anchors.clear();
    for (const [id, row] of this.rows) {
      if (ids.has(id)) continue;
      row.element.remove();
      this.rows.delete(id);
      this.hovered.delete(id);
    }
    for (const locationsInGroup of groupMarkers(this.map, locations)) {
      const key = JSON.stringify(locationsInGroup.map((location) => location.id));
      activeGroups.add(key);
      let group = this.groups.get(key);
      if (!group) {
        group = document.createElement('div');
        group.className = 'marker-labels';
        const element = group;
        group.addEventListener('mouseenter', () => {
          this.hoveredGroups.add(element);
          this.refreshHover();
        });
        group.addEventListener('mouseleave', () => {
          this.hoveredGroups.delete(element);
          this.refreshHover();
        });
        group.addEventListener('focusin', () => this.refreshHover());
        group.addEventListener('focusout', () => queueMicrotask(() => this.refreshHover()));
        this.groups.set(key, group);
      }
      for (const location of locationsInGroup) {
        const persistent =
          location.kind !== 'unit' ||
          location.id === selectedUnit ||
          (!!selectedIncident && location.incidentId === selectedIncident);
        const state = states.get(location.id);
        const active = location.kind === 'unit' && location.route?.status === 'active';
        let row = this.rows.get(location.id);
        if (!row) {
          const element = document.createElement('button');
          element.type = 'button';
          element.dataset['locationId'] = location.id;
          const title = document.createElement('strong');
          const summary = document.createElement('span');
          summary.className = 'marker-label-summary';
          const details = document.createElement('span');
          details.className = 'marker-label-details';
          const incident = document.createElement('span');
          const destination = document.createElement('span');
          details.append(incident, destination);
          element.append(title, summary, details);
          L.DomEvent.disableClickPropagation(element);
          row = { element, title, summary, details, incident, destination };
          this.rows.set(location.id, row);
        }
        row.element.onclick = () => this.select(location);
        row.element.className = `marker-label${persistent ? ' is-persistent' : ''}${active ? ' in-route' : ''}`;
        row.element.classList.toggle(
          'route-eta',
          active && persistent && state?.status === 'ready',
        );
        row.element.setAttribute('aria-label', `Seleccionar ${location.label}`);
        row.summary.hidden = !active;
        row.details.hidden = location.kind !== 'unit';
        this.text(
          row.title,
          active
            ? state?.status === 'ready'
              ? `≈ ${formatRouteDuration(state.route.durationSeconds)}`
              : state?.status === 'error'
                ? 'Error de ruta'
                : state?.status === 'unavailable'
                  ? 'Ruta no disponible'
                  : 'Calculando ruta…'
            : location.label,
        );
        const distance =
          state?.status === 'ready'
            ? state.route.distanceMeters >= 1000
              ? `${(state.route.distanceMeters / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} km`
              : `${Math.round(state.route.distanceMeters)} m`
            : null;
        this.text(
          row.summary,
          active ? `${location.label}${distance ? ` · ${distance}` : ''}` : '',
        );
        this.text(
          row.incident,
          location.kind === 'unit' ? `Incidencia: ${location.incidentId ?? 'Sin asignar'}` : '',
        );
        this.text(
          row.destination,
          location.kind === 'unit'
            ? `Destino: ${
                location.route?.destinationLabel ??
                (location.route
                  ? `${location.route.destination.lat.toFixed(5)}, ${location.route.destination.lng.toFixed(5)}`
                  : 'Sin destino asignado')
              }`
            : '',
        );
        if (row.element.parentElement !== group) group.append(row.element);
        this.membership.set(location.id, group);
        markers
          .get(location.id)
          ?.setZIndexOffset(
            location.id === selectedUnit ? 1000 : location.kind === 'incident' ? 500 : 0,
          );
      }
      const anchor = markers.get(locationsInGroup[0].id);
      const host = anchor?.getElement()?.querySelector('.map-marker');
      if (host && group.parentElement !== host) host.append(group);
      if (anchor)
        this.anchors.set(group, {
          marker: anchor,
          offset: locationsInGroup.length > 1 ? 1500 : (anchor.options.zIndexOffset ?? 0),
        });
    }
    for (const [key, group] of this.groups) {
      if (activeGroups.has(key)) continue;
      group.remove();
      this.hoveredGroups.delete(group);
      this.groups.delete(key);
    }
    this.refreshHover();
  }

  private text(element: HTMLElement, text: string): void {
    if (element.textContent !== text) element.textContent = text;
  }
}

import * as L from 'leaflet/dist/leaflet-src.esm.js';
import { vi } from 'vitest';
import { MapLocation, RouteNavigation } from '../../../core/models/operations';
import { groupMarkers, MarkerLabels } from './marker-labels';

describe('Marker labels', () => {
  let map: L.Map;
  let container: HTMLDivElement;
  let labels: MarkerLabels;
  const select = vi.fn();
  const markers = new Map<string, L.Marker>();
  const states = new Map<string, RouteNavigation>();

  function location(id: string, kind: MapLocation['kind'], x: number): MapLocation {
    const origin = map.latLngToLayerPoint([40, -3]);
    const point = map.layerPointToLatLng(origin.add([x, 0]));
    return {
      id,
      kind,
      label: id,
      icon: kind === 'unit' ? 'medical' : 'fire',
      address: 'Dirección',
      coordinates: { lat: point.lat, lng: point.lng },
      incidentId: kind === 'incident' ? id : 'INC-1',
    };
  }

  function render(
    locations: readonly MapLocation[],
    unit: string | null = null,
    incident: string | null = null,
  ) {
    for (const location of locations) {
      if (markers.has(location.id)) continue;
      const host = document.createElement('div');
      host.className = 'map-marker';
      markers.set(
        location.id,
        L.marker([location.coordinates.lat, location.coordinates.lng], {
          icon: L.divIcon({ html: host }),
        }).addTo(map),
      );
    }
    labels.render(locations, markers, states, unit, incident);
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    map = L.map(container, { zoomAnimation: false }).setView([40, -3], 15);
    labels = new MarkerLabels(map, select);
    select.mockReset();
    markers.clear();
    states.clear();
  });

  afterEach(() => {
    map.remove();
    container.remove();
  });

  it('groups touching circles transitively, puts incidents first and separates them after zooming', () => {
    const unit = location('R-1', 'unit', 60);
    const incidents = [location('INC-1', 'incident', 0), location('INC-2', 'incident', 30)];
    const locations = [unit, ...incidents];
    expect(groupMarkers(map, locations).map((group) => group.map((item) => item.id))).toEqual([
      ['INC-1', 'INC-2', 'R-1'],
    ]);
    map.setZoom(17);
    expect(groupMarkers(map, locations)).toHaveLength(3);
  });

  it('attaches ETA to the marker, reveals incident/destination on hover and persists only selected resources', () => {
    const unit: MapLocation = {
      ...location('R-1', 'unit', 0),
      route: {
        status: 'active',
        destination: { lat: 41, lng: -3 },
        destinationLabel: '<img src=x>',
      },
    };
    states.set(unit.id, {
      status: 'ready',
      route: {
        path: [unit.coordinates, unit.route!.destination],
        durationSeconds: 336,
        distanceMeters: 2695,
      },
    });
    const unrelated = { ...location('R-2', 'unit', 200), incidentId: 'INC-2' };
    render([unit, unrelated]);
    expect(container.querySelector('.marker-label.is-persistent')).toBeNull();
    labels.hover(unit.id, true);
    const group = container.querySelector('.marker-labels.is-hovered')!;
    expect(group.textContent).toContain('≈ 6 min');
    expect(group.querySelector('.marker-label-details')?.textContent).toContain(
      'Incidencia: INC-1',
    );
    expect(group.querySelector('.marker-label-details')?.textContent).toContain(
      'Destino: <img src=x>',
    );
    expect(group.querySelector('img')).toBeNull();
    expect(container.querySelector('.leaflet-tooltip')).toBeNull();
    labels.hover(unit.id, false);
    render([unit, unrelated], null, 'INC-1');
    expect(container.querySelectorAll('.marker-label.is-persistent')).toHaveLength(1);
    expect(
      container.querySelector('.marker-label.is-persistent')?.getAttribute('data-location-id'),
    ).toBe(unit.id);
    render([unit, unrelated], unrelated.id);
    expect(container.querySelectorAll('.marker-label.is-persistent')).toHaveLength(1);
    expect(
      container.querySelector('.marker-label.is-persistent')?.getAttribute('data-location-id'),
    ).toBe(unrelated.id);
  });

  it('selects each stacked name, raises hovered groups above neighbours and removes stale rows', () => {
    const incident = location('INC-1', 'incident', 0);
    const unit = location('R-1', 'unit', 0);
    const other = location('INC-2', 'incident', 100);
    render([unit, other, incident], unit.id);
    const group = markers.get(incident.id)!.getElement()!.querySelector('.marker-labels')!;
    expect([...group.children].map((element) => element.getAttribute('data-location-id'))).toEqual([
      'INC-1',
      'R-1',
    ]);
    group.querySelector<HTMLButtonElement>('[data-location-id="R-1"]')!.click();
    expect(select).toHaveBeenCalledExactlyOnceWith(unit);
    labels.hover(unit.id, true);
    expect(markers.get(incident.id)!.options.zIndexOffset).toBeGreaterThan(
      markers.get(other.id)!.options.zIndexOffset!,
    );
    labels.hover(unit.id, false);
    expect(markers.get(incident.id)!.options.zIndexOffset).toBe(1500);
    render([incident, other]);
    expect(container.querySelector('[data-location-id="R-1"]')).toBeNull();
    expect(container.querySelectorAll('.marker-labels')).toHaveLength(2);
  });

  it('hides even selected labels when zoomed out and restores them at zoom 12', () => {
    const unit = location('R-1', 'unit', 0);
    const incident = location('INC-1', 'incident', 0);
    map.setZoom(11);
    render([unit, incident], unit.id);
    labels.hover(unit.id, true);
    const group = container.querySelector<HTMLElement>('.marker-labels')!;
    expect(group.hidden).toBe(true);
    map.setZoom(12);
    render([unit, incident], unit.id);
    expect(group.hidden).toBe(false);
    expect(
      group.querySelector('[data-location-id="R-1"]')?.classList.contains('is-persistent'),
    ).toBe(true);
  });
});

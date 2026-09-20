import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import * as L from 'leaflet/dist/leaflet-src.esm.js';
import { MapLocation } from '../../../core/models/operations';
import { Geocoding, normalizeAddress } from '../../../core/services/geocoding';
import { Icon, createIconSvg } from '../../../shared/icon/icon';
import { Theme } from '../../../core/services/theme';
import { formatRouteDuration, Routing } from '../../../core/services/routing';
import { DemoRouteSimulation } from '../../../core/services/demo-route-simulation';
import { ResourceRouteLayer, ResourceRouteState } from './resource-route-layer';

@Component({
  selector: 'app-operational-map',
  imports: [Icon],
  templateUrl: './operational-map.html',
  styleUrl: './operational-map.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OperationalMap {
  readonly addresses = input<readonly string[]>([]);
  readonly locations = input<readonly MapLocation[]>([]);
  readonly selectedUnitId = input<string | null>(null);
  readonly selectedIncidentId = input<string | null>(null);
  readonly visibleUnitIds = input<readonly string[] | null>(null);
  readonly incidentSelected = output<string>();
  readonly unitSelected = output<string>();
  protected readonly showIncidents = signal(true);
  protected readonly showUnits = signal(true);
  protected readonly locating = signal(false);
  protected readonly missingAddresses = signal<string[]>([]);
  protected readonly lookupFailed = signal(false);
  protected readonly tileError = signal(false);
  private readonly sourceLocations = signal<readonly MapLocation[]>([]);
  protected readonly resolvedLocations = computed(() =>
    this.sourceLocations().map((location) => this.simulation.project(location)),
  );
  protected readonly visibleLocations = computed(() =>
    this.resolvedLocations().filter((location) =>
      this.isVisible(location, this.showIncidents(), this.showUnits()),
    ),
  );
  private readonly canvas = viewChild.required<ElementRef<HTMLDivElement>>('mapCanvas');
  private readonly geocoding = inject(Geocoding);
  private readonly routing = inject(Routing);
  private readonly simulation = inject(DemoRouteSimulation);
  private readonly theme = inject(Theme);
  private readonly haloLocations = computed(
    () => this.resolvedLocations().filter((location) => location.kind === 'incident'),
    {
      equal: (a, b) => a.length === b.length && a.every((location, index) => location === b[index]),
    },
  );
  private readonly fetchedRouteStates = signal<ReadonlyMap<string, ResourceRouteState>>(new Map());
  private readonly routeStates = computed(() => {
    const states = new Map(this.fetchedRouteStates());
    for (const location of this.resolvedLocations()) {
      if (location.route?.navigation) states.set(location.id, location.route.navigation);
    }
    return states;
  });
  // Lista de rutas a descargar. Depende solo de la entrada, nunca del avance ya calculado:
  // si el consumo del avance la filtrase, cambiaría en plena descarga y la repetiría.
  private readonly unmanagedLocations = computed(
    () =>
      this.locations().filter(
        (location) =>
          location.kind === 'unit' &&
          location.route?.status === 'active' &&
          !location.route.navigation,
      ),
    {
      equal: (a, b) => a.length === b.length && a.every((location, index) => location === b[index]),
    },
  );
  private readonly routeRetryVersion = signal(0);
  private readonly markers = new Map<string, L.Marker>();
  private readonly markerAppearances = new Map<string, string>();
  private routeLayer?: ResourceRouteLayer;
  private readonly destroyRef = inject(DestroyRef);
  private readonly ready = signal(false);
  private readonly retryVersion = signal(0);
  private map?: L.Map;
  private tiles?: L.TileLayer;
  private markerLayer?: L.LayerGroup;
  private haloLayer?: L.LayerGroup;
  private resizeObserver?: ResizeObserver;
  private fitFrame?: number;
  private lastLocationKey = '';
  private lastSelection: string | null = null;

  constructor() {
    afterNextRender(() => {
      this.map = L.map(this.canvas().nativeElement, {
        zoomControl: false,
        attributionControl: true,
        minZoom: 3,
        maxZoom: 19,
        zoomSnap: 0.25,
      }).setView([40.734, -3.876], 13);
      this.map.attributionControl.setPrefix(false);
      L.control
        .zoom({
          position: 'bottomright',
          zoomInTitle: 'Acercar',
          zoomOutTitle: 'Alejar',
          zoomInText: createIconSvg('plus').outerHTML,
          zoomOutText: createIconSvg('minus').outerHTML,
        })
        .addTo(this.map);
      this.map.createPane('incident-halos').style.zIndex = '350';
      this.haloLayer = L.layerGroup().addTo(this.map);
      this.markerLayer = L.layerGroup().addTo(this.map);
      this.routeLayer = new ResourceRouteLayer(this.map, (id) => this.unitSelected.emit(id));
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => this.map?.invalidateSize());
        this.resizeObserver.observe(this.canvas().nativeElement);
      }
      this.ready.set(true);
    });

    effect(() => {
      if (!this.ready() || !this.map) return;
      this.tiles?.remove();
      this.tileError.set(false);
      this.tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
      }).addTo(this.map);
      this.tiles.on('tileerror', () => this.tileError.set(true));
    });

    effect(() => {
      if (!this.ready() || !this.haloLayer) return;
      const locations = this.haloLocations();
      const selected = this.selectedIncidentId();
      const dark = this.theme.current() === 'dark';
      const visible = this.showIncidents();
      this.haloLayer.clearLayers();
      if (!visible) return;
      for (const location of locations) {
        if (
          !location.radiusMeters ||
          !Number.isFinite(location.radiusMeters) ||
          location.radiusMeters <= 0
        )
          continue;
        const active = location.incidentId === selected;
        const color = dark ? '#e5e5e5' : '#666666';
        for (const scale of [1, 0.7]) {
          L.circle([location.coordinates.lat, location.coordinates.lng], {
            radius: location.radiusMeters * scale,
            pane: 'incident-halos',
            interactive: false,
            color,
            weight: active ? 1.5 : 1,
            opacity: active ? 0.65 : 0.25,
            fillColor: color,
            fillOpacity: active ? 0.12 : 0.045,
          }).addTo(this.haloLayer);
        }
      }
    });

    effect((onCleanup) => {
      if (!this.ready()) return;
      const addresses = this.addresses();
      const locations = this.locations();
      this.retryVersion();
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      void this.resolveAddresses(addresses, locations, controller.signal);
    });

    effect((onCleanup) => {
      if (!this.ready()) return;
      const locations = this.unmanagedLocations();
      const visible = this.showUnits();
      this.routeRetryVersion();
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      void this.loadRoutes(visible ? locations : [], controller.signal);
    });

    effect(() => {
      if (this.selectedUnitId()) this.showUnits.set(true);
    });

    effect(() => {
      if (!this.ready()) return;
      this.drawMarkers(
        this.resolvedLocations(),
        this.selectedIncidentId(),
        this.selectedUnitId(),
        this.showIncidents(),
        this.showUnits(),
      );
    });

    // Engancha a las unidades que van aceptando la llamada, no solo a las del primer render.
    // Depende de las rutas ya descargadas, nunca de `resolvedLocations`: eso realimentaría
    // el propio avance y se iría en bucle.
    effect(() => this.simulation.sync(this.sourceLocations(), this.fetchedRouteStates()));
    effect(() => {
      if (!this.ready()) return;
      const locations = this.resolvedLocations();
      const states = this.routeStates();
      this.routeLayer?.render(
        locations.filter((location) => this.isVisible(location, true, true)),
        states,
        this.selectedUnitId(),
        this.showUnits(),
      );
      for (const location of locations) {
        const marker = this.markers.get(location.id);
        if (!marker?.isPopupOpen()) continue;
        const content = this.popupContent(location, states.get(location.id));
        const previous = marker.getPopup()?.getContent() as HTMLElement | undefined;
        if (previous?.textContent !== content.textContent) marker.setPopupContent(content);
      }
    });

    this.destroyRef.onDestroy(() => {
      if (this.fitFrame !== undefined) cancelAnimationFrame(this.fitFrame);
      this.resizeObserver?.disconnect();
      this.routeLayer?.remove();
      this.map?.remove();
    });
  }

  protected fitLocations(): void {
    const visible = this.visibleLocations();
    if (visible.length && this.map) {
      this.map.invalidateSize({ pan: false });
      const points = visible.map((location) => location.coordinates);
      for (const location of visible) {
        const state = this.routeStates().get(location.id);
        if (
          location.kind === 'unit' &&
          location.route?.status === 'active' &&
          state?.status === 'ready'
        )
          points.push(...state.route.path);
      }
      this.map.fitBounds(L.latLngBounds(points.map((point) => [point.lat, point.lng])), {
        padding: [48, 58],
        maxZoom: 15,
        animate: false,
      });
    }
  }

  protected retry(): void {
    this.tileError.set(false);
    this.tiles?.redraw();
    this.retryVersion.update((value) => value + 1);
  }

  private async resolveAddresses(
    addresses: readonly string[],
    locations: readonly MapLocation[],
    signal: AbortSignal,
  ): Promise<void> {
    const uniqueAddresses = [
      ...new Map(
        addresses
          .filter((address) => address.trim())
          .map((address) => [normalizeAddress(address), address]),
      ).values(),
    ];
    const known = new Set(locations.map((location) => normalizeAddress(location.address)));
    const pending = uniqueAddresses.filter((address) => !known.has(normalizeAddress(address)));
    const resolved = [...locations];
    const missing: string[] = [];
    this.sourceLocations.set([...resolved]);
    this.missingAddresses.set([]);
    this.lookupFailed.set(false);
    this.locating.set(pending.length > 0);
    for (const [index, address] of pending.entries()) {
      try {
        const coordinates = await this.geocoding.geocode(address, signal);
        if (signal.aborted) return;
        if (coordinates) {
          resolved.push({
            id: `address:${normalizeAddress(address)}`,
            label: address,
            address,
            coordinates,
            icon: 'pin',
            kind: 'incident',
          });
        } else {
          missing.push(address);
        }
      } catch {
        if (signal.aborted) return;
        this.lookupFailed.set(true);
        missing.push(...pending.slice(index));
        break;
      }
    }
    if (!signal.aborted) {
      this.sourceLocations.set([...resolved]);
      this.missingAddresses.set(missing);
      this.locating.set(false);
    }
  }

  private drawMarkers(
    locations: readonly MapLocation[],
    selectedId: string | null,
    selectedUnitId: string | null,
    incidentsVisible: boolean,
    unitsVisible: boolean,
  ): void {
    if (!this.map || !this.markerLayer) return;
    const visible = locations.filter((location) =>
      this.isVisible(location, incidentsVisible, unitsVisible),
    );
    const ids = new Set(visible.map((location) => location.id));
    for (const [id, marker] of this.markers) {
      if (ids.has(id)) continue;
      this.markerLayer.removeLayer(marker);
      this.markers.delete(id);
      this.markerAppearances.delete(id);
    }
    let selectedMarker: L.Marker | undefined;
    for (const location of visible) {
      const selected = this.isSelected(location, selectedId, selectedUnitId);
      const related = !selectedUnitId && !!selectedId && location.incidentId === selectedId;
      const appearance = JSON.stringify([
        location.kind,
        location.icon,
        location.label,
        selected,
        related,
      ]);
      let marker = this.markers.get(location.id);
      if (!marker) {
        marker = L.marker([location.coordinates.lat, location.coordinates.lng], {
          icon: this.createIcon(location, selectedUnitId ? null : selectedId, selected),
          title: `${location.label} · ${location.address}`,
          alt: location.label,
          keyboard: true,
        }).addTo(this.markerLayer);
        this.markers.set(location.id, marker);
        this.markerAppearances.set(location.id, appearance);
        marker.bindPopup(
          this.popupContent(
            location,
            untracked(() => this.routeStates().get(location.id)),
          ),
          { maxWidth: 250 },
        );
        marker.on('click', () => {
          if (location.kind === 'unit') this.unitSelected.emit(location.id);
          else if (location.kind === 'incident' && location.incidentId)
            this.incidentSelected.emit(location.incidentId);
        });
        marker.on('popupopen', () => {
          const current = this.resolvedLocations().find((item) => item.id === location.id);
          if (current)
            marker!.setPopupContent(this.popupContent(current, this.routeStates().get(current.id)));
        });
      } else {
        if (this.markerAppearances.get(location.id) !== appearance) {
          marker.setIcon(this.createIcon(location, selectedUnitId ? null : selectedId, selected));
          this.markerAppearances.set(location.id, appearance);
        }
        const point = L.latLng(location.coordinates.lat, location.coordinates.lng);
        if (!marker.getLatLng().equals(point)) marker.setLatLng(point);
        marker.getElement()?.setAttribute('title', `${location.label} · ${location.address}`);
      }
      marker.setZIndexOffset(selected ? 1000 : location.kind === 'incident' ? 500 : 0);
      if (selected) selectedMarker = marker;
    }
    const locationKey = locations.map((location) => location.id).join('|');
    const selectionKey = selectedUnitId
      ? `unit:${selectedUnitId}`
      : selectedId
        ? `incident:${selectedId}`
        : null;
    if (locationKey !== this.lastLocationKey) {
      this.lastLocationKey = locationKey;
      if (this.fitFrame !== undefined) cancelAnimationFrame(this.fitFrame);
      this.fitFrame = requestAnimationFrame(() => {
        this.fitFrame = undefined;
        if (!this.destroyRef.destroyed) untracked(() => this.fitLocations());
      });
    } else if (selectionKey !== this.lastSelection && selectedMarker) {
      if (this.fitFrame !== undefined) cancelAnimationFrame(this.fitFrame);
      this.fitFrame = undefined;
      this.map.panTo(selectedMarker.getLatLng(), { animate: false });
      selectedMarker.openPopup();
    }
    this.lastSelection = selectionKey;
  }

  private async loadRoutes(locations: readonly MapLocation[], signal: AbortSignal): Promise<void> {
    const units = locations.filter(
      (location) => location.kind === 'unit' && location.route?.status === 'active',
    );
    const states = new Map<string, ResourceRouteState>(
      units.map((unit) => [unit.id, { status: 'loading' }]),
    );
    this.fetchedRouteStates.set(new Map(states));
    for (const [index, unit] of units.entries()) {
      try {
        const route = await this.routing.calculate(unit.coordinates, unit.route!, signal);
        if (signal.aborted) return;
        states.set(unit.id, route ? { status: 'ready', route } : { status: 'unavailable' });
      } catch {
        if (signal.aborted) return;
        for (const pending of units.slice(index)) states.set(pending.id, { status: 'error' });
        this.fetchedRouteStates.set(new Map(states));
        return;
      }
      this.fetchedRouteStates.set(new Map(states));
    }
  }

  private popupContent(location: MapLocation, state?: ResourceRouteState): HTMLElement {
    const popup = document.createElement('div');
    popup.className = 'map-popup';
    const title = document.createElement('strong');
    title.textContent = location.label;
    const address = document.createElement('span');
    address.textContent = location.address;
    popup.append(title, address);
    if (location.detail) {
      const detail = document.createElement('span');
      detail.textContent = location.detail;
      popup.append(detail);
    }
    if (location.kind !== 'unit') return popup;
    if (location.route?.destinationLabel) {
      const destination = document.createElement('span');
      destination.textContent = `Destino: ${location.route.destinationLabel}`;
      popup.append(destination);
    }
    const status = document.createElement('span');
    status.className = 'map-route-status';
    status.textContent = !location.route
      ? 'Sin ruta activa'
      : location.route.status === 'completed'
        ? 'Ruta finalizada'
        : state?.status === 'ready'
          ? `Llegada aproximada: ${formatRouteDuration(state.route.durationSeconds)}`
          : state?.status === 'unavailable'
            ? 'No se ha encontrado una ruta por carretera'
            : state?.status === 'error'
              ? 'No se ha podido calcular la ruta'
              : 'Calculando ruta…';
    popup.append(status);
    if (location.route?.status === 'active' && state?.status === 'ready') {
      const note = document.createElement('span');
      note.className = 'route-disclaimer';
      note.textContent = 'Sin tráfico en tiempo real';
      popup.append(note);
    }
    if (location.route?.status === 'active' && state?.status === 'error') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Reintentar ruta';
      retry.addEventListener('click', () => this.routeRetryVersion.update((value) => value + 1));
      popup.append(retry);
    }
    return popup;
  }

  private isVisible(location: MapLocation, incidents: boolean, units: boolean): boolean {
    return (
      location.kind === 'place' ||
      (location.kind === 'incident'
        ? incidents
        : units && (this.visibleUnitIds() === null || this.visibleUnitIds()!.includes(location.id)))
    );
  }

  private isSelected(
    location: MapLocation,
    incidentId: string | null,
    unitId: string | null,
  ): boolean {
    return unitId
      ? location.kind === 'unit' && location.id === unitId
      : !!incidentId && location.kind === 'incident' && location.incidentId === incidentId;
  }

  private createIcon(
    location: MapLocation,
    selectedId: string | null,
    selected: boolean,
  ): L.DivIcon {
    const element = document.createElement('div');
    const related = selected || (!!selectedId && location.incidentId === selectedId);
    element.className = `map-marker kind-${location.kind}${related ? ' is-related' : ''}${selected ? ' is-selected' : ''}`;
    const symbol = document.createElement('span');
    symbol.className = 'marker-symbol';
    symbol.append(createIconSvg(location.icon));
    const label = document.createElement('span');
    label.className = 'marker-label';
    label.textContent = location.label;
    element.append(symbol, label);
    const size = location.kind === 'incident' ? 46 : 34;
    return L.divIcon({
      html: element,
      className: 'operation-marker',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -size / 2 - 4],
    });
  }
}

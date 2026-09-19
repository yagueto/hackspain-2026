import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import * as L from 'leaflet';
import { MapLocation } from '../../../core/models/operations';
import { Geocoding, normalizeAddress } from '../../../core/services/geocoding';
import { Icon, ICON_PATHS } from '../../../shared/icon/icon';

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
  readonly selectedIncidentId = input<string | null>(null);
  readonly incidentSelected = output<string>();
  protected readonly showIncidents = signal(true);
  protected readonly showUnits = signal(true);
  protected readonly locating = signal(false);
  protected readonly missingAddresses = signal<string[]>([]);
  protected readonly lookupFailed = signal(false);
  protected readonly tileError = signal(false);
  protected readonly centerLabel = signal('40.7340° N · 3.8760° O');
  protected readonly resolvedLocations = signal<readonly MapLocation[]>([]);
  private readonly canvas = viewChild.required<ElementRef<HTMLDivElement>>('mapCanvas');
  private readonly geocoding = inject(Geocoding);
  private readonly destroyRef = inject(DestroyRef);
  private readonly ready = signal(false);
  private readonly retryVersion = signal(0);
  private map?: L.Map;
  private tiles?: L.TileLayer;
  private markerLayer?: L.LayerGroup;
  private resizeObserver?: ResizeObserver;
  private lastLocationKey = '';
  private lastSelection: string | null = null;

  constructor() {
    afterNextRender(() => {
      this.map = L.map(this.canvas().nativeElement, {
        zoomControl: false,
        attributionControl: true,
        minZoom: 3,
        maxZoom: 19,
      }).setView([40.734, -3.876], 13);
      this.tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
      }).addTo(this.map);
      this.tiles.on('tileerror', () => this.tileError.set(true));
      this.map.attributionControl.setPrefix(false);
      L.control
        .zoom({ position: 'bottomright', zoomInTitle: 'Acercar', zoomOutTitle: 'Alejar' })
        .addTo(this.map);
      this.markerLayer = L.layerGroup().addTo(this.map);
      this.map.on('moveend', () => {
        const { lat, lng } = this.map!.getCenter();
        this.centerLabel.set(
          `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'} · ${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? 'E' : 'O'}`,
        );
      });
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => this.map?.invalidateSize());
        this.resizeObserver.observe(this.canvas().nativeElement);
      }
      this.ready.set(true);
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

    effect(() => {
      if (!this.ready()) return;
      this.drawMarkers(
        this.resolvedLocations(),
        this.selectedIncidentId(),
        this.showIncidents(),
        this.showUnits(),
      );
    });

    this.destroyRef.onDestroy(() => {
      this.resizeObserver?.disconnect();
      this.map?.remove();
    });
  }

  protected fitLocations(): void {
    const visible = this.resolvedLocations().filter((location) =>
      this.isVisible(location, this.showIncidents(), this.showUnits()),
    );
    if (visible.length && this.map) {
      this.map.fitBounds(
        L.latLngBounds(
          visible.map((location) => [location.coordinates.lat, location.coordinates.lng]),
        ),
        { padding: [65, 65], maxZoom: 15, animate: false },
      );
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
    this.resolvedLocations.set(resolved);
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
      this.resolvedLocations.set([...resolved]);
      this.missingAddresses.set(missing);
      this.locating.set(false);
    }
  }

  private drawMarkers(
    locations: readonly MapLocation[],
    selectedId: string | null,
    incidentsVisible: boolean,
    unitsVisible: boolean,
  ): void {
    if (!this.map || !this.markerLayer) return;
    this.markerLayer.clearLayers();
    let selectedMarker: L.Marker | undefined;
    for (const location of locations) {
      if (!this.isVisible(location, incidentsVisible, unitsVisible)) continue;
      const marker = L.marker([location.coordinates.lat, location.coordinates.lng], {
        icon: this.createIcon(location, selectedId),
        title: `${location.label} · ${location.address}`,
        alt: location.label,
        keyboard: true,
        zIndexOffset: location.kind === 'incident' ? 500 : 0,
      }).addTo(this.markerLayer);
      const popup = document.createElement('div');
      popup.className = 'map-popup';
      const title = document.createElement('strong');
      title.textContent = location.label;
      const address = document.createElement('span');
      address.textContent = location.address;
      popup.append(title, address);
      marker.bindPopup(popup, { maxWidth: 250 });
      marker.on('click', () => {
        if (location.incidentId) this.incidentSelected.emit(location.incidentId);
      });
      if (location.kind === 'incident' && location.incidentId === selectedId)
        selectedMarker = marker;
    }
    const locationKey = locations
      .map((location) => `${location.id}:${location.coordinates.lat}:${location.coordinates.lng}`)
      .join('|');
    if (locationKey !== this.lastLocationKey) {
      this.lastLocationKey = locationKey;
      this.fitLocations();
    } else if (selectedId !== this.lastSelection && selectedMarker) {
      this.map.panTo(selectedMarker.getLatLng(), { animate: false });
      selectedMarker.openPopup();
    }
    this.lastSelection = selectedId;
  }

  private isVisible(location: MapLocation, incidents: boolean, units: boolean): boolean {
    return location.kind === 'place' || (location.kind === 'incident' ? incidents : units);
  }

  private createIcon(location: MapLocation, selectedId: string | null): L.DivIcon {
    const element = document.createElement('div');
    const related = !!selectedId && location.incidentId === selectedId;
    element.className = `map-marker kind-${location.kind}${related ? ' is-related' : ''}${related && location.kind === 'incident' ? ' is-selected' : ''}`;
    const symbol = document.createElement('span');
    symbol.className = 'marker-symbol';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.8',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    }))
      svg.setAttribute(name, value);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICON_PATHS[location.icon]);
    svg.append(path);
    symbol.append(svg);
    const label = document.createElement('span');
    label.className = 'marker-label';
    label.textContent = location.label;
    element.append(symbol, label);
    return L.divIcon({
      html: element,
      className: 'operation-marker',
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      popupAnchor: [0, -24],
    });
  }
}

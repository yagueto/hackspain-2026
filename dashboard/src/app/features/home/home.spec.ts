import { TestBed } from '@angular/core/testing';
import * as L from 'leaflet/dist/leaflet-src.esm.js';
import { vi } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { Incident } from '../../core/models/operations';
import { WorldSnapshot } from '../../core/models/world';
import { MOCK_COMMUNICATIONS, MOCK_INCIDENTS, MOCK_UNITS } from '../../core/data/operations.mock';
import { Operations } from '../../core/services/operations';
import { Geocoding } from '../../core/services/geocoding';
import { Routing } from '../../core/services/routing';
import { Home } from './home';

describe('Home resource selection', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: Operations,
          useValue: {
            incidents: signal(MOCK_INCIDENTS),
            communications: signal(MOCK_COMMUNICATIONS),
            units: signal(MOCK_UNITS),
            snapshot: signal(null),
            meta: signal({ happyrobot_mode: 'simulated', nominatim_demo_enabled: true }),
            start: vi.fn(),
            refresh: vi.fn(),
            approve: vi.fn().mockResolvedValue({}),
            geocode: vi.fn().mockResolvedValue({}),
            confirmLocation: vi.fn().mockResolvedValue({}),
            resumeSimulated: vi.fn().mockResolvedValue({}),
            connection: signal('live'),
            error: signal(''),
          },
        },
        { provide: Geocoding, useValue: { geocode: vi.fn() } },
        { provide: Routing, useValue: { calculate: vi.fn().mockResolvedValue(null) } },
      ],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  async function setup() {
    const fixture = TestBed.createComponent(Home);
    await fixture.whenStable();
    return fixture;
  }

  it('keeps the map host flexible before any incoming report exists', async () => {
    const incidents = TestBed.inject(Operations).incidents as WritableSignal<Incident[]>;
    incidents.set([]);
    const fixture = await setup();
    const map = fixture.nativeElement.querySelector('app-operational-map') as HTMLElement;
    expect(getComputedStyle(map).display).toBe('flex');
    expect(map.querySelector('.map-canvas.leaflet-container')).not.toBeNull();
  });

  it('starts without any selected incident, resource or highlighted marker', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance.selectedIncidentId()).toBeNull();
    expect(fixture.componentInstance.selectedUnitId()).toBeNull();
    expect(
      element.querySelector(
        '.incident-row.selected, .communication.related, .map-marker.is-selected, .map-marker.is-related',
      ),
    ).toBeNull();
    expect(element.textContent).not.toMatch(/simulad|demostración|Historial de/i);
  });

  it('shows incoming reports, then places their confirmed coordinates without external geocoding', async () => {
    const data = TestBed.inject(Operations).incidents as WritableSignal<Incident[]>;
    data.set([
      {
        id: 'call:chat-1',
        title: 'Aviso: incendio',
        address: 'Dirección privada de prueba',
        area: 'Dirección privada de prueba',
        priority: 'P1',
        status: 'Ubicación pendiente',
        icon: 'fire',
        description: 'Aviso pendiente de localización',
      },
    ]);
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    element.querySelector<HTMLButtonElement>('.incident-row')!.click();
    await fixture.whenStable();
    expect(element.querySelector('.incident-detail')?.textContent).toContain(
      'Dirección privada de prueba',
    );
    expect(element.querySelectorAll('.map-marker.kind-incident')).toHaveLength(0);
    expect(TestBed.inject(Geocoding).geocode).not.toHaveBeenCalled();
    data.update((items) =>
      items.map((item) => ({
        ...item,
        coordinates: { lat: 40.65, lng: -4.7 },
        locationStatus: 'Coordenadas confirmadas por el informante',
      })),
    );
    await fixture.whenStable();
    expect(element.querySelectorAll('.map-marker.kind-incident')).toHaveLength(1);
    expect(element.querySelector('.incident-detail')?.textContent).toContain('40.65, -4.7');
    expect(TestBed.inject(Geocoding).geocode).not.toHaveBeenCalled();
    data.set([]);
    await fixture.whenStable();
    expect(fixture.componentInstance.selectedIncidentId()).toBeNull();
    expect(element.querySelectorAll('.map-marker.kind-incident')).toHaveLength(0);
  });

  it('requires operator authentication and location review, and invalidates review after a correction', async () => {
    const operations = TestBed.inject(Operations);
    const report = {
      run_id: 'review-1',
      timestamp: '2026-09-19T12:00:00Z',
      emergency_type: 'incendio',
      severity: 'grave' as const,
      escalation_required: true,
      location: { raw_text: 'Plaza pública', lat: 40, lng: -4, confirmed: true },
      victims: {},
    };
    const task = {
      id: 'proposal-1',
      title: 'Propuesta Bomberos',
      zone_id: null,
      resource_ids: [],
      status: 'awaiting_approval',
      incoming_call_id: report.run_id,
      updated_at: report.timestamp,
      target_location: { lat: 40, lng: -4, label: 'Plaza pública' },
    };
    const state: WorldSnapshot = {
      version: 1,
      generated_at: report.timestamp,
      incident: { id: 'incident', name: 'Crisis', started_at: report.timestamp },
      zones: [],
      fronts: [],
      resources: [],
      contacts: [],
      tasks: [task],
      recent_actions: [],
      incoming_calls: [report],
      agent: { mode: 'paused' },
    };
    operations.snapshot.set(state);
    (operations.incidents as WritableSignal<Incident[]>).set([
      {
        id: 'call:review-1',
        title: 'Aviso',
        address: 'Plaza pública',
        area: 'Plaza pública',
        priority: 'P1',
        status: 'Pendiente de aprobación',
        coordinates: { lat: 40, lng: -4 },
        icon: 'fire',
      },
    ]);
    const fixture = await setup();
    fixture.componentInstance.selectIncident('call:review-1');
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector(
      '.proposal-actions button',
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fixture.componentInstance.operatorKey.set('operator-test');
    await fixture.whenStable();
    expect(button.disabled).toBe(true);
    fixture.componentInstance.reviewedLocation.set(fixture.componentInstance.locationVersion());
    await fixture.whenStable();
    expect(button.disabled).toBe(false);
    button.click();
    await fixture.whenStable();
    expect(operations.approve).toHaveBeenCalledWith(task, true, 'operator-test', true);
    expect(operations.resumeSimulated).not.toHaveBeenCalled();
    operations.snapshot.set({
      ...state,
      incoming_calls: [{ ...report, timestamp: '2026-09-19T12:01:00Z' }],
    });
    await fixture.whenStable();
    expect(button.disabled).toBe(true);
    await fixture.componentInstance.searchLocation();
    expect(operations.geocode).not.toHaveBeenCalled();
  });

  it('focuses the resource from the feed, including another resource in the same incident', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    const panTo = vi.spyOn(L.Map.prototype, 'panTo');
    for (const [row, unitId] of [
      [0, 'B-03'],
      [2, 'H-01'],
    ] as const) {
      element.querySelectorAll<HTMLButtonElement>('.communication')[row].click();
      await fixture.whenStable();
      expect(element.querySelector('.map-marker.is-selected .marker-label')?.textContent).toBe(
        unitId,
      );
      expect(element.querySelector('.map-popup strong')?.textContent).toBe(unitId);
      expect(element.querySelectorAll('.incident-row[aria-pressed="true"]').length).toBe(0);
      expect(element.querySelectorAll('.communication[aria-pressed="true"]').length).toBe(1);
      expect(element.querySelectorAll('.communication.related').length).toBe(1);
      expect(panTo).toHaveBeenCalledWith(
        expect.objectContaining(MOCK_UNITS.find((unit) => unit.id === unitId)!.coordinates),
        { animate: false },
      );
    }
  });

  it('selects a map resource without selecting its incident', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    element.querySelector<HTMLElement>('.operation-marker[title^="BUS-04 ·"]')!.click();
    await fixture.whenStable();
    expect(element.querySelector('.map-marker.is-selected .marker-label')?.textContent).toBe(
      'BUS-04',
    );
    expect(element.querySelector('.map-popup strong')?.textContent).toBe('BUS-04');
    expect(element.querySelector('.communication[aria-pressed="true"]')?.textContent).toContain(
      'BUS-04',
    );
    expect(element.querySelectorAll('.incident-row.selected').length).toBe(0);
  });

  it('reveals the units layer when a resource is selected from the feed', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    element.querySelectorAll<HTMLButtonElement>('.map-legend button')[1].click();
    await fixture.whenStable();
    expect(element.querySelectorAll('.map-marker.kind-unit').length).toBe(0);
    element.querySelector<HTMLButtonElement>('.communication')!.click();
    await fixture.whenStable();
    expect(element.querySelector('.map-marker.is-selected .marker-label')?.textContent).toBe(
      'B-03',
    );
    expect(element.querySelector('.map-popup strong')?.textContent).toBe('B-03');
    expect(element.querySelectorAll('.map-marker.kind-unit').length).toBe(10);
  });

  it('supports resources without a communication in the feed', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    element.querySelector<HTMLElement>('.operation-marker[title^="B-07 ·"]')!.click();
    await fixture.whenStable();
    expect(element.querySelector('.map-marker.is-selected .marker-label')?.textContent).toBe(
      'B-07',
    );
    expect(element.querySelector('.map-popup strong')?.textContent).toBe('B-07');
    expect(element.querySelectorAll('.communication.related').length).toBe(0);
    expect(element.querySelectorAll('.incident-row.selected').length).toBe(0);
  });

  it('restores incident selection and associated resources after selecting a resource', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    element.querySelector<HTMLButtonElement>('.communication')!.click();
    await fixture.whenStable();
    element.querySelectorAll<HTMLButtonElement>('.incident-row')[1].click();
    await fixture.whenStable();
    expect(element.querySelector('.map-marker.is-selected .marker-label')?.textContent).toBe(
      'INC-002',
    );
    expect(element.querySelector('.map-popup strong')?.textContent).toBe('INC-002');
    expect(element.querySelectorAll('.communication[aria-pressed="true"]').length).toBe(0);
    expect(element.querySelectorAll('.communication.related').length).toBe(1);
    expect(element.querySelectorAll('.map-marker.kind-unit.is-related').length).toBe(3);
  });
});

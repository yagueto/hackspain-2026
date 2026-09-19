import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { Geocoding } from '../../core/services/geocoding';
import { Routing } from '../../core/services/routing';
import { INCIDENT_UPDATES, IncidentStore, IncidentUpdate } from './incident-store';
import { Incidents } from './incidents';

describe('Incidents workspace', () => {
  let updates: Subject<IncidentUpdate>;

  beforeEach(() => {
    updates = new Subject<IncidentUpdate>();
    TestBed.configureTestingModule({
      providers: [
        { provide: INCIDENT_UPDATES, useValue: updates },
        { provide: Geocoding, useValue: { geocode: vi.fn() } },
        { provide: Routing, useValue: { calculate: vi.fn().mockResolvedValue(null) } },
      ],
    });
  });

  async function setup() {
    const fixture = TestBed.createComponent(Incidents);
    await fixture.whenStable();
    return { fixture, element: fixture.nativeElement as HTMLElement };
  }

  it('starts without selection and shows the mock incidents', async () => {
    const { fixture, element } = await setup();
    expect(element.querySelectorAll('.incident-card')).toHaveLength(4);
    expect(fixture.componentInstance.selectedIncident()).toBeUndefined();
    expect(element.textContent).toContain('Selecciona una incidencia');
    expect(element.querySelector('app-operational-map')).toBeNull();
  });

  it('shows data without redundant captions and keeps only the filtered header count', async () => {
    const { fixture, element } = await setup();
    fixture.componentInstance.selectIncident('INC-001');
    await fixture.whenStable();
    expect(element.querySelector('.panel-subtitle, .section-label, .results-heading')).toBeNull();
    expect(element.querySelector('.detail-heading')?.textContent).not.toContain('Notificada');
    expect(element.querySelector('.detail-heading time')?.textContent).toContain('19/09/2026');
    expect(element.querySelectorAll('.classification dt.sr-only')).toHaveLength(3);
    expect(element.querySelector('.fact h3')).toBeNull();
    expect(element.querySelector('.fact')?.textContent).toContain('Canto Cochino');
    expect(element.querySelector('.affected-count')?.textContent).toContain('5');
    expect(element.querySelector('.affected-count')?.textContent).toContain('personas');
    expect(element.querySelectorAll('.filters label .sr-only')).toHaveLength(3);
    fixture.componentInstance.setFilter('priority', 'P0');
    await fixture.whenStable();
    expect(element.querySelector('.list-toolbar .count-badge')?.textContent?.trim()).toBe('1');
    expect(element.querySelector('.list-toolbar .count-badge')?.getAttribute('aria-live')).toBe(
      'polite',
    );
  });

  it('combines accent-insensitive search with category, severity and status filters', async () => {
    const { fixture, element } = await setup();
    const search = element.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'evacuacion';
    search.dispatchEvent(new Event('input'));
    for (const [name, value] of [
      ['category', 'Evacuación'],
      ['priority', 'P1'],
      ['status', 'En coordinación'],
    ]) {
      const select = element.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!;
      select.value = value;
      select.dispatchEvent(new Event('change'));
    }
    await fixture.whenStable();
    expect(element.querySelectorAll('.incident-card')).toHaveLength(1);
    expect(element.querySelector('.incident-card')?.textContent).toContain('INC-002');
    search.value = 'inexistente';
    search.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(element.textContent).toContain('No hay coincidencias');
    element.querySelector<HTMLButtonElement>('[data-testid="clear-filters"]')!.click();
    await fixture.whenStable();
    expect(element.querySelectorAll('.incident-card')).toHaveLength(4);
  });

  it('applies each filter independently and combines incompatible filters to an empty result', async () => {
    const { fixture, element } = await setup();
    for (const [key, value, expected] of [
      ['category', 'Forestal', ['INC-001']],
      ['priority', 'P1', ['INC-001', 'INC-002']],
      ['status', 'En atención', ['INC-003']],
      ['query', 'paz', ['INC-003']],
    ] as const) {
      fixture.componentInstance.setFilter(key, value);
      await fixture.whenStable();
      expect(fixture.componentInstance.filteredIncidents().map((incident) => incident.id)).toEqual(
        expected,
      );
      element.querySelector<HTMLButtonElement>('[data-testid="clear-filters"]')!.click();
      await fixture.whenStable();
    }
    fixture.componentInstance.setFilter('category', 'Forestal');
    fixture.componentInstance.setFilter('priority', 'P0');
    await fixture.whenStable();
    expect(element.querySelectorAll('.incident-card')).toHaveLength(0);
  });

  it('keeps the last timeline visible when the event stream fails', async () => {
    const { fixture, element } = await setup();
    fixture.componentInstance.selectIncident('INC-001');
    await fixture.whenStable();
    const count = element.querySelectorAll('.timeline-event').length;
    updates.error(new Error('Disconnected'));
    await fixture.whenStable();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('Se ha interrumpido');
    expect(element.querySelectorAll('.timeline-event')).toHaveLength(count);
    expect(fixture.componentInstance.selectedIncident()?.id).toBe('INC-001');
  });

  it('shows only the selected incident and its resources, and focuses a clicked service', async () => {
    const { fixture, element } = await setup();
    element.querySelector<HTMLButtonElement>('.incident-card')!.click();
    await fixture.whenStable();
    expect(element.querySelectorAll('.map-marker.kind-incident')).toHaveLength(1);
    expect(element.querySelectorAll('.map-marker.kind-unit')).toHaveLength(4);
    expect(element.querySelectorAll('.service-card')).toHaveLength(4);
    element.querySelector<HTMLButtonElement>('.service-card')!.click();
    await fixture.whenStable();
    expect(element.querySelector('.map-marker.is-selected .marker-label')?.textContent).toBe(
      'B-03',
    );
    expect(element.querySelector('.map-popup strong')?.textContent).toBe('B-03');
    fixture.componentInstance.selectIncident('INC-003');
    await fixture.whenStable();
    expect(fixture.componentInstance.selectedUnitId()).toBeNull();
    expect(element.querySelectorAll('.service-card')).toHaveLength(1);
    expect(element.querySelectorAll('.map-marker.kind-unit')).toHaveLength(1);
  });

  it('updates and reorders timeline events without duplicates or losing selection', async () => {
    const { fixture, element } = await setup();
    fixture.componentInstance.selectIncident('INC-001');
    await fixture.whenStable();
    const originalCount = element.querySelectorAll('.timeline-event').length;
    const event = {
      id: 'live-1',
      incidentId: 'INC-001',
      occurredAt: '2026-09-19T14:39:00+02:00',
      title: 'Cambio de viento',
      description: 'Se modifica el perímetro.',
      source: 'Coordinación',
    };
    updates.next({ incidentId: 'INC-001', event });
    await fixture.whenStable();
    expect(element.querySelectorAll('.timeline-event')).toHaveLength(originalCount + 1);
    expect(element.querySelector('.timeline-event:last-child')?.textContent).toContain(
      'Cambio de viento',
    );
    updates.next({
      incidentId: 'INC-001',
      event: { ...event, description: 'Perímetro confirmado.' },
    });
    updates.next({
      incidentId: 'INC-001',
      event: { ...event, id: 'late-1', occurredAt: '2026-09-19T14:32:00+02:00' },
    });
    await fixture.whenStable();
    expect(element.querySelectorAll('.timeline-event')).toHaveLength(originalCount + 2);
    expect(element.querySelector('.timeline-event:last-child')?.textContent).toContain(
      'Perímetro confirmado.',
    );
    expect(fixture.componentInstance.selectedIncident()?.id).toBe('INC-001');
  });

  it('reacts to incident and resource updates, and hides detail excluded by filters', async () => {
    const { fixture, element } = await setup();
    fixture.componentInstance.selectIncident('INC-001');
    fixture.componentInstance.setFilter('priority', 'P1');
    updates.next({ incidentId: 'INC-001', details: { affected: 8 }, units: [] });
    await fixture.whenStable();
    expect(element.querySelector('.affected-count')?.textContent).toContain('8');
    expect(element.querySelectorAll('.service-card')).toHaveLength(0);
    expect(element.querySelectorAll('.map-marker.kind-unit')).toHaveLength(0);
    updates.next({ incidentId: 'INC-001', incident: { priority: 'P0' } });
    await fixture.whenStable();
    expect(fixture.componentInstance.selectedIncident()).toBeUndefined();
    expect(element.querySelector('app-operational-map')).toBeNull();
  });

  it('keeps updates isolated to their incident and unsubscribes on destruction', () => {
    const store = TestBed.inject(IncidentStore);
    const previous = store.events();
    updates.next({
      incidentId: 'INC-001',
      event: {
        id: 'bad',
        incidentId: 'INC-002',
        occurredAt: 'invalid',
        title: 'Invalid',
        description: '',
        source: '',
      },
    });
    expect(store.events()).toEqual(previous);
    TestBed.resetTestingModule();
    expect(updates.observed).toBe(false);
  });
});

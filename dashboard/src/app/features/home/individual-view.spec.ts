import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import * as L from 'leaflet/dist/leaflet-src.esm.js';
import { vi } from 'vitest';
import { routes } from '../../app.routes';
import { App } from '../../app';
import { MOCK_INCIDENTS, MOCK_UNITS } from '../../core/data/operations.mock';
import { IncomingQuestion } from '../../core/models/operation-log';
import { Geocoding } from '../../core/services/geocoding';
import { Routing } from '../../core/services/routing';
import { IncidentStore } from '../incidents/incident-store';
import { Home } from './home';
import { OperationLogStore } from './operation-log/operation-log-store';

describe('Individual dashboard views', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        { provide: Geocoding, useValue: { geocode: vi.fn() } },
        { provide: Routing, useValue: { calculate: vi.fn().mockResolvedValue(null) } },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function question(id: string, incidentId = 'INC-001'): IncomingQuestion {
    return {
      id,
      incidentId,
      context: 'El equipo solicita instrucciones para continuar.',
      prompt: '¿Mantener la actuación actual?',
      urgency: 'high',
      input: 'options',
      options: [
        { id: 'maintain', label: 'Mantener actuación', action: { type: 'none' } },
        { id: 'coordinate', label: 'Coordinar', action: { type: 'note' } },
      ],
      defaultAnswer: { optionIds: ['maintain'], text: '', custom: false },
    };
  }

  it('opens incident details in place, zooms the existing map and returns to both widgets', async () => {
    const harness = await RouterTestingHarness.create('/');
    const element = harness.routeNativeElement!;
    const map = element.querySelector('.leaflet-container');
    const zoom = vi.spyOn(L.Map.prototype, 'setView');
    element.querySelector<HTMLAnchorElement>('.incident-row .detail-link')!.click();
    await harness.fixture.whenStable();
    const incident = MOCK_INCIDENTS.find((item) => item.id === 'INC-003')!;
    expect(TestBed.inject(Router).url).toBe('/?incidencia=INC-003');
    expect(element.querySelector('.leaflet-container')).toBe(map);
    expect(element.querySelectorAll('app-operational-map')).toHaveLength(1);
    expect(element.querySelector('.overview-widgets')?.hasAttribute('hidden')).toBe(true);
    expect(element.querySelector('.detail-heading')?.textContent).toContain('INC-003');
    expect(element.textContent).toContain('Servicios asociados');
    expect(zoom).toHaveBeenCalledWith(
      [incident.coordinates.lat, incident.coordinates.lng],
      15,
      expect.objectContaining({ animate: false }),
    );
    element.querySelector<HTMLAnchorElement>('.back-button')!.click();
    await harness.fixture.whenStable();
    expect(element.querySelector('.overview-widgets')?.hasAttribute('hidden')).toBe(false);
    expect(element.querySelector('app-incidents')).toBeNull();
    expect(element.querySelector('.leaflet-container')).toBe(map);
  });

  it('zooms on direct entry and preserves resource information and linked incident navigation', async () => {
    const zoom = vi.spyOn(L.Map.prototype, 'setView');
    const harness = await RouterTestingHarness.create('/?recurso=B-03');
    const element = harness.routeNativeElement!;
    const unit = MOCK_UNITS.find((item) => item.id === 'B-03')!;
    expect(element.querySelector('.detail-heading')?.textContent).toContain('B-03');
    expect(element.textContent).toContain('Intervenciones previas');
    expect(element.querySelectorAll('.history-list li')).toHaveLength(2);
    expect(element.querySelector('.resource-summary')?.textContent).toContain('efectivos');
    expect(zoom).toHaveBeenLastCalledWith(
      [unit.coordinates.lat, unit.coordinates.lng],
      15,
      expect.objectContaining({ animate: false }),
    );
    element.querySelector<HTMLAnchorElement>('.current-assignment')!.click();
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/?incidencia=INC-001');
    expect(element.querySelectorAll('app-operational-map')).toHaveLength(1);
  });

  it('opens details even after selecting the same marker, and ignores invalid detail IDs', async () => {
    const harness = await RouterTestingHarness.create();
    const home = await harness.navigateByUrl('/', Home);
    home.selectIncident('INC-001');
    await harness.fixture.whenStable();
    const zoom = vi.spyOn(L.Map.prototype, 'setView');
    await harness.navigateByUrl('/?incidencia=INC-001', Home);
    expect(zoom).toHaveBeenCalledWith(
      [MOCK_INCIDENTS[0].coordinates.lat, MOCK_INCIDENTS[0].coordinates.lng],
      15,
      expect.objectContaining({ animate: false }),
    );
    await harness.navigateByUrl('/?incidencia=missing', Home);
    expect(home.detail()).toBeNull();
    expect(home.selectedIncidentId()).toBeNull();
    expect(
      harness.routeNativeElement?.querySelector('.overview-widgets')?.hasAttribute('hidden'),
    ).toBe(false);
  });

  it('keeps drafts when returning to the widgets and resolves only the submitted question once', async () => {
    const harness = await RouterTestingHarness.create('/?incidencia=INC-001');
    const log = TestBed.inject(OperationLogStore);
    const answers = vi.fn();
    log.answers$.subscribe(answers);
    log.receiveQuestion(question('first'));
    log.receiveQuestion(question('second'));
    log.receiveQuestion(question('other', 'INC-002'));
    await harness.fixture.whenStable();
    const element = harness.routeNativeElement!;
    expect(element.querySelectorAll('.timeline-event.awaiting-human')).toHaveLength(2);
    expect(element.querySelector('.question-context')?.textContent).toContain(
      'solicita instrucciones',
    );
    element
      .querySelector<HTMLInputElement>('[data-question-id="first"] input[value="maintain"]')!
      .click();
    await harness.navigateByUrl('/', Home);
    await harness.navigateByUrl('/?incidencia=INC-001', Home);
    expect(
      element.querySelector<HTMLInputElement>('[data-question-id="first"] input[value="maintain"]')!
        .checked,
    ).toBe(true);
    element.querySelector<HTMLButtonElement>('[data-question-id="first"] .submit-answer')!.click();
    await harness.fixture.whenStable();
    log.submit('first');
    expect(answers).toHaveBeenCalledTimes(1);
    expect(element.querySelectorAll('.timeline-event.awaiting-human')).toHaveLength(1);
    expect(element.querySelector('[data-question-id="second"]')).not.toBeNull();
    expect(element.querySelector('[data-question-id="other"]')).toBeNull();
    expect(element.textContent).toContain('Respuesta del coordinador');
    expect(log.attention().get('INC-001')?.count).toBe(1);
  });

  it('shows associated incident questions in a resource timeline and records automatic expiry', async () => {
    const harness = await RouterTestingHarness.create('/?recurso=B-03');
    const log = TestBed.inject(OperationLogStore);
    log.receiveQuestion({ ...question('timeout'), timeoutSeconds: 5 });
    await harness.fixture.whenStable();
    expect(harness.routeNativeElement?.querySelector('.awaiting-human')).not.toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000);
    log.expireDue();
    await harness.fixture.whenStable();
    expect(harness.routeNativeElement?.querySelector('.awaiting-human')).toBeNull();
    expect(harness.routeNativeElement?.textContent).toContain(
      'Respuesta automática por vencimiento',
    );
    expect(log.questions()[0].resolution?.source).toBe('timeout');
  });

  it('opens pending actions from Responder without rendering a Registro panel', async () => {
    const harness = await RouterTestingHarness.create('/');
    const log = TestBed.inject(OperationLogStore);
    log.receiveQuestion(question('respond'));
    await harness.fixture.whenStable();
    harness.routeNativeElement?.querySelector<HTMLButtonElement>('.respond-button')!.click();
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/?incidencia=INC-001');
    expect(harness.routeNativeElement?.querySelector('app-urgent-question-card')).not.toBeNull();
    expect(harness.routeNativeElement?.querySelector('app-operation-log-panel')).toBeNull();
  });

  it('updates the live announcement after a response and clears it after the remaining question expires', async () => {
    const harness = await RouterTestingHarness.create('/');
    const log = TestBed.inject(OperationLogStore);
    const alert = () => harness.routeNativeElement?.querySelector('[role="alert"]')?.textContent;
    log.receiveQuestion({ ...question('expiring'), timeoutSeconds: 5 });
    log.receiveQuestion(question('latest', 'INC-002'));
    await harness.fixture.whenStable();
    expect(alert()).toBe('INC-002 necesita respuesta. 2 preguntas pendientes.');
    log.updateDraft(log.questions()[1], {
      optionIds: ['maintain'],
      text: '',
      custom: false,
    });
    log.submit('latest');
    await harness.fixture.whenStable();
    expect(alert()).toBe('INC-001 necesita respuesta. 1 pregunta pendiente.');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000);
    log.expireDue();
    await harness.fixture.whenStable();
    expect(alert()).toBe('');
  });

  it('keeps only account/date/time in the header and reacts to offline and event errors', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('header nav')).toBeNull();
    expect(element.querySelector('.topbar')?.textContent).toContain('Ander');
    expect(element.querySelector('.topbar .demo-indicator')).toBeNull();
    expect(element.querySelectorAll('.signal-bars .active')).toHaveLength(3);
    online.mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    await fixture.whenStable();
    expect(element.querySelector('.connection')?.textContent).toContain('Unstable connection');
    expect(element.querySelectorAll('.signal-bars .active')).toHaveLength(0);
    online.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    await fixture.whenStable();
    expect(element.querySelectorAll('.signal-bars .active')).toHaveLength(3);
    TestBed.inject(IncidentStore).updateError.set(true);
    await fixture.whenStable();
    expect(element.querySelectorAll('.signal-bars .active')).toHaveLength(1);
    fixture.destroy();
  });

  it('shows calls and vehicle/personnel assignments in chronological order', async () => {
    const harness = await RouterTestingHarness.create('/?incidencia=INC-001');
    const element = harness.routeNativeElement!;
    const entries = [...element.querySelectorAll('.timeline-event')];
    const titles = entries.map((entry) => entry.querySelector('h3')?.textContent?.trim());
    expect(titles).toContain('Llamada recibida · Central 112');
    expect(titles).toContain('Llamada realizada · B-03');
    expect(titles).toContain('Llamada recibida · B-03');
    expect(titles).toContain('Vehículo asignado · B-03');
    expect(titles).toContain('5 personas asignadas · B-03');
    expect(titles.indexOf('Llamada realizada · B-03')).toBeLessThan(
      titles.indexOf('Vehículo asignado · B-03'),
    );
    expect(titles.indexOf('Vehículo asignado · B-03')).toBeLessThan(
      titles.indexOf('5 personas asignadas · B-03'),
    );
    const times = entries.map((entry) =>
      Date.parse(entry.querySelector('time')!.getAttribute('datetime')!),
    );
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('records an approved vehicle and its crew once in the receiving incident', async () => {
    const harness = await RouterTestingHarness.create('/?incidencia=INC-001');
    const log = TestBed.inject(OperationLogStore);
    const incidents = TestBed.inject(IncidentStore);
    log.generateDemoQuestion();
    const pending = log.questions()[0];
    const option = pending.options![0];
    const action = option.action;
    if (action?.type !== 'assign-resource') throw new Error('Expected a reinforcement question');
    log.updateDraft(pending, { optionIds: [option.id], text: '', custom: false });
    log.submit(pending.id);
    log.submit(pending.id);
    await harness.fixture.whenStable();
    expect(incidents.units().find((unit) => unit.id === action.resourceId)?.incidentId).toBe(
      'INC-001',
    );
    const events = incidents
      .events()
      .filter((event) => event.incidentId === 'INC-001' && event.id.startsWith(`${pending.id}:`));
    expect(events.filter((event) => event.id.endsWith(':vehicle'))).toHaveLength(1);
    expect(events.filter((event) => event.id.endsWith(':people'))).toHaveLength(1);
    expect(events.filter((event) => event.id.endsWith(':result'))).toHaveLength(1);
    expect(harness.routeNativeElement?.textContent).toContain(
      `Vehículo asignado · ${action.resourceId}`,
    );
    expect(harness.routeNativeElement?.querySelector('.timeline-event.awaiting-human')).toBeNull();
  });

  it('uses Inicio resource fields with Localizar and keeps incident facts concise', async () => {
    const harness = await RouterTestingHarness.create('/?incidencia=INC-003');
    const element = harness.routeNativeElement!;
    const address = element.querySelector('[aria-label="Ubicación"]')!;
    expect(address.textContent?.trim()).toBe(
      MOCK_INCIDENTS.find((incident) => incident.id === 'INC-003')!.address,
    );
    expect(address.querySelector('app-icon')).toBeNull();
    const people = element.querySelector('[aria-label="Personas implicadas"]')!;
    expect(people.textContent).toContain('8 personas');
    expect(people.textContent).toContain('3 necesitan asistencia');
    expect(people.textContent).not.toMatch(/residentes|traslado/i);
    expect(people.querySelector('app-icon')).toBeNull();
    const services = element.querySelector('app-incident-activity app-service-feed')!;
    expect(services.querySelector('.heading-title app-icon')).toBeNull();
    expect(services.querySelector('.resource-agent')?.textContent).toContain('E. Gil');
    for (const field of [
      '.resource-code',
      '.resource-agent',
      '.resource-mission',
      '.incident-tag',
      '.communication-status',
    ])
      expect(services.querySelector(field)).not.toBeNull();
    const zoom = vi.spyOn(L.Map.prototype, 'setView');
    services.querySelector<HTMLButtonElement>('.locate-button')!.click();
    await harness.fixture.whenStable();
    const unit = MOCK_UNITS.find((item) => item.id === 'A-01')!;
    expect(zoom).toHaveBeenCalledWith(
      [unit.coordinates.lat, unit.coordinates.lng],
      15,
      expect.objectContaining({ animate: false }),
    );
    expect(TestBed.inject(Router).url).toBe('/?incidencia=INC-003');
    expect(element.querySelector('.detail-heading .back-button')?.textContent?.trim()).toBe('');
    expect(element.querySelector('.classification .priority')?.textContent?.trim()).toBe(
      '1 · Crítica',
    );
    await harness.navigateByUrl('/incidencias?incidencia=INC-003');
    expect(
      [...harness.routeNativeElement!.querySelectorAll('select[name="priority"] option')]
        .slice(1)
        .map((option) => option.textContent?.trim()),
    ).toEqual(['1 · Crítica', '2 · Grave', '3 · Moderada', '4 · Baja']);
  });
});

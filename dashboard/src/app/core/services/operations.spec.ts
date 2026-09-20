import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { provideRouter } from '@angular/router';
import { HumanQuestion } from '../models/operation-log';
import { IncidentStore } from '../../features/incidents/incident-store';
import { OperationLogStore } from '../../features/home/operation-log/operation-log-store';
import { OperationLogPanel } from '../../features/home/operation-log/operation-log-panel';
import { UrgentQuestionCard } from '../../features/home/operation-log/urgent-question-card';
import { WorldSnapshot } from '../models/world';
import { Operations, STREAM_FACTORY, toOperations } from './operations';

export function snapshot(version = 1): WorldSnapshot {
  return {
    version,
    generated_at: `2026-09-19T12:00:0${version}Z`,
    incident: { id: 'crisis', name: 'Incendio', started_at: '2026-09-19T11:00:00Z' },
    zones: [],
    fronts: [],
    contacts: [],
    tasks: [],
    resources: [],
    recent_actions: [],
    incoming_calls: [
      {
        run_id: 'call-1',
        timestamp: '2026-09-19T12:00:00Z',
        emergency_type: 'incendio',
        severity: 'grave',
        escalation_required: true,
        notes: 'Humo en la vivienda',
        location: {
          raw_text: 'Calle Mayor 14, Ávila',
          lat: 40.6564,
          lng: -4.7003,
          confirmed: true,
        },
        victims: { count: 2 },
      },
    ],
  };
}

class FakeStream extends EventTarget {
  close = vi.fn();
  send(type: string, value: unknown) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(value) }));
  }
}

describe('Operations API integration', () => {
  let http: HttpTestingController;
  let stream: FakeStream;
  let operations: Operations;
  beforeEach(() => {
    stream = new FakeStream();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: STREAM_FACTORY, useValue: () => stream },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    operations = TestBed.inject(Operations);
  });
  afterEach(() => {
    operations.stop();
    http.verify();
    vi.useRealTimers();
  });

  function start() {
    operations.start();
    http.expectOne('/api/v1/meta').flush({ seed_demo: false, happyrobot_mode: 'simulated' });
    http.expectOne('/api/v1/state').flush(snapshot());
  }

  it('loads real state and applies SSE snapshots without refreshing the page', () => {
    start();
    expect(operations.incidents()[0].coordinates).toEqual({ lat: 40.6564, lng: -4.7003 });
    const update = snapshot(2);
    update.incoming_calls[0].location.lat = 40.7;
    stream.send('snapshot', update);
    expect(operations.incidents()[0].coordinates?.lat).toBe(40.7);
    expect(operations.connection()).toBe('live');
    stream.send('snapshot', snapshot(1));
    expect(operations.incidents()[0].coordinates?.lat).toBe(40.7);
  });

  it('ignores older versions even if a stale backend generates a newer timestamp', () => {
    start();
    stream.send('snapshot', snapshot(3));
    const stale = snapshot(2);
    stale.generated_at = '2026-09-19T12:00:10Z';
    stream.send('snapshot', stale);
    expect(operations.snapshot()?.version).toBe(3);
    const reset = snapshot(0);
    reset.incident.started_at = '2026-09-19T12:01:00Z';
    reset.generated_at = '2026-09-19T12:01:01Z';
    stream.send('snapshot', reset);
    expect(operations.snapshot()?.version).toBe(0);
  });

  it('sends authenticated, versioned approvals without implicitly resuming the agent', async () => {
    const task = {
      id: 'proposal-1',
      title: 'Bomberos',
      zone_id: null,
      resource_ids: [],
      status: 'awaiting_approval',
      updated_at: '2026-09-19T12:00:00Z',
    };
    operations.operatorKey.set('operator-test');
    const result = operations.approve(task, true, true);
    const request = http.expectOne('/api/v1/control/tasks/proposal-1/approve');
    expect(request.request.headers.get('X-API-Key')).toBe('operator-test');
    expect(request.request.body).toEqual({
      approved: true,
      confirm_location: true,
      expected_updated_at: task.updated_at,
    });
    request.flush({ ...task, status: 'dispatching' });
    expect((await result).status).toBe('dispatching');
    http.expectNone('/api/v1/control/resume');
    http.expectNone('/api/v1/control/resume-simulated');
  });

  it('retries geocoding only as an authenticated explicit operation', async () => {
    const report = snapshot().incoming_calls[0];
    operations.operatorKey.set('operator-test');
    const result = operations.geocode(report);
    const request = http.expectOne('/api/v1/control/incoming-calls/call-1/geocode');
    expect(request.request.body).toEqual({ expected_timestamp: report.timestamp });
    expect(request.request.headers.get('X-API-Key')).toBe('operator-test');
    request.flush({ status: 'not_found' });
    await result;
  });

  it('refuses any control action without an operator key', async () => {
    const rejected = await operations.pause().then(
      () => false,
      () => true,
    );
    expect(rejected).toBe(true);
    http.expectNone('/api/v1/control/pause');
  });

  it('overrides an automatic decision by cancelling the mission', async () => {
    const task = {
      id: 'proposal-1',
      title: 'Bomberos',
      zone_id: null,
      resource_ids: [],
      status: 'dispatching',
      autonomous: true,
    };
    operations.operatorKey.set('operator-test');
    const result = operations.cancelTask(task);
    const request = http.expectOne('/api/v1/control/tasks/proposal-1/status');
    expect(request.request.body).toEqual({
      status: 'cancelled',
      outcome: 'Anulada por el operador',
    });
    request.flush({ ...task, status: 'cancelled' });
    expect((await result).status).toBe('cancelled');
  });

  it('stops the agent through the panic button', async () => {
    operations.operatorKey.set('operator-test');
    const result = operations.pause();
    const request = http.expectOne('/api/v1/control/pause');
    expect(request.request.headers.get('X-API-Key')).toBe('operator-test');
    request.flush({ mode: 'paused' });
    await result;
  });

  it('does not replace unavailable API data with fixtures', () => {
    operations.start();
    http.expectOne('/api/v1/meta').flush({}, { status: 503, statusText: 'Unavailable' });
    http.expectOne('/api/v1/state').flush({}, { status: 503, statusText: 'Unavailable' });
    expect(operations.incidents()).toEqual([]);
    expect(operations.connection()).toBe('offline');
    expect(operations.error()).toContain('API');
  });

  it('preserves the last snapshot while reconnecting and resynchronizes on demand', () => {
    start();
    stream.dispatchEvent(new Event('error'));
    expect(operations.connection()).toBe('reconnecting');
    expect(operations.incidents()).toHaveLength(1);
    stream.send('resync', {});
    http.expectOne('/api/v1/state').flush(snapshot(2));
    stream.send('snapshot', snapshot(3));
    expect(operations.connection()).toBe('live');
    operations.stop();
    expect(stream.close).toHaveBeenCalled();
  });

  it('refreshes via HTTP when the event stream is disconnected', () => {
    vi.useFakeTimers();
    start();
    stream.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(5000);
    http.expectOne('/api/v1/state').flush(snapshot(2));
    expect(operations.snapshot()?.version).toBe(2);
  });

  it('rejects malformed stream messages without losing the last valid state', () => {
    start();
    stream.send('snapshot', { version: 99 });
    expect(operations.snapshot()?.version).toBe(1);
    expect(operations.error()).toContain('inválida');
  });

  it('rejects malformed nested timeline and question data before publishing a snapshot', () => {
    start();
    for (const invalid of [
      { recent_events: [{ id: 'event', ts: 'invalid', payload: [] }] },
      { coordination_questions: [{ id: 'question', status: 'pending' }] },
      { recent_decisions: [{ id: 'decision', priorities: null }] },
      { tasks: [{ id: 'task', resource_ids: null }] },
    ]) {
      stream.send('snapshot', { ...snapshot(2), ...invalid });
      expect(operations.snapshot()?.version).toBe(1);
      expect(operations.connection()).not.toBe('live');
    }
  });

  it('retries metadata and falls back to HTTP after an invalid SSE snapshot', () => {
    vi.useFakeTimers();
    operations.start();
    http.expectOne('/api/v1/meta').flush({}, { status: 503, statusText: 'Unavailable' });
    http.expectOne('/api/v1/state').flush(snapshot());
    stream.send('snapshot', snapshot(2));
    stream.send('snapshot', { invalid: true });
    vi.advanceTimersByTime(5000);
    http.expectOne('/api/v1/meta').flush({ seed_demo: true, happyrobot_mode: 'simulated' });
    http.expectOne('/api/v1/state').flush(snapshot(3));
    expect(operations.meta()?.happyrobot_mode).toBe('simulated');
    expect(operations.snapshot()?.version).toBe(3);
  });

  it('recovers failed metadata even while the state stream stays healthy', () => {
    vi.useFakeTimers();
    operations.start();
    http.expectOne('/api/v1/meta').flush({}, { status: 503, statusText: 'Unavailable' });
    http.expectOne('/api/v1/state').flush(snapshot());
    stream.send('snapshot', snapshot(2));
    vi.advanceTimersByTime(5000);
    http.expectOne('/api/v1/meta').flush({ seed_demo: true, happyrobot_mode: 'simulated' });
    http.expectOne('/api/v1/state').flush(snapshot(3));
    expect(operations.modeLabel()).toContain('Salidas simuladas');
  });

  it('sends task versions on cancellation and priority overrides', async () => {
    const task = {
      id: 'task/version',
      title: 'Revisión',
      zone_id: null,
      resource_ids: [],
      status: 'dispatching',
      updated_at: '2026-09-19T12:00:00Z',
    };
    operations.operatorKey.set('operator-test');
    const cancellation = operations.cancelTask(task);
    const request = http.expectOne('/api/v1/control/tasks/task%2Fversion/status');
    expect(request.request.body.expected_updated_at).toBe(task.updated_at);
    request.flush({ ...task, status: 'cancelled' });
    await cancellation;
    const priority = operations.prioritizeTask(task, 90, 'Revisión');
    const update = http.expectOne('/api/v1/control/tasks/task%2Fversion/priority');
    expect(update.request.body).toEqual({
      priority: 90,
      reason: 'Revisión',
      expected_updated_at: task.updated_at,
    });
    update.flush(task);
    await priority;
  });
});

describe('World snapshot mapping', () => {
  it('labels geocoded positions as approximate and honors an operator correction', () => {
    const state = snapshot();
    state.incoming_calls[0].location = { raw_text: 'Plaza pública', confirmed: true };
    state.incoming_calls[0].resolution = {
      status: 'resolved',
      candidates: [],
      selected: { lat: 40.1, lng: -4.2, label: 'Plaza pública', kind: 'square' },
      provider: 'nominatim',
      error: '',
    };
    const data = toOperations(state);
    expect(data.incidents[0].coordinates).toEqual({ lat: 40.1, lng: -4.2 });
    expect(data.incidents[0].locationStatus).toContain('aproximada');
    state.incoming_calls[0].location.lat = 41;
    state.incoming_calls[0].location.lng = -5;
    state.incoming_calls[0].resolution.status = 'confirmed';
    expect(toOperations(state).incidents[0].coordinates).toEqual({ lat: 40.1, lng: -4.2 });
    expect(toOperations(state).incidents[0].locationStatus).toContain('operador');
  });
  it('keeps unlocated reports visible but never invents or geocodes a coordinate', () => {
    const state = snapshot();
    state.incoming_calls[0].location = { raw_text: 'Junto al río', confirmed: false };
    const data = toOperations(state);
    expect(data.incidents[0].coordinates).toBeUndefined();
    expect(data.incidents[0].status).toContain('Ubicación pendiente');
    expect(data.incidents[0].address).toBe('Junto al río');
  });

  it('distinguishes every stage of an automatic decision instead of a generic status', () => {
    const state = snapshot();
    const task = {
      id: 'intake-1',
      title: 'Automático: Bomberos',
      zone_id: null,
      resource_ids: [],
      status: 'proposed',
      autonomous: true,
      incoming_call_id: 'call-1',
      outcome: 'Sin medios o contacto compatibles y accesibles; en espera.',
    };
    state.tasks = [task];
    // Decidida pero sin unidad libre: no puede confundirse con un aviso recién recibido.
    expect(toOperations(state).incidents[0].status).toBe('Automático · sin unidad disponible');
    task.status = 'dispatching';
    expect(toOperations(state).incidents[0].status).toBe('Automático · orden preparada');
    task.status = 'dispatched';
    expect(toOperations(state).incidents[0].status).toBe('Enviada automáticamente');
    task.status = 'awaiting_approval';
    expect(toOperations(state).incidents[0].status).toBe('Modo manual · confirmar');
    // Lo que el agente no puede resolver solo se marca para destacarlo, no solo describirlo.
    expect(toOperations(state).incidents[0].alert).toBe('critical');
    state.tasks = [{ ...task, status: 'proposed', blocked_reason: 'Ubicación no resoluble' }];
    expect(toOperations(state).incidents[0].status).toContain('Bloqueada');
    expect(toOperations(state).incidents[0].alert).toBe('blocked');
    state.tasks = [{ ...task, status: 'dispatched' }];
    expect(toOperations(state).incidents[0].alert).toBeUndefined();
    state.tasks = [];
    expect(toOperations(state).incidents[0].status).toBe('Recibida');
  });

  it.each([
    ['accepted', 'Aceptada por el recurso'],
    ['in_progress', 'En curso'],
    ['done', 'Finalizada'],
    ['rejected', 'Rechazada'],
    ['cancelled', 'Cancelada'],
    ['failed', 'Fallida'],
    ['custom-status', 'custom-status'],
  ])('preserves the %s task status on an incident', (status, label) => {
    const state = snapshot();
    state.tasks = [
      {
        id: 'intake-1',
        title: 'Bomberos',
        zone_id: null,
        resource_ids: [],
        status,
        incoming_call_id: 'call-1',
      },
    ];
    expect(toOperations(state).incidents[0].status).toBe(label);
  });

  it('prefers an active task over a cancelled task with an obsolete location block', () => {
    const state = snapshot();
    const task = {
      id: 'intake-1',
      title: 'Bomberos',
      zone_id: null,
      resource_ids: [],
      status: 'accepted',
      incoming_call_id: 'call-1',
    };
    state.tasks = [
      { ...task, id: 'old-task', status: 'cancelled', blocked_reason: 'Ubicación no resoluble' },
      task,
    ];
    expect(toOperations(state).incidents[0].status).toBe('Aceptada por el recurso');
  });

  it('does not treat an unconfirmed coordinate or a null coordinate as a confirmed location', () => {
    const state = snapshot();
    state.incoming_calls[0].location.confirmed = false;
    expect(toOperations(state).incidents[0].coordinates).toBeUndefined();
    state.incoming_calls[0].location = { lat: null, lng: null, confirmed: true };
    expect(toOperations(state).incidents[0].coordinates).toBeUndefined();
  });

  it('does not conflate resources, dispatch acknowledgement and delivery', () => {
    const state = snapshot();
    state.resources = [
      {
        id: 'res-1',
        name: 'Ambulancia 1',
        type: 'ambulance',
        status: 'reserved',
        location: { lat: 40.6, lng: -4.7, label: 'Base' },
        assigned_task_id: 'task-1',
        assigned_zone_id: 'zone-1',
        contact_id: 'contact-1',
        reported_at: null,
      },
    ];
    state.tasks = [
      {
        id: 'task-1',
        title: 'Acudir al aviso',
        zone_id: 'zone-1',
        resource_ids: ['res-1'],
        status: 'dispatched',
      },
    ];
    state.recent_actions = [
      {
        id: 'act-1',
        task_id: 'task-1',
        contact_id: 'contact-1',
        kind: 'call',
        status: 'dispatched',
        summary: 'Llamada enviada; pendiente de respuesta',
        ts: '2026-09-19T12:00:00Z',
        result: {},
      },
    ];
    const data = toOperations(state);
    expect(data.units[0].id).toBe('res-1');
    expect(data.units[0].route).toBeUndefined();
    expect(data.communications[0].vehicle).toBe('res-1');
    expect(data.communications[0].status).toBe('Reservado');
    expect(data.communications[0].message).toContain('pendiente');
  });
});

function question(
  id: string,
  sequence: number,
  urgency: HumanQuestion['urgency'] = 'high',
): HumanQuestion {
  return {
    id,
    sequence,
    incidentId: 'call:call-1',
    prompt: '¿Mantener la coordinación?',
    urgency,
    input: 'mixed',
    options: [{ id: 'maintain', label: 'Mantener', action: { type: 'none' } }],
    defaultAnswer: { custom: false, optionIds: ['maintain'], text: '' },
    receivedAt: '2026-09-19T12:00:00Z',
    expiresAt: '2026-09-19T12:02:00Z',
    status: 'pending',
  };
}

describe('Backend-backed incident and coordination stores', () => {
  let operations: Operations;
  let http: HttpTestingController;
  let stream: FakeStream;
  beforeEach(() => {
    stream = new FakeStream();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: STREAM_FACTORY, useValue: () => stream },
      ],
    });
    operations = TestBed.inject(Operations);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    operations.stop();
    http.verify();
    vi.useRealTimers();
  });
  function setup(state = snapshot()) {
    const log = TestBed.inject(OperationLogStore);
    log.start();
    http.expectOne('/api/v1/meta').flush({ seed_demo: true, happyrobot_mode: 'simulated' });
    http.expectOne('/api/v1/state').flush(state);
    return log;
  }

  it('never starts a mock catalog or fabricated log while the API is unavailable', () => {
    const log = TestBed.inject(OperationLogStore);
    http.expectOne('/api/v1/meta').flush({}, { status: 503, statusText: 'Unavailable' });
    http.expectOne('/api/v1/state').flush({}, { status: 503, statusText: 'Unavailable' });
    expect(log.incidents.incidents()).toEqual([]);
    expect(log.incidents.units()).toEqual([]);
    expect(log.history()).toEqual([]);
    expect(log.pending()).toEqual([]);
  });

  it('shares Web Call reports, task decisions and correlated HappyRobot activity', () => {
    const state = snapshot();
    state.tasks = [
      {
        id: 'vital',
        title: 'Asistencia crítica',
        status: 'awaiting_approval',
        incoming_call_id: 'call-1',
        zone_id: null,
        resource_ids: [],
        requires_approval: true,
        updated_at: state.generated_at,
      },
    ];
    state.recent_actions = [
      {
        id: 'telegram',
        ts: state.generated_at,
        kind: 'telegram',
        status: 'dispatched',
        task_id: null,
        contact_id: null,
        request: { task_id: 'vital' },
        workflow: 'send_telegram',
        summary: 'Aviso de escalado',
        result: {},
      },
    ];
    const log = setup(state);
    const store = TestBed.inject(IncidentStore);
    expect(store.incidents()[0].id).toBe(operations.incidents()[0].id);
    expect(store.details()['call:call-1'].affected).toBe(2);
    expect(log.pendingCount()).toBe(1);
    log.openForIncident('call:call-1');
    expect(log.view()).toBe('missions');
    expect(
      log
        .history()
        .some(
          (event) =>
            event.id === 'action:telegram' && event.description.includes('resultado pendiente'),
        ),
    ).toBe(true);
    const update = {
      ...state,
      version: 2,
      generated_at: '2026-09-19T12:00:02Z',
      incoming_calls: [
        { ...state.incoming_calls[0], notes: 'Aviso corregido', victims: { count: 3 } },
      ],
    };
    stream.send('snapshot', update);
    expect(store.details()['call:call-1'].affected).toBe(3);
    expect(store.incidents()[0].description).toContain('Aviso corregido');
  });

  it('keeps a resource conflict actionable without a deadline and highlights both incidents', () => {
    const state = snapshot();
    state.incoming_calls.push({ ...state.incoming_calls[0], run_id: 'call-2' });
    state.tasks = ['call-1', 'call-2'].map((id) => ({
      id: `task:${id}`,
      incoming_call_id: id,
      title: 'Ambulancia',
      zone_id: null,
      status: 'proposed',
      resource_ids: [],
      autonomous: true,
      requires_approval: false,
    }));
    const conflict: HumanQuestion = {
      ...question('allocation', 1, 'critical'),
      input: 'options',
      expiresAt: null,
      allocationResourceId: 'res-1',
      allocationTaskIds: state.tasks.map((task) => task.id),
      options: [
        { id: 'first', label: 'Atender el primer incidente' },
        { id: 'second', label: 'Atender el segundo incidente' },
      ],
    };
    state.coordination_questions = [conflict];
    const log = setup(state);
    expect(operations.snapshot()?.coordination_questions?.[0].expiresAt).toBeNull();
    expect(log.pendingCount()).toBe(1);
    expect(log.attention().get('call:call-1')?.urgency).toBe('critical');
    expect(log.attention().get('call:call-2')?.urgency).toBe('critical');
    log.openForIncident('call:call-2');
    expect(log.visiblePending()).toEqual([conflict]);
    expect(operations.incidents().every((incident) => incident.alert === 'critical')).toBe(true);
    expect(operations.incidents()[0].status).toContain('elegir destino');
    expect(
      toOperations({
        ...state,
        coordination_questions: [{ ...conflict, allocationResourceId: null }],
      }).incidents[0].status,
    ).toContain('sin medios compatibles');
    operations.operatorKey.set('operator-test');
    operations.now.set(Date.parse('2027-01-01T00:00:00Z'));
    log.updateDraft(conflict, { custom: false, text: '', optionIds: ['second'] });
    const fixture = TestBed.createComponent(UrgentQuestionCard);
    fixture.componentRef.setInput('question', conflict);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('sin caducidad');
    expect(element.textContent).not.toContain('Al vencer el plazo');
    expect(element.querySelector('time')).toBeNull();
    expect(element.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    expect(log.pendingCount()).toBe(1);
    http.expectNone((request) => request.method === 'POST');
    fixture.destroy();
  });

  it('does not require approval because an autonomous report is vital or requests escalation', () => {
    const state = snapshot();
    state.incoming_calls[0].severity = 'vital';
    state.tasks = ['fire_engine', 'ambulance', 'police_unit'].map((type) => ({
      id: type,
      title: type,
      incoming_call_id: 'call-1',
      zone_id: null,
      status: 'dispatching',
      resource_ids: [type],
      autonomous: true,
      requires_approval: false,
    }));
    const log = setup(state);
    expect(log.pendingCount()).toBe(0);
    expect(operations.incidents()[0].alert).toBeUndefined();
    expect(operations.incidents()[0].description).not.toContain('Requiere revisión');
  });

  it('keeps questions FIFO and uses highest urgency for incident attention without browser-side timeouts', () => {
    vi.useFakeTimers();
    const state = snapshot();
    state.coordination_questions = [question('later', 2, 'critical'), question('first', 1)];
    const log = setup(state);
    expect(log.pending().map((item) => item.id)).toEqual(['first', 'later']);
    expect(log.attention().get('call:call-1')).toMatchObject({ urgency: 'critical', count: 2 });
    operations.now.set(Date.parse('2026-09-19T13:00:00Z'));
    expect(log.pending()).toHaveLength(2);
    expect(operations.snapshot()?.tasks).toEqual([]);
    http.expectNone((request) => request.method === 'POST');
  });

  it('authenticates answers, preserves drafts on failure and prevents duplicate submissions', async () => {
    const state = snapshot();
    const first = question('first', 1),
      second = question('second', 2);
    state.coordination_questions = [first, second];
    const log = setup(state);
    const answer = { custom: true, optionIds: [], text: 'Revisar el acceso' };
    log.updateDraft(first, answer);
    await log.submit(first.id);
    expect(log.errors()[first.id]).toContain('clave');
    expect(log.draft(first)).toEqual(answer);
    http.expectNone('/api/v1/control/questions/first/answer');
    operations.operatorKey.set('operator-test');
    const pending = log.submit(first.id);
    await log.submit(first.id);
    const request = http.expectOne('/api/v1/control/questions/first/answer');
    expect(request.request.headers.get('X-API-Key')).toBe('operator-test');
    expect(request.request.body).toEqual(answer);
    request.flush({}, { status: 409, statusText: 'Conflict' });
    await pending;
    expect(log.draft(first)).toEqual(answer);
    const retry = log.submit(first.id);
    const resolved: HumanQuestion = {
      ...first,
      status: 'resolved',
      resolution: {
        questionId: first.id,
        incidentId: first.incidentId,
        idempotencyKey: first.id,
        answer,
        answerLabel: answer.text,
        source: 'human',
        answeredAt: '2026-09-19T12:01:00Z',
        outcome: 'Nota guardada',
        applied: true,
      },
    };
    http.expectOne('/api/v1/control/questions/first/answer').flush(resolved);
    await retry;
    http.expectOne('/api/v1/state').flush({
      ...state,
      version: 2,
      generated_at: '2026-09-19T12:01:00Z',
      coordination_questions: [resolved, second],
    });
    expect(log.pending().map((item) => item.id)).toEqual(['second']);
    expect(log.attention().get('call:call-1')?.count).toBe(1);
    expect(log.drafts()[first.id]).toBeUndefined();
  });

  it('uses server resolution across clients and resets transient state for a new incident run', async () => {
    const state = snapshot();
    const first = question('first', 1);
    state.coordination_questions = [first];
    const log = setup(state);
    log.updateDraft(first, { custom: true, text: 'Borrador', optionIds: [] });
    stream.send('snapshot', {
      ...state,
      version: 2,
      generated_at: '2026-09-19T12:00:02Z',
      coordination_questions: [{ ...first, status: 'resolved' }],
    });
    expect(log.pending()).toEqual([]);
    TestBed.tick();
    const reset = snapshot(3);
    reset.incident.started_at = '2026-09-19T12:00:03Z';
    stream.send('snapshot', reset);
    TestBed.tick();
    expect(log.drafts()).toEqual({});
    expect(log.incidentFilter()).toBeNull();
  });

  it('does not insert a delayed answer into a different incident run', async () => {
    const state = snapshot();
    const first = question('late', 1);
    state.coordination_questions = [first];
    const log = setup(state);
    operations.operatorKey.set('operator-test');
    log.updateDraft(first, { custom: false, text: '', optionIds: ['maintain'] });
    const pending = log.submit(first.id);
    const request = http.expectOne('/api/v1/control/questions/late/answer');
    const reset = snapshot(2);
    reset.incident.started_at = '2026-09-19T12:00:02Z';
    stream.send('snapshot', reset);
    TestBed.tick();
    request.flush({ ...first, status: 'resolved' });
    await pending;
    http.match('/api/v1/state').forEach((request) => request.flush(reset));
    expect(log.questions()).toEqual([]);
  });

  it('renders missions, communication outcomes and system metadata without exposing raw requests', async () => {
    const state = snapshot();
    state.agent = {
      mode: 'paused',
      autonomous: true,
      hold_seconds: 10,
      approval_required_for: ['evacuate_zone'],
    };
    state.tasks = [
      {
        id: 'evacuation',
        title: 'Evacuación crítica',
        zone_id: null,
        resource_ids: [],
        status: 'awaiting_approval',
        requires_approval: true,
      },
    ];
    state.recent_actions = [
      {
        id: 'call',
        ts: state.generated_at,
        kind: 'call',
        status: 'unknown',
        task_id: null,
        contact_id: null,
        summary: 'Llamada pendiente de verificar',
        happyrobot_run_id: 'run-test',
        result: { webhook: { summary: 'Sin confirmar', transcript: 'Parte de prueba' } },
      },
    ];
    const log = setup(state);
    const fixture = TestBed.createComponent(OperationLogPanel);
    log.view.set('missions');
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Evacuación crítica');
    expect(element.querySelector('[data-task-id="evacuation"] input[type="checkbox"]')).toBeNull();
    log.view.set('communications');
    await fixture.whenStable();
    expect(element.textContent).toContain('Resultado desconocido');
    expect(element.textContent).toContain('run-test');
    log.view.set('system');
    await fixture.whenStable();
    expect(element.textContent).toContain('Parada activa');
    expect(element.textContent).toContain('Salidas simuladas');
  });
});

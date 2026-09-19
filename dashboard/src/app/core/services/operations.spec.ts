import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
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
    expect(toOperations(state).incidents[0].status).toBe('CRÍTICO · confirmar');
    state.tasks = [{ ...task, status: 'proposed', blocked_reason: 'Ubicación no resoluble' }];
    expect(toOperations(state).incidents[0].status).toContain('Bloqueada');
    state.tasks = [];
    expect(toOperations(state).incidents[0].status).toBe('Recibida');
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

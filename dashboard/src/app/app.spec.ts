import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import { App } from './app';
import { WorldSnapshot } from './core/models/world';
import { Operations, STREAM_FACTORY } from './core/services/operations';

const state = (): WorldSnapshot => ({
  version: 1,
  generated_at: new Date().toISOString(),
  incident: { id: 'test', name: 'Crisis', started_at: '2026-09-19T12:00:00Z' },
  incoming_calls: [],
  zones: [],
  fronts: [],
  resources: [],
  contacts: [],
  tasks: [],
  recent_actions: [],
  agent: { mode: 'paused', autonomous: true },
});

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: STREAM_FACTORY, useValue: () => null },
      ],
    }).compileComponents();
  });
  afterEach(() => {
    TestBed.inject(Operations).stop();
    TestBed.inject(HttpTestingController).verify();
    vi.useRealTimers();
  });

  function setup() {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/v1/meta').flush({ seed_demo: true, happyrobot_mode: 'simulated' });
    http.expectOne('/api/v1/state').flush(state());
    return fixture;
  }

  it('creates the dashboard shell', () => {
    expect(setup().componentInstance).toBeTruthy();
  });

  it('updates date across midnight using the shared Operations clock and cleans it up', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date(2026, 8, 19, 23, 59, 59));
    const fixture = setup();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.clock')?.textContent).toBe('23:59');
    await vi.advanceTimersByTimeAsync(1000);
    await fixture.whenStable();
    expect(element.querySelector('.clock')?.textContent).toBe('00:00');
    expect(element.querySelector('time')?.getAttribute('datetime')).toBe(
      new Date(2026, 8, 20).toISOString(),
    );
    fixture.destroy();
    TestBed.inject(Operations).stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enables implemented routes and the operational log without removing the emergency controls', async () => {
    const fixture = setup();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('nav a')?.textContent).toContain('Inicio');
    expect(element.querySelector('nav a[href="/incidencias"]')?.textContent).toContain(
      'Incidencias',
    );
    expect(element.querySelector('nav a[href="/recursos"]')?.textContent).toContain('Recursos');
    expect(element.querySelector<HTMLButtonElement>('#log-toggle')?.disabled).toBe(false);
    expect(element.querySelector('.autonomy-state')?.textContent).toContain('DETENIDA');
    expect(element.querySelector<HTMLButtonElement>('.panic')?.disabled).toBe(true);
    expect(element.querySelector('main router-outlet')).not.toBeNull();
    expect(element.textContent).not.toContain('Congratulations');
  });

  it('keeps the operator key in memory only and sends an authenticated emergency stop', async () => {
    const fixture = setup();
    const operations = TestBed.inject(Operations);
    operations.snapshot.update((snapshot) => ({
      ...snapshot!,
      agent: { mode: 'running', autonomous: true },
    }));
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const input = element.querySelector<HTMLInputElement>('input[type="password"]')!;
    input.value = 'isolated-operator';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(operations.operatorKey()).toBe('isolated-operator');
    expect(Object.values(localStorage)).not.toContain('isolated-operator');
    expect(Object.values(sessionStorage)).not.toContain('isolated-operator');
    element.querySelector<HTMLButtonElement>('.panic')!.click();
    const http = TestBed.inject(HttpTestingController);
    const request = http.expectOne('/api/v1/control/pause');
    expect(request.request.headers.get('X-API-Key')).toBe('isolated-operator');
    request.flush({ mode: 'paused' });
    await fixture.whenStable();
    http.expectOne('/api/v1/state').flush(state());
  });
});

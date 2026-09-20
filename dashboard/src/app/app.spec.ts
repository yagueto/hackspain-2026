import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { vi } from 'vitest';
import { App } from './app';
import { routes } from './app.routes';
import { Geocoding } from './core/services/geocoding';
import { Routing } from './core/services/routing';
import { OperationLogStore } from './features/home/operation-log/operation-log-store';
import { IncidentStore } from './features/incidents/incident-store';

describe('App', () => {
  beforeEach(async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter(routes),
        { provide: Geocoding, useValue: { geocode: vi.fn() } },
        { provide: Routing, useValue: { calculate: vi.fn().mockResolvedValue(null) } },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('advances once per Space press, prevents scrolling and no longer reacts to M', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const advance = vi
      .spyOn(TestBed.inject(OperationLogStore), 'advanceDemo')
      .mockReturnValue(null);
    for (const key of ['m', 'M']) window.dispatchEvent(new KeyboardEvent('keydown', { key }));
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey', 'isComposing']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', [modifier]: true }));
    }
    const handled = new KeyboardEvent('keydown', { key: ' ', cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    expect(advance).not.toHaveBeenCalled();
    const press = new KeyboardEvent('keydown', { key: ' ', cancelable: true });
    window.dispatchEvent(press);
    expect(advance).toHaveBeenCalledTimes(1);
    expect(press.defaultPrevented).toBe(true);
    const held = new KeyboardEvent('keydown', { key: ' ', repeat: true, cancelable: true });
    window.dispatchEvent(held);
    expect(held.defaultPrevented).toBe(true);
    expect(advance).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    expect(advance).toHaveBeenCalledTimes(2);
  });

  it('captures Space on focused controls to advance without activating or editing them', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const advance = vi
      .spyOn(TestBed.inject(OperationLogStore), 'advanceDemo')
      .mockReturnValue(null);
    const controlKey = vi.fn();
    let presses = 0;
    for (const html of [
      '<input>',
      '<input type="radio">',
      '<input type="checkbox">',
      '<input type="button">',
      '<textarea></textarea>',
      '<select><option>Una opción</option></select>',
      '<button><span>Enviar</span></button>',
      '<details><summary>Más</summary></details>',
      '<div contenteditable="true"><span>Editar</span></div>',
      '<div role="button"><span>Acción</span></div>',
      '<div role="slider" tabindex="0"></div>',
    ]) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = html;
      fixture.nativeElement.append(wrapper);
      const target = wrapper.querySelector('span, summary') ?? wrapper.firstElementChild!;
      target.addEventListener('keydown', controlKey);
      target.addEventListener('keyup', controlKey);
      const press = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
      const release = new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true });
      target.dispatchEvent(press);
      target.dispatchEvent(release);
      expect(press.defaultPrevented).toBe(true);
      expect(release.defaultPrevented).toBe(true);
      expect(advance).toHaveBeenCalledTimes(++presses);
    }
    expect(controlKey).not.toHaveBeenCalled();
    fixture.destroy();
    const afterDestroy = new KeyboardEvent('keydown', { key: ' ', cancelable: true });
    window.dispatchEvent(afterDestroy);
    expect(afterDestroy.defaultPrevented).toBe(false);
    expect(advance).toHaveBeenCalledTimes(presses);
  });

  it.each([
    '/?incidencia=INC-001',
    '/?recurso=B-03',
    '/incidencias?incidencia=INC-001',
    '/recursos?recurso=B-03',
  ])('returns to the overview from %s through the logo without resetting the demo', async (url) => {
    const fixture = TestBed.createComponent(App);
    const log = TestBed.inject(OperationLogStore);
    log.advanceDemo();
    log.advanceDemo();
    const store = TestBed.inject(IncidentStore);
    const incidents = store.incidents();
    const units = store.units();
    const router = TestBed.inject(Router);
    await router.navigateByUrl(url);
    await fixture.whenStable();
    fixture.nativeElement.querySelector('.brand')!.click();
    await fixture.whenStable();
    expect(router.url).toBe('/');
    expect(fixture.nativeElement.querySelector('app-home')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-incidents, app-resources')).toBeNull();
    expect(fixture.nativeElement.querySelector('.overview-widgets')?.hasAttribute('hidden')).toBe(
      false,
    );
    expect(store.incidents()).toBe(incidents);
    expect(store.units()).toBe(units);
  });

  it('shows a dismissible mockup notice with the Space shortcut', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.demo-notice')?.textContent).toContain('fines ilustrativos');
    expect(element.querySelector('.demo-notice kbd')?.textContent).toBe('Espacio');
    expect(element.querySelector('.demo-notice')?.textContent).toContain('ficticios');
    element.querySelector<HTMLButtonElement>('.demo-notice-close')!.click();
    await fixture.whenStable();
    expect(element.querySelector('.demo-notice')).toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(TestBed.inject(IncidentStore).incidents()).toHaveLength(3);
  });

  it.each([
    '/',
    '/?incidencia=INC-004',
    '/?recurso=B-03',
    '/incidencias?incidencia=INC-008',
    '/recursos?recurso=B-03',
  ])('advances all Space steps without leaving the current view %s', async (url) => {
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    const store = TestBed.inject(IncidentStore);
    const log = TestBed.inject(OperationLogStore);
    await router.navigateByUrl(url);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const view = element.querySelector('main router-outlet')?.nextElementSibling;
    const heading = element.querySelector('.detail-heading h2')?.textContent;
    for (const count of [3, 3, 4, 5]) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
      await fixture.whenStable();
      expect(store.incidents()).toHaveLength(count);
      expect(router.url).toBe(url);
      expect(element.querySelector('main router-outlet')?.nextElementSibling).toBe(view);
      expect(element.querySelector('.detail-heading h2')?.textContent).toBe(heading);
      if (url === '/') {
        expect(element.querySelector('app-incidents, app-resources')).toBeNull();
        expect(element.querySelector('.overview-widgets')?.hasAttribute('hidden')).toBe(false);
      }
    }
    expect(log.pending()).toHaveLength(1);
    expect(store.units().find((unit) => unit.id === 'B-03')?.incidentId).toBe('INC-001');
  });

  it.each([
    ['alternative', 'Producción parcial recuperada'],
    ['repair', 'Línea principal en reparación · Producción detenida'],
  ])(
    'runs all Space steps with the redesigned detail view and the %s decision',
    async (option, status) => {
      const fixture = TestBed.createComponent(App);
      const router = TestBed.inject(Router);
      const store = TestBed.inject(IncidentStore);
      const log = TestBed.inject(OperationLogStore);
      await router.navigateByUrl('/recursos');
      await fixture.whenStable();
      expect(store.incidents()).toHaveLength(2);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
      await fixture.whenStable();
      expect(router.url).toBe('/recursos');
      expect(store.units().find((unit) => unit.id === 'B-03')?.incidentId).toBeUndefined();
      expect(store.events().some((event) => event.id === 'demo:coordination')).toBe(false);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
      await fixture.whenStable();
      expect(router.url).toBe('/recursos');
      expect(store.incidents()).toHaveLength(3);
      expect(store.units().find((unit) => unit.id === 'B-03')?.incidentId).toBe('INC-001');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
      await fixture.whenStable();
      expect(router.url).toBe('/recursos');
      await router.navigateByUrl('/?incidencia=INC-002');
      await fixture.whenStable();
      const element = fixture.nativeElement as HTMLElement;
      expect(element.querySelectorAll('app-operational-map')).toHaveLength(1);
      expect(element.querySelector('app-operation-log-panel')).toBeNull();
      expect(
        element.querySelector('app-operation-timeline app-urgent-question-card'),
      ).not.toBeNull();
      element.querySelector<HTMLInputElement>(`input[value="${option}"]`)!.click();
      await fixture.whenStable();
      element.querySelector<HTMLButtonElement>('.submit-answer')!.click();
      await fixture.whenStable();
      expect(store.incidents().find((incident) => incident.id === 'INC-002')?.status).toBe(status);
      expect(element.querySelector('app-urgent-question-card')).toBeNull();
      expect(element.textContent).toContain('Respuesta del coordinador');
      expect(log.pending()).toHaveLength(0);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
      await fixture.whenStable();
      expect(router.url).toBe('/?incidencia=INC-002');
      expect(store.units().find((unit) => unit.id === 'B-03')?.incidentId).toBe('INC-001');
      await router.navigateByUrl('/?incidencia=INC-003');
      await fixture.whenStable();
      for (let step = 0; step < 5; step++) {
        expect(element.querySelector('[data-event-id="INC-003:assigned:B-03"]')).toBeNull();
        expect(store.units().find((unit) => unit.id === 'B-03')?.incidentId).toBe('INC-001');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
        await fixture.whenStable();
        expect(router.url).toBe('/?incidencia=INC-003');
      }
      expect(element.querySelector('[data-event-id="INC-003:assigned:B-03"]')).not.toBeNull();
      expect(store.units().find((unit) => unit.id === 'B-03')?.incidentId).toBe('INC-003');
      expect(store.units().find((unit) => unit.id === 'A-01')?.incidentId).toBe('INC-001');
      expect(store.incidents()).toHaveLength(5);
      await router.navigateByUrl('/?recurso=B-03');
      await fixture.whenStable();
      expect(element.querySelector('.history-list')?.textContent).toContain('INC-001');
      expect(element.querySelector('.current-assignment')?.textContent).toContain('INC-003');
      const count = store.events().length;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
      await fixture.whenStable();
      expect(store.events()).toHaveLength(count);
      expect(router.url).toBe('/?recurso=B-03');
    },
  );

  it('creates the dashboard shell', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('updates the header date and time across midnight and cleans up its clock', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date(2026, 8, 19, 23, 59, 59));
    const fixture = TestBed.createComponent(App);
    try {
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
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });

  it('renders the updated CrisisOS shell without the old navigation or log panel', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.brand')?.textContent).toBe('CrisisOS');
    expect(element.querySelector('header nav')).toBeNull();
    expect(element.querySelector('.theme-toggle')).not.toBeNull();
    expect(element.querySelector('app-operation-log-panel')).toBeNull();
    expect(element.querySelector('main router-outlet')).not.toBeNull();
    expect(element.textContent).not.toContain('Congratulations');
  });
});

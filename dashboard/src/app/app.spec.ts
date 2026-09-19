import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([])],
    }).compileComponents();
  });

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

  it('renders navigation and keeps future sections disabled', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('nav a')?.textContent).toContain('Inicio');
    expect(element.querySelectorAll('nav button:disabled').length).toBe(3);
    expect(element.querySelector('main router-outlet')).not.toBeNull();
    expect(element.textContent).not.toContain('Congratulations');
  });
});

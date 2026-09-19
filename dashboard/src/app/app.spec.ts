import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
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

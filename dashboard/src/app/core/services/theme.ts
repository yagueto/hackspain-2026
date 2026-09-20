import { DOCUMENT } from '@angular/common';
import { inject, Injectable, signal } from '@angular/core';

export type ThemeName = 'light' | 'dark';

@Injectable({ providedIn: 'root' })
export class Theme {
  private readonly document = inject(DOCUMENT);
  private readonly state = signal<ThemeName>('light');
  readonly current = this.state.asReadonly();

  constructor() {
    let initial: ThemeName = 'light';
    try {
      const saved = this.document.defaultView?.localStorage.getItem('dashboard-theme');
      if (saved === 'dark' || saved === 'light') initial = saved;
    } catch {
      // Storage may be unavailable in private or embedded browsers.
    }
    this.set(initial);
  }

  set(theme: ThemeName): void {
    this.state.set(theme);
    this.document.documentElement.dataset['theme'] = theme;
    try {
      this.document.defaultView?.localStorage.setItem('dashboard-theme', theme);
    } catch {
      // The theme still applies when storage is unavailable.
    }
  }

  toggle(): void {
    this.set(this.current() === 'dark' ? 'light' : 'dark');
  }
}

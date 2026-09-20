import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { Header } from './layout/header/header';
import { OperationLogStore } from './features/home/operation-log/operation-log-store';
import { OperationLogPanel } from './features/home/operation-log/operation-log-panel';

@Component({
  imports: [RouterOutlet, Header, OperationLogPanel],
  selector: 'app-root',
  host: { '(window:keydown)': 'handleKeyboard($event)' },
  styleUrl: './app.css',
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly log = inject(OperationLogStore);
  private readonly router = inject(Router);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  protected readonly outsideHome = computed(() => this.url().split(/[?#]/)[0] !== '/');

  constructor() {
    effect((onCleanup) => {
      if (!this.outsideHome() || !this.log.open()) return;
      const previous = document.body.style.overflow;
      const focused = document.activeElement;
      document.body.style.overflow = 'hidden';
      onCleanup(() => {
        document.body.style.overflow = previous;
        if (focused instanceof HTMLElement && focused.isConnected)
          focused.focus({ preventScroll: true });
      });
    });
  }

  protected handleKeyboard(event: KeyboardEvent): void {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.key.toLowerCase() !== 'm'
    )
      return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.closest(
          'textarea, input:not([type="radio"]):not([type="checkbox"]):not([type="button"]):not([type="submit"]), [contenteditable="true"], [role="textbox"]',
        ))
    )
      return;
    event.preventDefault();
    this.log.advanceDemo();
  }
}

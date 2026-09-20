import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Header } from './layout/header/header';
import { Connection } from './core/services/connection';
import { OperationLogStore } from './features/home/operation-log/operation-log-store';
import { Icon } from './shared/icon/icon';

@Component({
  imports: [RouterOutlet, Header, Icon],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly connection = inject(Connection);
  private readonly log = inject(OperationLogStore);
  protected readonly demoNoticeOpen = signal(true);

  constructor() {
    const handleKeyboard = (event: KeyboardEvent) => this.handleKeyboard(event);
    window.addEventListener('keydown', handleKeyboard, true);
    window.addEventListener('keyup', handleKeyboard, true);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('keydown', handleKeyboard, true);
      window.removeEventListener('keyup', handleKeyboard, true);
    });
  }

  protected handleKeyboard(event: KeyboardEvent): void {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey ||
      (event.key !== ' ' && event.code !== 'Space')
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type === 'keydown' && !event.repeat) this.log.advanceDemo();
  }
}

import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { Icon } from '../../shared/icon/icon';
import { Theme } from '../../core/services/theme';

@Component({
  selector: 'app-header',
  imports: [Icon],
  templateUrl: './header.html',
  styleUrl: './header.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Header {
  protected readonly theme = inject(Theme);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dateFormatter = new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  private readonly timeFormatter = new Intl.DateTimeFormat('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  private readonly compactDateFormatter = new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: '2-digit',
  });
  protected readonly now = signal(new Date());
  protected readonly date = computed(() => this.dateFormatter.format(this.now()));
  protected readonly time = computed(() => this.timeFormatter.format(this.now()));
  protected readonly compactDate = computed(() => this.compactDateFormatter.format(this.now()));

  constructor() {
    afterNextRender(() => {
      const timer = setInterval(() => this.now.set(new Date()), 1000);
      this.destroyRef.onDestroy(() => clearInterval(timer));
    });
  }
}

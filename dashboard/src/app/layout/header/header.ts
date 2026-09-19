import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { Icon } from '../../shared/icon/icon';
import { Theme } from '../../core/services/theme';
import { OperationLogStore } from '../../features/home/operation-log/operation-log-store';

@Component({
  selector: 'app-header',
  imports: [RouterLink, RouterLinkActive, Icon],
  templateUrl: './header.html',
  styleUrl: './header.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Header {
  protected readonly navigation = [
    { label: 'Inicio', path: '/', available: true },
    { label: 'Incidencias', path: '/incidencias', available: true },
    { label: 'Recursos', path: '/recursos', available: true },
  ];
  protected readonly theme = inject(Theme);
  protected readonly log = inject(OperationLogStore);
  private readonly router = inject(Router);
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
  protected readonly now = signal(new Date());
  protected readonly date = computed(() => this.dateFormatter.format(this.now()));
  protected readonly time = computed(() => this.timeFormatter.format(this.now()));

  constructor() {
    afterNextRender(() => {
      const timer = setInterval(() => this.now.set(new Date()), 1000);
      this.destroyRef.onDestroy(() => clearInterval(timer));
    });
  }

  protected async openLog(): Promise<void> {
    await this.router.navigate(['/']);
    this.log.open.set(!this.log.open());
  }
}

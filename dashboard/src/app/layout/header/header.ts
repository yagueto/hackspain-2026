import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { Icon } from '../../shared/icon/icon';
import { Operations } from '../../core/services/operations';

@Component({
  selector: 'app-header',
  imports: [RouterLink, RouterLinkActive, Icon],
  templateUrl: './header.html',
  styleUrl: './header.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Header {
  protected readonly operations = inject(Operations);
  protected readonly paused = this.operations.paused;
  protected readonly busy = signal(false);
  protected readonly message = signal('');
  protected readonly navigation = [
    { label: 'Inicio', path: '/', available: true },
    { label: 'Incidencias', path: '/incidencias', available: false },
    { label: 'Recursos', path: '/recursos', available: false },
    { label: 'Logs', path: '/logs', available: false },
  ];
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

  async toggleAutonomy(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.message.set('');
    const stopping = !this.paused();
    try {
      await (stopping ? this.operations.pause() : this.operations.resume());
      this.operations.refresh();
    } catch (error) {
      this.message.set(
        error instanceof HttpErrorResponse && error.status === 401
          ? 'Clave de operador incorrecta.'
          : stopping
            ? 'No se pudo detener el agente. Compruébalo antes de confiar en la parada.'
            : 'No se pudo reactivar la autonomía.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}

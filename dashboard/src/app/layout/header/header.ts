import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { Icon } from '../../shared/icon/icon';
import { Operations } from '../../core/services/operations';
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
  protected readonly operations = inject(Operations);
  protected readonly paused = this.operations.paused;
  protected readonly busy = signal(false);
  protected readonly message = signal('');
  protected readonly navigation = [
    { label: 'Inicio', path: '/', available: true },
    { label: 'Incidencias', path: '/incidencias', available: true },
    { label: 'Recursos', path: '/recursos', available: true },
  ];
  protected readonly theme = inject(Theme);
  protected readonly log = inject(OperationLogStore);
  private readonly router = inject(Router);
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
  protected readonly now = computed(() => new Date(this.operations.now()));
  protected readonly date = computed(() => this.dateFormatter.format(this.now()));
  protected readonly time = computed(() => this.timeFormatter.format(this.now()));
  protected readonly connectionLabel = computed(
    () =>
      ({
        loading: 'Conectando',
        live: 'En directo',
        reconnecting: 'Reconectando',
        offline: 'Sin conexión',
      })[this.operations.connection()],
  );
  protected readonly autonomyLabel = computed(() => {
    const agent = this.operations.snapshot()?.agent;
    return !agent
      ? 'Estado sin verificar'
      : agent.mode === 'paused'
        ? 'AUTONOMÍA DETENIDA'
        : agent.autonomous === false
          ? 'Supervisión humana activa'
          : 'Autonomía activa';
  });

  constructor() {
    this.operations.start();
  }

  async toggleAutonomy(): Promise<void> {
    if (
      this.busy() ||
      !this.operations.snapshot()?.agent ||
      (this.paused() && !this.operations.meta())
    )
      return;
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

  protected async openLog(): Promise<void> {
    await this.router.navigate(['/']);
    this.log.open.set(!this.log.open());
  }
}

import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { Icon } from '../../shared/icon/icon';

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
    { label: 'Incidencias', path: '/incidencias', available: false },
    { label: 'Recursos', path: '/recursos', available: false },
    { label: 'Logs', path: '/logs', available: false },
  ];
  protected readonly date = new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date());
}

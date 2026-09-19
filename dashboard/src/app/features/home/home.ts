import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { MOCK_COMMUNICATIONS } from '../../core/data/operations.mock';
import { MapLocation } from '../../core/models/operations';
import { IncidentList } from './incident-list/incident-list';
import { OperationalMap } from './operational-map/operational-map';
import { ServiceFeed } from './service-feed/service-feed';
import { SplitPane } from '../../shared/split-pane/split-pane';
import { DemoRouteSimulation } from '../../core/services/demo-route-simulation';
import { Icon } from '../../shared/icon/icon';
import { IncidentStore } from '../incidents/incident-store';
import { OperationLogStore } from './operation-log/operation-log-store';
import { OperationLogPanel } from './operation-log/operation-log-panel';

@Component({
  selector: 'app-home',
  imports: [OperationalMap, IncidentList, ServiceFeed, SplitPane, Icon, OperationLogPanel],
  host: { '(window:keydown)': 'handleKeyboard($event)' },
  templateUrl: './home.html',
  styleUrl: './home.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {
  private readonly simulation = inject(DemoRouteSimulation);
  private readonly store = inject(IncidentStore);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly log = inject(OperationLogStore);
  protected readonly logOverlay = signal(false);
  private readonly logToggle = viewChild<ElementRef<HTMLButtonElement>>('logToggle');
  readonly incidents = this.store.incidents;
  readonly units = this.store.units;
  readonly communications = computed(() =>
    MOCK_COMMUNICATIONS.map((item) => {
      const unit = this.units().find((unit) => unit.id === item.vehicle);
      return unit ? { ...item, incidentId: unit.incidentId ?? 'Sin asignar' } : item;
    }),
  );
  readonly addresses = computed(() => this.incidents().map((incident) => incident.address));
  readonly projectedUnits = computed(() =>
    this.units().map((unit) => this.simulation.project(unit)),
  );
  readonly selectedIncidentId = signal<string | null>(null);
  readonly selectedUnitId = signal<string | null>(null);
  readonly locations = computed<MapLocation[]>(() => [
    ...this.incidents().map((incident) => ({
      id: incident.id,
      label: incident.id,
      address: incident.address,
      coordinates: incident.coordinates,
      icon: incident.icon,
      kind: 'incident' as const,
      incidentId: incident.id,
    })),
    ...this.units(),
  ]);

  constructor() {
    effect((onCleanup) => {
      if (!this.log.open() || !this.logOverlay()) return;
      const previous = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      onCleanup(() => {
        document.body.style.overflow = previous;
      });
    });
    afterNextRender(() => {
      const media = window.matchMedia('(max-width: 1199px)');
      const update = () => this.logOverlay.set(media.matches);
      update();
      media.addEventListener('change', update);
      this.destroyRef.onDestroy(() => media.removeEventListener('change', update));
    });
  }

  protected toggleLog(): void {
    if (this.log.open()) this.closeLog();
    else {
      this.log.focusedQuestionId.set(null);
      this.log.open.set(true);
    }
  }

  protected closeLog(): void {
    this.log.open.set(false);
    queueMicrotask(() => this.logToggle()?.nativeElement.focus({ preventScroll: true }));
  }

  protected handleKeyboard(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (
      event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'i'
    ) {
      event.preventDefault();
      if (!event.repeat) this.log.generateDemoQuestion();
    } else if (event.key === 'Escape' && this.log.open()) {
      event.preventDefault();
      this.closeLog();
    }
  }

  selectIncident(id: string): void {
    if (this.incidents().some((incident) => incident.id === id)) {
      this.selectedUnitId.set(null);
      this.selectedIncidentId.update((selected) => (selected === id ? null : id));
    }
  }

  selectUnit(id: string): void {
    if (this.units().some((unit) => unit.kind === 'unit' && unit.id === id)) {
      this.selectedIncidentId.set(null);
      this.selectedUnitId.update((selected) => (selected === id ? null : id));
    }
  }
}

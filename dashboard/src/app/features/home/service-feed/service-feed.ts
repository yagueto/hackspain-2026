import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Communication, MapLocation } from '../../../core/models/operations';
import { Icon } from '../../../shared/icon/icon';
import { AnimateList } from '../../../shared/animate-list';

@Component({
  selector: 'app-service-feed',
  imports: [Icon, RouterLink, AnimateList],
  templateUrl: './service-feed.html',
  styleUrl: './service-feed.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServiceFeed {
  readonly associated = input(false);
  readonly communications = input.required<readonly Communication[]>();
  readonly resources = input.required<readonly MapLocation[]>();
  readonly selectedUnitId = input<string | null>(null);
  readonly selectedIncidentId = input<string | null>(null);
  readonly unitSelected = output<string>();
  readonly visibleUnitsChanged = output<readonly string[] | null>();
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly filtersOpen = signal(false);
  protected readonly selectedServices = signal<readonly string[]>([]);
  protected readonly services = computed(() => [
    ...new Set(this.communications().map((item) => item.service)),
  ]);
  protected readonly filterCount = computed(() => this.selectedServices().length);
  protected readonly filteredCommunications = computed(() =>
    this.communications().filter(
      (item) => !this.filterCount() || this.selectedServices().includes(item.service),
    ),
  );

  constructor() {
    effect(() => {
      this.visibleUnitsChanged.emit(
        this.filterCount() ? this.filteredCommunications().map((item) => item.vehicle) : null,
      );
    });
    effect(() => {
      this.selectedUnitId();
      this.selectedIncidentId();
      queueMicrotask(() =>
        this.element.nativeElement
          .querySelector('.related')
          ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }),
      );
    });
  }

  protected resource(id: string): MapLocation | undefined {
    return this.resources().find((resource) => resource.kind === 'unit' && resource.id === id);
  }

  protected resourceStatus(item: Communication): string {
    const route = this.resource(item.vehicle)?.route;
    return route?.status === 'active'
      ? 'En ruta'
      : route?.status === 'completed'
        ? 'En destino'
        : item.status;
  }

  protected toggleService(service: string): void {
    this.selectedServices.update((selected) =>
      selected.includes(service)
        ? selected.filter((item) => item !== service)
        : [...selected, service],
    );
  }
}

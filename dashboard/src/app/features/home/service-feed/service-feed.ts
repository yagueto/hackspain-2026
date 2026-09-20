import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Communication, MapLocation } from '../../../core/models/operations';
import { Icon } from '../../../shared/icon/icon';
import { PaginatedList } from '../../../shared/pagination/paginated-list';
import { Pagination } from '../../../shared/pagination/pagination';

@Component({
  selector: 'app-service-feed',
  imports: [Icon, PaginatedList, Pagination, RouterLink],
  templateUrl: './service-feed.html',
  styleUrl: './service-feed.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServiceFeed {
  readonly communications = input.required<readonly Communication[]>();
  readonly resources = input.required<readonly MapLocation[]>();
  readonly selectedUnitId = input<string | null>(null);
  readonly selectedIncidentId = input<string | null>(null);
  readonly unitSelected = output<string>();
  protected readonly resourceKey = (item: Communication) => item.vehicle;
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

  protected resource(id: string): MapLocation | undefined {
    return this.resources().find((resource) => resource.kind === 'unit' && resource.id === id);
  }

  protected resourceStatus(item: Communication): string {
    const unit = this.resource(item.vehicle);
    return unit?.route?.status === 'active'
      ? 'En camino'
      : unit?.incidentId
        ? unit.route?.status === 'completed'
          ? 'En destino'
          : 'Asignado'
        : 'Disponible';
  }

  protected toggleService(service: string): void {
    this.selectedServices.update((selected) =>
      selected.includes(service)
        ? selected.filter((item) => item !== service)
        : [...selected, service],
    );
  }
}

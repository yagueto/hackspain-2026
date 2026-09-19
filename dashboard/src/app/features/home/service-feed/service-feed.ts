import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { Communication } from '../../../core/models/operations';
import { Icon } from '../../../shared/icon/icon';

@Component({
  selector: 'app-service-feed',
  imports: [Icon],
  templateUrl: './service-feed.html',
  styleUrl: './service-feed.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServiceFeed {
  readonly communications = input.required<readonly Communication[]>();
  readonly selectedUnitId = input<string | null>(null);
  readonly selectedIncidentId = input<string | null>(null);
  readonly unitSelected = output<string>();
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

  protected toggleService(service: string): void {
    this.selectedServices.update((selected) =>
      selected.includes(service)
        ? selected.filter((item) => item !== service)
        : [...selected, service],
    );
  }
}

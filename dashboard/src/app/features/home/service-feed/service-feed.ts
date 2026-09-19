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
  readonly selectedIncidentId = input<string | null>(null);
  readonly incidentSelected = output<string>();
  protected readonly filtersOpen = signal(false);
  protected readonly serviceFilter = signal('');
  protected readonly incidentFilter = signal('');
  protected readonly services = computed(() => [
    ...new Set(this.communications().map((item) => item.service)),
  ]);
  protected readonly incidents = computed(() => [
    ...new Set(this.communications().map((item) => item.incidentId)),
  ]);
  protected readonly filterCount = computed(
    () => Number(!!this.serviceFilter()) + Number(!!this.incidentFilter()),
  );
  protected readonly filteredCommunications = computed(() =>
    this.communications().filter(
      (item) =>
        (!this.serviceFilter() || item.service === this.serviceFilter()) &&
        (!this.incidentFilter() || item.incidentId === this.incidentFilter()),
    ),
  );

  protected resetFilters(): void {
    this.serviceFilter.set('');
    this.incidentFilter.set('');
  }
}

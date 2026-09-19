import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Incident } from '../../../core/models/operations';
import { Icon } from '../../../shared/icon/icon';
import { PaginatedList } from '../../../shared/pagination/paginated-list';
import { Pagination } from '../../../shared/pagination/pagination';

@Component({
  selector: 'app-incident-list',
  imports: [Icon, PaginatedList, Pagination],
  templateUrl: './incident-list.html',
  styleUrl: './incident-list.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IncidentList {
  readonly incidents = input.required<readonly Incident[]>();
  readonly selectedId = input<string | null>(null);
  readonly incidentSelected = output<string>();
  protected readonly incidentKey = (incident: Incident) => incident.id;
}

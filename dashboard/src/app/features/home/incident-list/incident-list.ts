import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Incident } from '../../../core/models/operations';
import { IncidentAttention } from '../../../core/models/operation-log';
import { Icon } from '../../../shared/icon/icon';
import { PaginatedList } from '../../../shared/pagination/paginated-list';
import { Pagination } from '../../../shared/pagination/pagination';

@Component({
  selector: 'app-incident-list',
  imports: [Icon, PaginatedList, Pagination, RouterLink],
  templateUrl: './incident-list.html',
  styleUrl: './incident-list.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IncidentList {
  readonly incidents = input.required<readonly Incident[]>();
  readonly selectedId = input<string | null>(null);
  readonly attention = input<ReadonlyMap<string, IncidentAttention>>(new Map());
  readonly incidentSelected = output<string>();
  readonly responseRequested = output<string>();
  protected readonly incidentKey = (incident: Incident) => incident.id;
}

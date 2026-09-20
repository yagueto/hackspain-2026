import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  output,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Incident } from '../../../core/models/operations';
import { IncidentAttention } from '../../../core/models/operation-log';
import { Icon } from '../../../shared/icon/icon';

@Component({
  selector: 'app-incident-list',
  imports: [Icon, RouterLink],
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
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly sortedIncidents = computed(() =>
    [...this.incidents()].sort((a, b) => this.priorityRank(a) - this.priorityRank(b)),
  );

  constructor() {
    effect(() => {
      this.selectedId();
      queueMicrotask(() =>
        this.element.nativeElement
          .querySelector('.selected')
          ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }),
      );
    });
  }

  protected priority(incident: Incident): string {
    return incident.priority?.slice(1) ?? '—';
  }

  private priorityRank(incident: Incident): number {
    return incident.priority ? Number(incident.priority.slice(1)) : Number.POSITIVE_INFINITY;
  }
}

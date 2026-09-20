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
import { Incident, PRIORITY_LEVEL } from '../../../core/models/operations';
import { IncidentAttention, URGENCY_RANK } from '../../../core/models/operation-log';
import { Icon } from '../../../shared/icon/icon';
import { AnimateList } from '../../../shared/animate-list';

@Component({
  selector: 'app-incident-list',
  imports: [Icon, RouterLink, AnimateList],
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
    [...this.incidents()].sort((a, b) => {
      const left = this.attention().get(a.id);
      const right = this.attention().get(b.id);
      if (left && right) {
        return (
          URGENCY_RANK[left.urgency] - URGENCY_RANK[right.urgency] ||
          left.firstSequence - right.firstSequence
        );
      }
      if (left || right) return left ? -1 : 1;
      return this.priorityRank(a) - this.priorityRank(b);
    }),
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
    return incident.priority ? String(PRIORITY_LEVEL[incident.priority]) : '—';
  }

  private priorityRank(incident: Incident): number {
    return incident.priority ? PRIORITY_LEVEL[incident.priority] : Number.POSITIVE_INFINITY;
  }
}

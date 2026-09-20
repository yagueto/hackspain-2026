import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
} from '@angular/core';
import { OperationLogEvent } from '../../../core/models/operation-log';
import { OperationLogStore } from './operation-log-store';
import { UrgentQuestionCard } from './urgent-question-card';

@Component({
  selector: 'app-operation-timeline',
  imports: [DatePipe, UrgentQuestionCard],
  templateUrl: './operation-timeline.html',
  styleUrl: './operation-timeline.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OperationTimeline {
  readonly incidentId = input.required<string>();
  readonly events = input.required<readonly OperationLogEvent[]>();
  readonly updateError = input(false);
  protected readonly log = inject(OperationLogStore);
  protected readonly questions = computed(
    () =>
      new Map(
        this.log
          .questions()
          .filter((question) => question.incidentId === this.incidentId())
          .map((question) => [question.id, question]),
      ),
  );
  protected readonly pending = computed(() =>
    [...this.questions().values()].filter((question) => question.status === 'pending'),
  );
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly firstPendingId = computed(() => this.pending()[0]?.id);

  constructor() {
    effect(() => {
      const id = this.firstPendingId();
      if (!id) return;
      queueMicrotask(() => {
        if (this.destroyRef.destroyed) return;
        this.element.nativeElement
          .querySelector<HTMLElement>('.awaiting-human')
          ?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
      });
    });
  }
}

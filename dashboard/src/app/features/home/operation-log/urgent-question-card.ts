import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { HumanQuestion, URGENCY_LABELS } from '../../../core/models/operation-log';
import { OperationLogStore } from './operation-log-store';

@Component({
  selector: 'app-urgent-question-card',
  templateUrl: './urgent-question-card.html',
  styleUrl: './urgent-question-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UrgentQuestionCard {
  readonly question = input.required<HumanQuestion>();
  protected readonly log = inject(OperationLogStore);
  protected readonly urgencyLabels = URGENCY_LABELS;
  protected readonly draft = computed(() => this.log.draft(this.question()));
  protected readonly seconds = computed(() =>
    Math.max(0, Math.ceil((Date.parse(this.question().expiresAt) - this.log.now()) / 1000)),
  );
  protected readonly countdown = computed(
    () => `${Math.floor(this.seconds() / 60)}:${String(this.seconds() % 60).padStart(2, '0')}`,
  );

  protected choose(id: string, checked: boolean): void {
    const previous = this.draft().optionIds;
    const optionIds = this.question().multiple
      ? checked
        ? [...new Set([...previous, id])]
        : previous.filter((option) => option !== id)
      : [id];
    this.log.updateDraft(this.question(), { optionIds, text: '', custom: false });
  }

  protected chooseCustom(): void {
    this.log.updateDraft(this.question(), { optionIds: [], text: this.draft().text, custom: true });
  }

  protected changeText(text: string): void {
    this.log.updateDraft(this.question(), { ...this.draft(), text });
  }

  protected submit(event: Event): void {
    event.preventDefault();
    this.log.submit(this.question().id);
  }
}

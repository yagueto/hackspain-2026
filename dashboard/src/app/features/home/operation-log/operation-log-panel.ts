import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Icon } from '../../../shared/icon/icon';
import { OperationLogStore } from './operation-log-store';
import { UrgentQuestionCard } from './urgent-question-card';

@Component({
  selector: 'app-operation-log-panel',
  imports: [DatePipe, Icon, UrgentQuestionCard],
  templateUrl: './operation-log-panel.html',
  styleUrl: './operation-log-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown)': 'handleKeys($event)' },
})
export class OperationLogPanel {
  readonly modal = input(false);
  readonly selectedIncidentId = input<string | null>(null);
  readonly closeRequested = output<void>();
  protected readonly log = inject(OperationLogStore);
  protected readonly unread = signal(0);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly destroyRef = inject(DestroyRef);
  private readonly history = viewChild<ElementRef<HTMLElement>>('history');
  private atBottom = true;
  private previousFilter: string | null | undefined = undefined;
  private previousCount = 0;

  constructor() {
    effect(() => {
      const entries = this.log.history();
      const filter = this.log.incidentFilter();
      const reset = filter !== this.previousFilter;
      const added = Math.max(0, entries.length - this.previousCount);
      this.previousFilter = filter;
      this.previousCount = entries.length;
      queueMicrotask(() => {
        if (this.destroyRef.destroyed) return;
        if (reset || this.atBottom) this.scrollToLatest();
        else if (added) this.unread.update((count) => count + added);
      });
    });
    effect(() => {
      this.log.focusRequest();
      queueMicrotask(() => {
        if (this.destroyRef.destroyed) return;
        const id = this.log.focusedQuestionId();
        const card = [...this.element.querySelectorAll<HTMLElement>('[data-question-id]')].find(
          (item) => item.dataset['questionId'] === id,
        );
        const target =
          card?.querySelector<HTMLElement>('input, textarea, button') ??
          this.element.querySelector<HTMLElement>('select');
        target?.focus({ preventScroll: true });
        card?.scrollIntoView?.({ block: 'nearest' });
      });
    });
  }

  protected onScroll(): void {
    const element = this.history()?.nativeElement;
    if (!element) return;
    this.atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    if (this.atBottom) this.unread.set(0);
  }

  protected scrollToLatest(): void {
    const element = this.history()?.nativeElement;
    if (element) element.scrollTop = element.scrollHeight;
    this.atBottom = true;
    this.unread.set(0);
  }

  protected handleKeys(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.closeRequested.emit();
      return;
    }
    if (!this.modal() || event.key !== 'Tab') return;
    const focusable = [
      ...this.element.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input, select, textarea, [tabindex="0"]',
      ),
    ].filter((item) => item.getClientRects().length);
    const first = focusable[0],
      last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
}

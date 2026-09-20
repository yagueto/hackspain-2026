import {
  computed,
  DestroyRef,
  effect,
  inject,
  Injectable,
  InjectionToken,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, Observable, Subject } from 'rxjs';
import {
  HumanQuestion,
  IncomingQuestion,
  IncidentAttention,
  OperationLogUpdate,
  QuestionAnswer,
  QuestionResolution,
  URGENCY_RANK,
} from '../../../core/models/operation-log';
import { Operations, operatorError, taskIncidentId } from '../../../core/services/operations';
import { IncidentStore } from '../../incidents/incident-store';

export const OPERATION_LOG_UPDATES = new InjectionToken<Observable<OperationLogUpdate>>(
  'OPERATION_LOG_UPDATES',
  { providedIn: 'root', factory: () => EMPTY },
);

@Injectable({ providedIn: 'root' })
export class OperationLogStore {
  readonly incidents = inject(IncidentStore);
  readonly operations = inject(Operations);
  private readonly questionState = signal<readonly HumanQuestion[]>([]);
  private readonly responseEvents = new Subject<QuestionResolution>();
  private readonly adapterError = signal(false);
  readonly answers$ = this.responseEvents.asObservable();
  readonly questions = computed(() => {
    const questions = new Map(
      (this.operations.snapshot()?.coordination_questions ?? []).map((question) => [
        question.id,
        question,
      ]),
    );
    for (const question of this.questionState()) {
      const existing = questions.get(question.id);
      if (!existing || question.status === 'resolved') questions.set(question.id, question);
    }
    return [...questions.values()].sort((a, b) => a.sequence - b.sequence);
  });
  readonly now = this.operations.now;
  readonly open = signal(false);
  readonly view = signal<'activity' | 'missions' | 'communications' | 'learning' | 'system'>(
    'activity',
  );
  readonly incidentFilter = signal<string | null>(null);
  readonly focusedQuestionId = signal<string | null>(null);
  readonly focusRequest = signal(0);
  readonly notification = signal('');
  readonly incomingError = computed(() => this.adapterError() || this.incidents.updateError());
  readonly drafts = signal<Readonly<Record<string, QuestionAnswer>>>({});
  readonly errors = signal<Readonly<Record<string, string>>>({});
  readonly submitting = signal<readonly string[]>([]);
  readonly demoBusy = signal(false);
  readonly pending = computed(() =>
    this.questions().filter((question) => question.status === 'pending'),
  );
  readonly pendingTasks = computed(
    () =>
      this.operations.snapshot()?.tasks.filter((task) => task.status === 'awaiting_approval') ?? [],
  );
  readonly pendingCount = computed(() => this.pending().length + this.pendingTasks().length);
  readonly visiblePending = computed(() =>
    this.pending().filter(
      (question) =>
        !this.incidentFilter() || this.questionIncidents(question).includes(this.incidentFilter()!),
    ),
  );
  readonly history = computed(() => {
    const pending = new Set(this.pending().map((question) => question.id));
    return this.incidents
      .events()
      .filter(
        (event) =>
          (!this.incidentFilter() || event.incidentId === this.incidentFilter()) &&
          !(event.kind === 'question' && event.questionId && pending.has(event.questionId)),
      )
      .sort(
        (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id),
      );
  });
  readonly attention = computed<ReadonlyMap<string, IncidentAttention>>(() => {
    const result = new Map<string, IncidentAttention>();
    const entries = [
      ...this.pending().flatMap((question) =>
        this.questionIncidents(question).map((incidentId) => ({
          incidentId,
          questionId: question.id,
          urgency: question.urgency,
          sequence: Date.parse(question.receivedAt),
        })),
      ),
      ...this.pendingTasks().map((task) => ({
        incidentId: taskIncidentId(task, this.operations.snapshot()?.incident.id),
        questionId: `task:${task.id}`,
        urgency: 'critical' as const,
        sequence: Date.parse(task.created_at || task.updated_at || '') || 0,
      })),
    ].sort((a, b) => a.sequence - b.sequence);
    for (const entry of entries) {
      const previous = result.get(entry.incidentId);
      const higher = !previous || URGENCY_RANK[entry.urgency] < URGENCY_RANK[previous.urgency];
      result.set(entry.incidentId, {
        count: (previous?.count ?? 0) + 1,
        urgency: higher ? entry.urgency : previous!.urgency,
        firstSequence: higher ? entry.sequence : previous!.firstSequence,
        questionId: higher ? entry.questionId : previous!.questionId,
      });
    }
    return result;
  });
  readonly prioritizedIncidents = computed(() => {
    const attention = this.attention();
    return [...this.incidents.incidents()].sort((a, b) => {
      const left = attention.get(a.id),
        right = attention.get(b.id);
      if (!left || !right) return left ? -1 : right ? 1 : 0;
      return (
        URGENCY_RANK[left.urgency] - URGENCY_RANK[right.urgency] ||
        left.firstSequence - right.firstSequence
      );
    });
  });

  constructor() {
    inject(OPERATION_LOG_UPDATES)
      .pipe(takeUntilDestroyed())
      .subscribe({
        next: (update) => this.receive(update),
        error: () => this.adapterError.set(true),
      });
    inject(DestroyRef).onDestroy(() => this.responseEvents.complete());
    let identity: string | undefined;
    effect(() => {
      const state = this.operations.snapshot();
      const next = state ? `${state.incident.id}:${state.incident.started_at}` : undefined;
      if (identity && next !== identity) {
        this.questionState.set([]);
        this.drafts.set({});
        this.errors.set({});
        this.incidentFilter.set(null);
      }
      identity = next;
    });
    effect(() => {
      const pending = this.pending();
      const pendingIds = new Set(pending.map((question) => question.id));
      this.drafts.update((drafts) =>
        Object.keys(drafts).every((id) => pendingIds.has(id))
          ? drafts
          : Object.fromEntries(Object.entries(drafts).filter(([id]) => pendingIds.has(id))),
      );
      this.notification.set(
        pending.length ? `${pending.length} preguntas de coordinación pendientes.` : '',
      );
    });
  }

  questionIncidents(question: HumanQuestion): string[] {
    const state = this.operations.snapshot();
    return [
      ...new Set([
        question.incidentId,
        ...(state?.tasks ?? [])
          .filter((task) => question.allocationTaskIds?.includes(task.id))
          .map((task) => taskIncidentId(task, state?.incident.id)),
      ]),
    ];
  }

  allocationQuestion(taskId: string): HumanQuestion | undefined {
    return this.pending().find((question) => question.allocationTaskIds?.includes(taskId));
  }

  start(): void {
    this.operations.start();
  }

  receive(update: OperationLogUpdate): void {
    if (update?.type === 'event') this.incidents.appendEvent(update.event);
    else if (update?.type === 'question') this.operations.refresh();
  }

  async generateDemoQuestion(): Promise<void> {
    if (this.demoBusy()) return;
    const meta = this.operations.meta();
    if (!meta?.seed_demo || meta.happyrobot_mode !== 'simulated') {
      this.notification.set('Las preguntas de prueba solo están disponibles en la demo simulada.');
      return;
    }
    this.demoBusy.set(true);
    const scope = this.scope();
    try {
      const question = await this.operations.generateDemoQuestion();
      if (scope !== this.scope()) return;
      this.remember(question);
      this.open.set(true);
      this.view.set('activity');
      this.incidentFilter.set(null);
      this.operations.refresh();
    } catch (error) {
      this.notification.set(operatorError(error));
    } finally {
      this.demoBusy.set(false);
    }
  }

  openForIncident(incidentId: string): void {
    this.incidentFilter.set(incidentId);
    const id = this.attention().get(incidentId)?.questionId ?? null;
    this.focusedQuestionId.set(id);
    this.view.set(id?.startsWith('task:') ? 'missions' : 'activity');
    this.open.set(true);
    this.focusRequest.update((value) => value + 1);
  }

  setFilter(id: string): void {
    this.incidentFilter.set(id || null);
    this.focusedQuestionId.set(null);
  }
  draft(question: HumanQuestion): QuestionAnswer {
    return (
      this.drafts()[question.id] ?? { optionIds: [], text: '', custom: question.input === 'text' }
    );
  }
  updateDraft(question: HumanQuestion, draft: QuestionAnswer): void {
    if (question.status !== 'pending') return;
    this.drafts.update((drafts) => ({ ...drafts, [question.id]: draft }));
    this.errors.update((errors) => ({ ...errors, [question.id]: '' }));
  }
  answerLabel(question: IncomingQuestion, answer: QuestionAnswer): string {
    return answer.custom
      ? answer.text.trim()
      : (question.options ?? [])
          .filter((option) => answer.optionIds.includes(option.id))
          .map((option) => option.label)
          .join(', ');
  }
  validAnswer(question: IncomingQuestion, answer: QuestionAnswer): boolean {
    if (
      !answer ||
      !Array.isArray(answer.optionIds) ||
      typeof answer.text !== 'string' ||
      typeof answer.custom !== 'boolean'
    )
      return false;
    if (answer.custom)
      return (
        question.input !== 'options' &&
        !answer.optionIds.length &&
        !!answer.text.trim() &&
        answer.text.trim().length <= 1000
      );
    if (
      question.input === 'text' ||
      answer.text.trim() ||
      !answer.optionIds.length ||
      (!question.multiple && answer.optionIds.length !== 1) ||
      new Set(answer.optionIds).size !== answer.optionIds.length
    )
      return false;
    return answer.optionIds.every((id) => question.options?.some((option) => option.id === id));
  }

  async submit(id: string): Promise<void> {
    const question = this.questions().find((item) => item.id === id);
    if (!question || question.status !== 'pending' || this.submitting().includes(id)) return;
    const answer = this.draft(question);
    if (!this.validAnswer(question, answer)) {
      this.errors.update((errors) => ({
        ...errors,
        [id]: 'Selecciona una respuesta o escribe una instrucción válida.',
      }));
      return;
    }
    this.submitting.update((items) => [...items, id]);
    const scope = this.scope();
    try {
      const result = await this.operations.answerQuestion(id, answer);
      if (scope !== this.scope()) return;
      this.remember(result);
      if (result.status === 'resolved') {
        const { [id]: _draft, ...drafts } = this.drafts();
        this.drafts.set(drafts);
        if (result.resolution) this.responseEvents.next(result.resolution);
      }
      this.operations.refresh();
    } catch (error) {
      this.errors.update((errors) => ({ ...errors, [id]: operatorError(error) }));
    } finally {
      this.submitting.update((items) => items.filter((item) => item !== id));
    }
  }

  private scope(): string {
    const incident = this.operations.snapshot()?.incident;
    return incident ? `${incident.id}:${incident.started_at}` : '';
  }

  private remember(question: HumanQuestion): void {
    this.questionState.update((items) => [
      ...items.filter((item) => item.id !== question.id),
      question,
    ]);
  }
}

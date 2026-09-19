import { computed, DestroyRef, inject, Injectable, InjectionToken, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, Observable, Subject } from 'rxjs';
import { MOCK_COMMUNICATIONS } from '../../../core/data/operations.mock';
import {
  HumanQuestion,
  IncomingQuestion,
  IncidentAttention,
  OperationLogUpdate,
  QuestionAction,
  QuestionAnswer,
  QuestionResolution,
  QuestionUrgency,
  QUESTION_TIMEOUTS,
  URGENCY_RANK,
} from '../../../core/models/operation-log';
import { DemoRouteSimulation } from '../../../core/services/demo-route-simulation';
import { IncidentStore } from '../../incidents/incident-store';
import { createDemoQuestion } from './operation-log.mock';

export const OPERATION_LOG_UPDATES = new InjectionToken<Observable<OperationLogUpdate>>(
  'OPERATION_LOG_UPDATES',
  { providedIn: 'root', factory: () => EMPTY },
);

@Injectable({ providedIn: 'root' })
export class OperationLogStore {
  readonly incidents = inject(IncidentStore);
  private readonly simulation = inject(DemoRouteSimulation);
  private readonly destroyRef = inject(DestroyRef);
  private readonly questionState = signal<readonly HumanQuestion[]>([]);
  private readonly responseEvents = new Subject<QuestionResolution>();
  readonly answers$ = this.responseEvents.asObservable();
  readonly questions = this.questionState.asReadonly();
  readonly now = signal(Date.now());
  readonly notification = signal('');
  readonly incomingError = signal(false);
  readonly drafts = signal<Readonly<Record<string, QuestionAnswer>>>({});
  readonly errors = signal<Readonly<Record<string, string>>>({});
  private sequence = 0;
  private demoSequence = 0;
  private started = false;

  readonly pending = computed(() =>
    this.questions().filter((question) => question.status === 'pending'),
  );
  readonly attention = computed<ReadonlyMap<string, IncidentAttention>>(() => {
    const result = new Map<string, IncidentAttention>();
    for (const question of this.pending()) {
      const previous = result.get(question.incidentId);
      const higher = !previous || URGENCY_RANK[question.urgency] < URGENCY_RANK[previous.urgency];
      result.set(question.incidentId, {
        count: (previous?.count ?? 0) + 1,
        urgency: higher ? question.urgency : previous!.urgency,
        firstSequence: higher ? question.sequence : previous!.firstSequence,
        questionId: higher ? question.id : previous!.questionId,
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
        error: () => this.incomingError.set(true),
      });
    this.simulation.arrivals$
      .pipe(takeUntilDestroyed())
      .subscribe((event) => this.incidents.appendEvent(event));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const communication of MOCK_COMMUNICATIONS.slice(0, 2)) {
      this.incidents.appendEvent({
        id: `call:${communication.id}`,
        incidentId: communication.incidentId,
        occurredAt: new Date().toISOString(),
        kind: 'call',
        title: 'Llamada en curso',
        description: `${communication.agent} tiene una llamada en curso para ${communication.incidentId}.`,
        source: communication.vehicle,
      });
    }
    const tick = () => this.expireDue();
    const timer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      this.responseEvents.complete();
    });
    tick();
  }

  receive(update: OperationLogUpdate): void {
    if (update?.type === 'event') this.incidents.appendEvent(update.event);
    else if (update?.type === 'question') this.receiveQuestion(update.question);
  }

  receiveQuestion(incoming: IncomingQuestion): boolean {
    const incident = this.incidents.incidents().find((item) => item.id === incoming?.incidentId);
    if (
      !incident ||
      typeof incoming.id !== 'string' ||
      !/^[\w:-]{1,100}$/.test(incoming.id) ||
      ['__proto__', 'constructor', 'prototype'].includes(incoming.id) ||
      typeof incoming.prompt !== 'string' ||
      !incoming.prompt.trim() ||
      incoming.prompt.length > 2000 ||
      (incoming.context !== undefined &&
        (typeof incoming.context !== 'string' || incoming.context.length > 1000)) ||
      this.questions().some((item) => item.id === incoming.id)
    )
      return false;
    if (
      !['text', 'options', 'mixed'].includes(incoming.input) ||
      !Object.hasOwn(URGENCY_RANK, incoming.urgency)
    )
      return false;
    const options = incoming.options ?? [];
    if (
      !Array.isArray(options) ||
      options.length > 12 ||
      options.some(
        (option) =>
          !option ||
          typeof option.id !== 'string' ||
          !option.id ||
          typeof option.label !== 'string' ||
          !option.label.trim() ||
          option.label.length > 200 ||
          !this.validAction(option.action),
      ) ||
      new Set(options.map((option) => option.id)).size !== options.length
    )
      return false;
    if (incoming.input !== 'text' && !options.length) return false;
    if (
      !this.validAction(incoming.textAction) ||
      !this.validAnswer(incoming, incoming.defaultAnswer)
    )
      return false;
    const severity: QuestionUrgency =
      incident.priority === 'P0' ? 'critical' : incident.priority === 'P1' ? 'high' : 'moderate';
    const urgency =
      URGENCY_RANK[severity] < URGENCY_RANK[incoming.urgency] ? severity : incoming.urgency;
    const seconds = incoming.timeoutSeconds ?? QUESTION_TIMEOUTS[urgency];
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) return false;
    const receivedAt = new Date().toISOString();
    const deadline = incoming.expiresAt
      ? Date.parse(incoming.expiresAt)
      : Date.now() + seconds * 1000;
    if (!Number.isFinite(deadline)) return false;
    const question: HumanQuestion = {
      ...incoming,
      options: options.map((option) => ({
        ...option,
        action: option.action ? { ...option.action } : undefined,
      })),
      defaultAnswer: {
        ...incoming.defaultAnswer,
        optionIds: [...incoming.defaultAnswer.optionIds],
      },
      textAction: incoming.textAction ? { ...incoming.textAction } : undefined,
      urgency,
      receivedAt,
      expiresAt: new Date(deadline).toISOString(),
      sequence: ++this.sequence,
      status: 'pending',
    };
    this.questionState.update((questions) => [...questions, question]);
    this.incidents.appendEvent({
      id: `${question.id}:received`,
      incidentId: question.incidentId,
      occurredAt: receivedAt,
      kind: 'question',
      questionId: question.id,
      title: 'Pregunta de coordinación',
      description: question.prompt,
      source: 'Agente de coordinación',
    });
    this.expireDue();
    if (this.questions().find((item) => item.id === question.id)?.status === 'pending')
      this.notification.set(
        `${question.incidentId} necesita respuesta. ${this.pending().length} preguntas pendientes.`,
      );
    return true;
  }

  generateDemoQuestion(): void {
    const question = createDemoQuestion(
      ++this.demoSequence,
      this.incidents.incidents(),
      this.incidents.units().map((unit) => this.simulation.project(unit)),
    );
    if (question) this.receiveQuestion(question);
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

  submit(id: string): void {
    this.expireDue();
    const question = this.questions().find((item) => item.id === id);
    if (!question || question.status !== 'pending') return;
    const answer = this.draft(question);
    if (!this.validAnswer(question, answer)) {
      this.errors.update((errors) => ({
        ...errors,
        [id]: 'Selecciona una respuesta o escribe una instrucción válida.',
      }));
      return;
    }
    this.resolve(question, answer, 'human');
  }

  expireDue(): void {
    const now = Date.now();
    this.now.set(now);
    for (const question of this.pending()) {
      if (Date.parse(question.expiresAt) <= now)
        this.resolve(question, question.defaultAnswer, 'timeout');
    }
  }

  private resolve(
    question: HumanQuestion,
    answer: QuestionAnswer,
    source: 'human' | 'timeout',
  ): void {
    if (this.questions().find((item) => item.id === question.id)?.status !== 'pending') return;
    if (source === 'human' && Date.now() >= Date.parse(question.expiresAt)) {
      this.resolve(question, question.defaultAnswer, 'timeout');
      return;
    }
    const normalized = {
      optionIds: [...answer.optionIds],
      text: answer.text.trim(),
      custom: answer.custom,
    };
    const actions = normalized.custom
      ? [question.textAction ?? { type: 'note' as const }]
      : (question.options ?? [])
          .filter((option) => normalized.optionIds.includes(option.id))
          .map((option) => option.action ?? { type: 'none' as const });
    const targets = actions.flatMap((action) =>
      action.type === 'set-status'
        ? ['status']
        : action.type === 'assign-resource'
          ? [action.resourceId]
          : [],
    );
    const invalid =
      new Set(targets).size !== targets.length
        ? 'las opciones contienen acciones incompatibles.'
        : actions.map((action) => this.actionProblem(action, question.incidentId)).find(Boolean);
    const answerLabel = this.answerLabel(question, normalized);
    const outcome = invalid
      ? `No aplicada: ${invalid}`
      : actions
          .map((action) => this.applyAction(action, question.incidentId, question.id))
          .join(' ');
    const resolution: QuestionResolution = {
      questionId: question.id,
      incidentId: question.incidentId,
      idempotencyKey: question.id,
      answer: normalized,
      answerLabel,
      source,
      answeredAt: new Date().toISOString(),
      outcome,
      applied: !invalid,
    };
    this.questionState.update((questions) =>
      questions.map((item) =>
        item.id === question.id ? { ...item, status: 'resolved', resolution } : item,
      ),
    );
    const { [question.id]: _draft, ...drafts } = this.drafts();
    this.drafts.set(drafts);
    this.incidents.appendEvent({
      id: `${question.id}:answered`,
      incidentId: question.incidentId,
      occurredAt: resolution.answeredAt,
      kind: 'answer',
      questionId: question.id,
      title:
        source === 'timeout' ? 'Respuesta automática por vencimiento' : 'Respuesta del coordinador',
      summary: `${source === 'timeout' ? 'Respuesta automática' : 'Respuesta humana'}: ${answerLabel}`,
      description: answerLabel,
      source: source === 'timeout' ? 'Sistema · tiempo agotado' : 'Coordinador',
    });
    this.incidents.appendEvent({
      id: `${question.id}:result`,
      incidentId: question.incidentId,
      occurredAt: resolution.answeredAt,
      kind: 'action',
      questionId: question.id,
      title: 'Resultado de la decisión',
      description: outcome,
      source: 'Coordinación',
    });
    this.responseEvents.next(resolution);
  }

  private validAction(action?: QuestionAction): boolean {
    if (action == null) return true;
    if (typeof action !== 'object') return false;
    if (action.type === 'none' || action.type === 'note') return true;
    if (action.type === 'set-status')
      return (
        typeof action.status === 'string' &&
        !!action.status.trim() &&
        action.status.length <= 80 &&
        typeof action.expectedStatus === 'string'
      );
    return (
      action.type === 'assign-resource' &&
      typeof action.resourceId === 'string' &&
      (action.expectedIncidentId === null || typeof action.expectedIncidentId === 'string')
    );
  }

  private actionProblem(action: QuestionAction, incidentId: string): string | null {
    const incident = this.incidents.incidents().find((item) => item.id === incidentId);
    if (!incident) return 'la incidencia ya no está disponible.';
    if (action.type === 'set-status' && incident.status !== action.expectedStatus)
      return 'el estado de la incidencia ya ha cambiado.';
    if (action.type === 'assign-resource') {
      const source = this.incidents
        .units()
        .find((unit) => unit.kind === 'unit' && unit.id === action.resourceId);
      if (!source || (source.incidentId ?? null) !== action.expectedIncidentId)
        return 'la asignación del recurso ya ha cambiado.';
      if (this.simulation.project(source).route?.status === 'active')
        return 'el recurso está realizando una ruta.';
    }
    return null;
  }

  private applyAction(action: QuestionAction, incidentId: string, questionId: string): string {
    if (action.type === 'set-status') {
      this.incidents.applyUpdate({ incidentId, incident: { status: action.status } });
      return `${incidentId} pasa a «${action.status}».`;
    }
    if (action.type === 'assign-resource') {
      const unit = this.simulation.project(
        this.incidents.units().find((item) => item.id === action.resourceId)!,
      );
      this.incidents.reassignUnit(unit, incidentId);
      if (unit.incidentId && unit.incidentId !== incidentId)
        this.incidents.appendEvent({
          id: `${questionId}:transfer:${unit.id}`,
          incidentId: unit.incidentId,
          occurredAt: new Date().toISOString(),
          kind: 'assignment',
          title: 'Recurso reasignado',
          description: `${unit.id} ha sido reasignado a ${incidentId}.`,
          source: 'Coordinación',
        });
      return `${unit.id} ha sido asignado a ${incidentId}${action.expectedIncidentId ? ` desde ${action.expectedIncidentId}` : ''}.`;
    }
    return action.type === 'note'
      ? `Instrucción incorporada al histórico de ${incidentId}.`
      : 'Se mantiene la actuación y las asignaciones actuales.';
  }
}

import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  ACTION_LABELS,
  AgentSettings,
  OperationalAction,
  OperationalTask,
  TASK_LABELS,
} from '../../../core/models/world';
import { operatorError, taskIncidentId } from '../../../core/services/operations';
import { Icon } from '../../../shared/icon/icon';
import { OperationLogStore } from './operation-log-store';
import { UrgentQuestionCard } from './urgent-question-card';

@Component({
  selector: 'app-operation-log-panel',
  imports: [DatePipe, Icon, UrgentQuestionCard, RouterLink],
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
  protected readonly operations = this.log.operations;
  protected readonly taskLabels = TASK_LABELS;
  protected readonly actionLabels = ACTION_LABELS;
  protected readonly tabs = [
    { id: 'activity', label: 'Actividad' },
    { id: 'missions', label: 'Misiones' },
    { id: 'communications', label: 'Comunicaciones' },
    { id: 'system', label: 'Sistema' },
  ] as const;
  protected readonly taskKinds = [
    { id: 'dispatch_resource', label: 'Movilizar recurso' },
    { id: 'medical_triage', label: 'Asistencia sanitaria' },
    { id: 'evacuate_zone', label: 'Evacuación' },
    { id: 'close_road', label: 'Corte de carretera' },
    { id: 'warn_civilian', label: 'Avisar a población' },
    { id: 'brief_authority', label: 'Informar a autoridad' },
    { id: 'open_shelter', label: 'Abrir albergue' },
    { id: 'other', label: 'Otra misión' },
  ];
  protected readonly tasks = computed(() =>
    (this.operations.snapshot()?.tasks ?? []).filter(
      (task) =>
        !this.log.incidentFilter() ||
        taskIncidentId(task, this.operations.snapshot()?.incident.id) === this.log.incidentFilter(),
    ),
  );
  protected readonly actions = computed(() =>
    (this.operations.snapshot()?.recent_actions ?? []).filter((action) => {
      const task = this.operations
        .snapshot()
        ?.tasks.find((item) => item.id === (action.task_id || action.request?.task_id));
      const contact = this.operations
        .snapshot()
        ?.contacts.find((item) => item.id === action.contact_id);
      return (
        !this.log.incidentFilter() ||
        taskIncidentId(task, contact?.zone_id || this.operations.snapshot()?.incident.id) ===
          this.log.incidentFilter()
      );
    }),
  );
  protected readonly integrations = computed(() =>
    Object.entries(this.operations.snapshot()?.integrations ?? {}),
  );
  protected readonly workflows = computed(() =>
    Object.entries(this.operations.meta()?.workflows ?? {}),
  );
  protected readonly busy = signal(false);
  protected readonly feedback = signal('');
  protected readonly liveConfirmed = signal(false);
  protected readonly canSend = computed(
    () =>
      !!this.operations.meta() &&
      (this.operations.meta()?.happyrobot_mode === 'simulated' || this.liveConfirmed()),
  );
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

  protected holdRemaining(task: OperationalTask): number {
    return task.hold_until && task.status === 'dispatching'
      ? Math.max(0, Math.ceil((Date.parse(task.hold_until) - this.operations.now()) / 1000))
      : 0;
  }

  protected approve(task: OperationalTask, approved: boolean): Promise<void> {
    return this.run(
      () => this.operations.approve(task, approved, false),
      'Decisión registrada; consulta el estado de la orden.',
      approved,
    );
  }
  protected cancel(task: OperationalTask): Promise<void> {
    return this.run(
      () => this.operations.cancelTask(task),
      'Cancelación registrada. Una unidad ya movilizada no queda disponible sin un nuevo parte.',
    );
  }
  protected complete(task: OperationalTask): Promise<void> {
    return this.run(
      () => this.operations.setTaskStatus(task, 'done', 'Finalizada por el operador'),
      'Misión finalizada; la disponibilidad del recurso requiere su propio parte.',
    );
  }
  protected prioritize(task: OperationalTask, value: string): Promise<void> {
    const priority = Number(value);
    if (!value.trim() || !Number.isInteger(priority) || priority < 0 || priority > 100) {
      this.feedback.set('La prioridad debe ser un entero entre 0 y 100.');
      return Promise.resolve();
    }
    return this.run(
      () =>
        this.operations.prioritizeTask(
          task,
          priority,
          'Prioridad revisada desde el centro de coordinación',
        ),
      'Prioridad guardada.',
    );
  }
  protected reconcile(action: OperationalAction): Promise<void> {
    return this.run(
      () => this.operations.reconcile(action),
      'Run consultado. Sin resultado operativo no se asume recepción ni disponibilidad.',
    );
  }
  protected createMission(
    event: Event,
    kind: string,
    title: string,
    description: string,
    zone: string,
    contact: string,
  ): Promise<void> {
    event.preventDefault();
    if (!title.trim()) {
      this.feedback.set('Introduce el título de la misión.');
      return Promise.resolve();
    }
    return this.run(
      () =>
        this.operations.createTask({
          kind,
          title: title.trim(),
          description: description.trim(),
          zone_id: zone || null,
          contact_id: contact || null,
        }),
      'Misión registrada en el backend.',
      true,
    );
  }
  protected communicate(
    event: Event,
    channel: string,
    contact: string,
    text: string,
  ): Promise<void> {
    event.preventDefault();
    if (!contact || !text.trim()) {
      this.feedback.set('Elige un contacto y escribe las instrucciones.');
      return Promise.resolve();
    }
    return this.run(
      () =>
        channel === 'telegram'
          ? this.operations.telegram(contact, text.trim())
          : this.operations.call(contact, text.trim()),
      'Comunicación registrada. Consulta su resultado, no se da por recibida automáticamente.',
      true,
    );
  }
  protected note(event: Event, title: string): Promise<void> {
    event.preventDefault();
    if (!title.trim()) return Promise.resolve();
    return this.run(
      () => this.operations.addNote(title.trim(), this.log.incidentFilter()),
      'Nota incorporada al registro.',
    );
  }
  protected configure(
    autonomous: boolean,
    hold: string,
    escalation: string,
    interval: string,
  ): Promise<void> {
    const body: Partial<AgentSettings> = {
      autonomous,
      hold_seconds: Number(hold),
      escalate_after_seconds: Number(escalation),
      tick_seconds: Number(interval),
    };
    if (
      ![hold, escalation, interval].every(
        (value) => value.trim() && Number.isFinite(Number(value)),
      ) ||
      body.hold_seconds! < 0 ||
      body.escalate_after_seconds! < 0 ||
      body.tick_seconds! < 0.1
    ) {
      this.feedback.set(
        'Revisa los tiempos: retención y escalado no negativos, intervalo mínimo 0,1 s.',
      );
      return Promise.resolve();
    }
    return this.run(
      () => this.operations.configureAgent(body),
      'Política actualizada. La parada de emergencia no se modifica.',
    );
  }
  protected tick(): Promise<void> {
    return this.run(() => this.operations.tick(), 'Ciclo del agente completado.', true);
  }
  protected dispatch(): Promise<void> {
    return this.run(
      () => this.operations.dispatchPending(),
      'Cola revisada; se respetan la retención y la parada.',
      true,
    );
  }
  private async run(
    action: () => Promise<unknown>,
    success: string,
    maySend = false,
  ): Promise<void> {
    if (this.busy()) return;
    if (maySend && !this.canSend()) {
      this.feedback.set('Confirma explícitamente las comunicaciones reales antes de continuar.');
      return;
    }
    this.busy.set(true);
    this.feedback.set('');
    try {
      await action();
      this.feedback.set(success);
      this.operations.refresh();
    } catch (error) {
      this.feedback.set(operatorError(error));
    } finally {
      this.busy.set(false);
    }
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

export type QuestionUrgency = 'critical' | 'high' | 'moderate';
export type QuestionInput = 'text' | 'options' | 'mixed';
export type LogEventKind =
  'created' | 'assignment' | 'call' | 'arrival' | 'question' | 'answer' | 'action' | 'note';

export interface OperationLogEvent {
  id: string;
  incidentId: string;
  occurredAt: string;
  title: string;
  description: string;
  source: string;
  summary?: string;
  kind?: LogEventKind;
  questionId?: string;
}

export type QuestionAction =
  | { type: 'none' | 'note' }
  | { type: 'set-status'; status: string; expectedStatus: string }
  | { type: 'assign-resource'; resourceId: string; expectedIncidentId: string | null };

export interface QuestionOption {
  id: string;
  label: string;
  action?: QuestionAction;
}

export interface QuestionAnswer {
  optionIds: readonly string[];
  text: string;
  custom: boolean;
}

export interface IncomingQuestion {
  id: string;
  incidentId: string;
  prompt: string;
  context?: string;
  urgency: QuestionUrgency;
  input: QuestionInput;
  options?: readonly QuestionOption[];
  multiple?: boolean;
  textAction?: QuestionAction;
  defaultAnswer: QuestionAnswer;
  expiresAt?: string;
  timeoutSeconds?: number;
}

export interface QuestionResolution {
  questionId: string;
  incidentId: string;
  idempotencyKey: string;
  answer: QuestionAnswer;
  answerLabel: string;
  source: 'human' | 'timeout';
  answeredAt: string;
  outcome: string;
  applied: boolean;
}

export interface HumanQuestion extends IncomingQuestion {
  receivedAt: string;
  expiresAt: string;
  sequence: number;
  status: 'pending' | 'resolved';
  resolution?: QuestionResolution;
}

export interface IncidentAttention {
  count: number;
  urgency: QuestionUrgency;
  firstSequence: number;
  questionId: string;
}

export type OperationLogUpdate =
  { type: 'event'; event: OperationLogEvent } | { type: 'question'; question: IncomingQuestion };

export const URGENCY_RANK: Record<QuestionUrgency, number> = { critical: 0, high: 1, moderate: 2 };
export const QUESTION_TIMEOUTS: Record<QuestionUrgency, number> = {
  critical: 60,
  high: 120,
  moderate: 300,
};
export const URGENCY_LABELS: Record<QuestionUrgency, string> = {
  critical: 'Crítica',
  high: 'Alta',
  moderate: 'Moderada',
};

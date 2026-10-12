import { randomUUID } from 'node:crypto';
import { demoOrganizations } from '../../fixtures/src/index.ts';
import { simulateExchange } from '../../transports/src/index.ts';

export type TaskState = 'waiting_owner' | 'completed' | 'cancelled';
export type OwnerChoice = 'cheapest' | 'fastest' | 'defer';
export interface DemoEvent {
  at: string;
  type: 'task.created' | 'message.sent.mock' | 'message.received.mock' | 'owner.question.mock' | 'owner.answered.mock' | 'task.cancelled';
  message: string;
}
export interface DemoResult {
  organizationId: string;
  organization: string;
  priceThb: number;
  turnaroundHours: number;
  channel: string;
  evidence: string;
  evidenceKind: 'mock';
}
export interface DemoQuestion {
  id: string;
  text: string;
  options: { id: OwnerChoice; label: string }[];
  state: 'pending' | 'answered' | 'cancelled';
  answer?: OwnerChoice;
}
export interface DemoTask {
  id: string;
  goal: string;
  state: TaskState;
  mode: 'demo';
  createdAt: string;
  results: DemoResult[];
  question: DemoQuestion;
  recommendation?: DemoResult;
  events: DemoEvent[];
}
export class DemoError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** A repository provides atomic per-task mutations. Fake transports stay fake. */
export interface DemoTaskRepository {
  list(): DemoTask[];
  find(id: string): DemoTask | undefined;
  insert(task: DemoTask, maximum: number): void;
  mutate(id: string, operation: (task: DemoTask) => void): DemoTask;
  close?(): void;
}
export class MemoryDemoTaskRepository implements DemoTaskRepository {
  private readonly tasks = new Map<string, DemoTask>();
  list(): DemoTask[] { return [...this.tasks.values()].map(task => structuredClone(task)); }
  find(id: string): DemoTask | undefined {
    const task = this.tasks.get(id);
    return task ? structuredClone(task) : undefined;
  }
  insert(task: DemoTask, maximum: number): void {
    if (this.tasks.size >= maximum) throw new DemoError(429, 'DEMO_LIMIT', 'Лимит: 100 демонстрационных задач');
    this.tasks.set(task.id, structuredClone(task));
  }
  mutate(id: string, operation: (task: DemoTask) => void): DemoTask {
    const current = this.tasks.get(id);
    if (!current) throw new DemoError(404, 'TASK_NOT_FOUND', 'Задача не найдена');
    const copy = structuredClone(current);
    operation(copy);
    this.tasks.set(id, copy);
    return structuredClone(copy);
  }
}
export class DemoTaskStore {
  private readonly repository: DemoTaskRepository;
  constructor(repository: DemoTaskRepository = new MemoryDemoTaskRepository()) { this.repository = repository; }
  list(): DemoTask[] { return this.repository.list(); }
  get(id: string): DemoTask {
    const task = this.repository.find(id);
    if (!task) throw new DemoError(404, 'TASK_NOT_FOUND', 'Демонстрационная задача не найдена');
    return task;
  }
  create(goal: unknown): DemoTask {
    if (typeof goal !== 'string' || goal.trim().length < 3 || goal.trim().length > 500) {
      throw new DemoError(400, 'INVALID_GOAL', 'Описание задачи должно содержать от 3 до 500 символов');
    }
    const id = randomUUID();
    const at = new Date().toISOString();
    const events: DemoEvent[] = [{ at, type: 'task.created', message: 'Создана демонстрационная задача' }];
    const results = demoOrganizations.map((org): DemoResult => {
      const reply = simulateExchange(org);
      events.push({ at, type: 'message.sent.mock', message: '[' + org.name + ' / ' + reply.channel + '] ' + reply.outgoing });
      events.push({ at, type: 'message.received.mock', message: '[' + org.name + '] ' + reply.incoming });
      return {
        organizationId: org.id, organization: org.name,
        priceThb: org.priceThb, turnaroundHours: org.turnaroundHours,
        channel: org.channel, evidence: reply.evidenceRef, evidenceKind: 'mock'
      };
    });
    const question: DemoQuestion = {
      id: randomUUID(),
      text: 'По какому критерию выбрать из трёх демонстрационных предложений?',
      options: [
        { id: 'cheapest', label: 'Самая низкая цена' },
        { id: 'fastest', label: 'Самый короткий срок' },
        { id: 'defer', label: 'Пока не выбирать' }
      ],
      state: 'pending'
    };
    events.push({ at, type: 'owner.question.mock', message: 'Вопрос владельцу #' + question.id + ' (только в веб-интерфейсе)' });
    const task: DemoTask = { id, goal: goal.trim(), state: 'waiting_owner', mode: 'demo', createdAt: at, results, question, events };
    this.repository.insert(task, 100);
    return this.get(id);
  }
  answer(taskId: string, questionId: unknown, choice: unknown): DemoTask {
    return this.repository.mutate(taskId, task => {
      if (task.state !== 'waiting_owner' || task.question.state !== 'pending') {
        throw new DemoError(409, 'QUESTION_CLOSED', 'Вопрос уже закрыт');
      }
      if (questionId !== task.question.id) throw new DemoError(409, 'WRONG_QUESTION', 'Ответ относится к другому вопросу');
      if (choice !== 'cheapest' && choice !== 'fastest' && choice !== 'defer') {
        throw new DemoError(400, 'INVALID_CHOICE', 'Недопустимый вариант ответа');
      }
      task.question.state = 'answered';
      task.question.answer = choice;
      task.state = 'completed';
      if (choice !== 'defer') {
        const ordered = [...task.results].sort((a, b) => choice === 'cheapest'
          ? a.priceThb - b.priceThb : a.turnaroundHours - b.turnaroundHours);
        task.recommendation = ordered[0];
      }
      task.events.push({ at: new Date().toISOString(), type: 'owner.answered.mock', message: 'Владелец выбрал: ' + choice });
    });
  }
  stop(taskId: string): DemoTask {
    return this.repository.mutate(taskId, task => {
      if (task.state === 'completed') throw new DemoError(409, 'TASK_FINISHED', 'Задача уже завершена');
      if (task.state !== 'cancelled') {
        task.state = 'cancelled';
        task.question.state = 'cancelled';
        task.events.push({ at: new Date().toISOString(), type: 'task.cancelled', message: 'Задача остановлена владельцем' });
      }
    });
  }
}

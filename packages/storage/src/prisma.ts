import { Prisma, type PrismaClient } from '@prisma/client';
import { DemoError, DemoTaskStore, MemoryDemoTaskRepository, type DemoTask, type OwnerChoice } from '../../core/src/demo.ts';

function fromJson(value: Prisma.JsonValue): DemoTask {
  // Only Integron-generated scripted payloads. Live provider content is not stored here.
  return value as unknown as DemoTask;
}
function simulateUpdate(task: DemoTask, action: (store: DemoTaskStore) => DemoTask): DemoTask {
  const memory = new MemoryDemoTaskRepository();
  memory.insert(task, 100);
  return action(new DemoTaskStore(memory));
}
function validId(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new DemoError(404, 'TASK_NOT_FOUND', 'Задача не найдена');
  }
}

/**
 * PostgreSQL-backed mock workflow. The question and queued notification are created
 * transactionally; human replies use an optimistic concurrency check. No real
 * provider communication is performed by this class.
 */
export class PrismaDemoTaskService {
  private readonly prisma: PrismaClient;
  constructor(prisma: PrismaClient) { this.prisma = prisma; }

  async list(): Promise<DemoTask[]> {
    const rows = await this.prisma.demoTask.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(row => fromJson(row.payload));
  }
  async get(id: string): Promise<DemoTask> {
    validId(id);
    const row = await this.prisma.demoTask.findUnique({ where: { id } });
    if (!row) throw new DemoError(404, 'TASK_NOT_FOUND', 'Демонстрационная задача не найдена');
    return fromJson(row.payload);
  }
  async create(goal: unknown, ids?: { taskId: string; questionId: string }): Promise<DemoTask> {
    // Preserve current P0 goal validation and scripted mock contacts.
    const task = new DemoTaskStore().create(goal);
    if (ids) {
      const originalQuestionId = task.question.id;
      task.id = ids.taskId;
      task.question.id = ids.questionId;
      for (const event of task.events) {
        event.message = event.message.replace(originalQuestionId, ids.questionId);
      }
      const existing = await this.prisma.demoTask.findUnique({ where: { id: ids.taskId } });
      if (existing) {
        if (fromJson(existing.payload).goal !== task.goal) throw new Error('Idempotency key conflict');
        return fromJson(existing.payload);
      }
    }
    try {
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(71615321)::text`;
      if (await tx.demoTask.count() >= 100) throw new DemoError(429, 'DEMO_LIMIT', 'Лимит: 100 демонстрационных задач');
      await tx.demoTask.create({
        data: { id: task.id, payload: task as unknown as Prisma.InputJsonValue, createdAt: new Date(task.createdAt) }
      });
      const question = await tx.ownerClarification.create({
        data: {
          id: task.question.id,
          taskId: task.id,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
        }
      });
      await tx.ownerNotification.create({ data: { clarificationId: question.id } });
    });
    } catch (error) {
      if (ids && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.demoTask.findUnique({ where: { id: ids.taskId } });
        if (existing && fromJson(existing.payload).goal === task.goal) return fromJson(existing.payload);
      }
      throw error;
    }
    return task;
  }
  async answer(taskId: string, questionId: unknown, choice: unknown): Promise<DemoTask> {
    return this.mutate(taskId, store => store.answer(taskId, questionId, choice), 'answer');
  }
  async answerQuestion(questionId: string, choice: OwnerChoice): Promise<DemoTask> {
    validId(questionId);
    const question = await this.prisma.ownerClarification.findUnique({ where: { id: questionId } });
    if (!question) throw new DemoError(404, 'QUESTION_NOT_FOUND', 'Вопрос не найден');
    return this.answer(question.taskId, questionId, choice);
  }
  async stop(taskId: string): Promise<DemoTask> {
    return this.mutate(taskId, store => store.stop(taskId), 'stop');
  }
  async expirePending(limit = 50): Promise<number> {
    const expired = await this.prisma.ownerClarification.findMany({
      where: { state: 'pending', expiresAt: { lte: new Date() } },
      orderBy: { expiresAt: 'asc' }, take: limit
    });
    let count = 0;
    for (const question of expired) {
      try {
        await this.mutate(question.taskId, store => store.stop(question.taskId), 'expire');
        count++;
      } catch (error) {
        // Another worker or the UI may have completed/cancelled the task.
        if (!(error instanceof DemoError && (
          error.code === 'TASK_FINISHED' || error.code === 'QUESTION_CLOSED' ||
          error.code === 'TASK_NOT_FOUND' || error.code === 'CONCURRENT_UPDATE'
        ))) throw error;
      }
    }
    return count;
  }

  private async mutate(
    taskId: string, action: (store: DemoTaskStore) => DemoTask, kind: 'answer' | 'stop' | 'expire'
  ): Promise<DemoTask> {
    validId(taskId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await this.prisma.demoTask.findUnique({ where: { id: taskId } });
      if (!current) throw new DemoError(404, 'TASK_NOT_FOUND', 'Демонстрационная задача не найдена');
      const updated = simulateUpdate(fromJson(current.payload), action);
      const saved = await this.prisma.$transaction(async tx => {
        const changed = await tx.demoTask.updateMany({
          where: { id: taskId, revision: current.revision },
          data: { payload: updated as unknown as Prisma.InputJsonValue, revision: { increment: 1 } }
        });
        if (changed.count !== 1) return false;

        // Older P0 tasks, created before the migration, may have no clarification row.
        const row = await tx.ownerClarification.findUnique({ where: { id: updated.question.id } });
        if (row) {
          const condition = kind === 'expire' ? { lte: new Date() } :
            kind === 'answer' ? { gt: new Date() } : undefined;
          const result = await tx.ownerClarification.updateMany({
            where: { id: row.id, taskId, state: 'pending', ...(condition ? { expiresAt: condition } : {}) },
            data: kind === 'answer'
              ? { state: 'answered', choice: updated.question.answer, answeredAt: new Date() }
              : { state: kind === 'expire' ? 'expired' : 'cancelled' }
          });
          if (result.count !== 1 && kind === 'answer') {
            throw new DemoError(409, 'QUESTION_CLOSED', 'Вопрос закрыт или просрочен');
          }
          await tx.ownerNotification.updateMany({
            where: { clarificationId: row.id, state: 'queued' },
            data: { state: 'cancelled' }
          });
        }
        return true;
      });
      if (saved) return updated;
    }
    throw new DemoError(409, 'CONCURRENT_UPDATE', 'Задача изменилась. Обновите и повторите.');
  }
}

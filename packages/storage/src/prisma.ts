import { Prisma, type PrismaClient } from '@prisma/client';
import {
  DemoError, DemoTaskStore, MemoryDemoTaskRepository, type DemoTask
} from '../../core/src/demo.ts';

function fromJson(payload: Prisma.JsonValue): DemoTask {
  // This table contains only Integron-generated mock documents; schema migration
  // and validation of external messages are separate concerns.
  return payload as unknown as DemoTask;
}

function simulateUpdate(task: DemoTask, act: (store: DemoTaskStore) => DemoTask): DemoTask {
  const repo = new MemoryDemoTaskRepository();
  repo.insert(task, 100);
  return act(new DemoTaskStore(repo));
}

/** PostgreSQL P0 mock store. Version-based CAS prevents duplicate owner decisions. */
export class PrismaDemoTaskService {
  constructor(private readonly prisma: PrismaClient) {}
  async list(): Promise<DemoTask[]> {
    const rows = await this.prisma.demoTask.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(row => fromJson(row.payload));
  }
  async get(id: string): Promise<DemoTask> {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(id)) throw new DemoError(404, 'TASK_NOT_FOUND', 'Демонстрационная задача не найдена');
    const row = await this.prisma.demoTask.findUnique({ where: { id } });
    if (!row) throw new DemoError(404, 'TASK_NOT_FOUND', 'Демонстрационная задача не найдена');
    return fromJson(row.payload);
  }
  async create(goal: unknown): Promise<DemoTask> {
    // Reuse the exact scripted domain scenario from demo/local; no real transports.
    const task = new DemoTaskStore().create(goal);
    await this.prisma.$transaction(async tx => {
      // Serialize quota checks across concurrent requests (single owner, P0).
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(71615321)::text`;
      const count = await tx.demoTask.count();
      if (count >= 100) throw new DemoError(429, 'DEMO_LIMIT', 'Лимит: 100 демонстрационных задач');
      await tx.demoTask.create({
        data: { id: task.id, payload: task as unknown as Prisma.InputJsonValue, createdAt: new Date(task.createdAt) }
      });
    });
    return task;
  }
  async answer(taskId: string, questionId: unknown, choice: unknown): Promise<DemoTask> {
    return this.mutate(taskId, store => store.answer(taskId, questionId, choice));
  }
  async stop(taskId: string): Promise<DemoTask> {
    return this.mutate(taskId, store => store.stop(taskId));
  }
  private async mutate(taskId: string, action: (store: DemoTaskStore) => DemoTask): Promise<DemoTask> {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(taskId)) throw new DemoError(404, 'TASK_NOT_FOUND', 'Демонстрационная задача не найдена');
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await this.prisma.demoTask.findUnique({ where: { id: taskId } });
      if (!row) throw new DemoError(404, 'TASK_NOT_FOUND', 'Демонстрационная задача не найдена');
      const updated = simulateUpdate(fromJson(row.payload), action);
      const changed = await this.prisma.demoTask.updateMany({
        where: { id: taskId, revision: row.revision },
        data: { payload: updated as unknown as Prisma.InputJsonValue, revision: { increment: 1 } }
      });
      if (changed.count === 1) return updated;
      // Concurrent change: read the latest version, which may now reject stale decisions.
    }
    throw new DemoError(409, 'CONCURRENT_UPDATE', 'Задача изменилась. Обновите состояние и повторите.');
  }
}

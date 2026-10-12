import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { DemoError, type DemoTask } from '../../core/src/demo.ts';
import { demoOrganizations } from '../../fixtures/src/index.ts';
import { PrismaDemoTaskService } from './prisma.ts';

/**
 * One durable step per lease. Steps have deterministic inputs and no live outbound.
 * A job may be reclaimed after a crash. "collect" is idempotent via preallocated
 * task/question UUIDs, so a crash between the demo creation and job transition
 * cannot create a second owner notification.
 */
export class DurableOrchestrator {
  private readonly db: PrismaClient;
  constructor(db: PrismaClient) { this.db = db; }

  async create(goal: unknown) {
    if (typeof goal !== 'string' || goal.trim().length < 3 || goal.trim().length > 500) {
      throw new DemoError(400, 'INVALID_GOAL', 'Описание задачи должно содержать от 3 до 500 символов');
    }
    const id = randomUUID();
    return this.db.$transaction(async tx => {
      const run = await tx.workflowRun.create({
        data: { id, goal: goal.trim(), clarificationId: randomUUID() }
      });
      await tx.workflowEvent.create({ data: { workflowId: id, kind: 'created' } });
      return run;
    });
  }

  async list() {
    return this.db.workflowRun.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100,
      include: { events: { orderBy: { createdAt: 'asc' } } }
    });
  }

  async get(id: string) {
    if (!UUID.test(id)) throw new DemoError(404, 'WORKFLOW_NOT_FOUND', 'Поручение не найдено');
    const run = await this.db.workflowRun.findUnique({
      where: { id }, include: { events: { orderBy: { createdAt: 'asc' } } }
    });
    if (!run) throw new DemoError(404, 'WORKFLOW_NOT_FOUND', 'Поручение не найдено');
    return run;
  }

  /** Safe on both queued jobs and questions already sent to Telegram. */
  async stop(id: string) {
    const run = await this.get(id);
    if (TERMINAL.includes(run.state)) return run;
    const tasks = new PrismaDemoTaskService(this.db);
    let completed = false;
    try {
      const task = await tasks.get(run.id);
      if (task.state === 'completed') completed = true;
      else if (task.state === 'waiting_owner') {
        try { await tasks.stop(run.id); }
        catch (error) {
          if (!(error instanceof DemoError && error.code === 'TASK_FINISHED')) throw error;
          completed = true;
        }
      }
    } catch (error) {
      if (!(error instanceof DemoError && error.code === 'TASK_NOT_FOUND')) throw error;
    }
    const state = completed ? 'completed' : 'cancelled';
    await this.db.$transaction(async tx => {
      const changed = await tx.workflowRun.updateMany({
        where: { id, state: { in: ACTIVE } },
        data: { state, step: 'done', leaseToken: null, leasedUntil: null, finishedAt: new Date() }
      });
      if (changed.count) await tx.workflowEvent.create({
        data: { workflowId: id, kind: completed ? 'completed' : 'stopped' }
      });
    });
    // Concurrent "collect" could create its question just after the first get.
    // It cannot commit advancement once stop has cleared its lease.
    if (!completed) {
      try { await tasks.stop(id); }
      catch (error) {
        if (!(error instanceof DemoError && ['TASK_NOT_FOUND', 'TASK_FINISHED'].includes(error.code))) throw error;
      }
    }
    return this.get(id);
  }

  /** Claim at most one runnable job; a second worker cannot own this lease. */
  async tick(now: Date = new Date()): Promise<string | null> {
    const candidates = await this.db.workflowRun.findMany({
      where: { state: { in: ACTIVE }, availableAt: { lte: now },
        OR: [{ leasedUntil: null }, { leasedUntil: { lte: now } }] },
      orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
      take: 20
    });
    for (const candidate of candidates) {
      const token = randomUUID();
      const claimed = await this.db.workflowRun.updateMany({
        where: { id: candidate.id, state: { in: ACTIVE }, availableAt: { lte: now },
          OR: [{ leasedUntil: null }, { leasedUntil: { lte: now } }] },
        data: { leaseToken: token, leasedUntil: new Date(now.getTime() + LEASE_MS) }
      });
      if (!claimed.count) continue;
      try {
        await this.runStep(candidate.id, token);
      } catch (error) {
        // Only the lease holder can reschedule. Never log private task content.
        const run = await this.db.workflowRun.findUnique({ where: { id: candidate.id } });
        const failures = (run?.failures ?? 0) + 1;
        const exhausted = failures >= 5;
        await this.db.$transaction(async tx => {
          const changed = await tx.workflowRun.updateMany({
            where: { id: candidate.id, leaseToken: token, state: { in: ACTIVE } },
            data: { failures, state: exhausted ? 'failed' : candidate.state,
              step: exhausted ? 'done' : candidate.step,
              finishedAt: exhausted ? new Date() : null,
              availableAt: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** failures)),
              leaseToken: null, leasedUntil: null,
              lastError: error instanceof Error ? error.name : 'UnknownError' }
          });
          if (changed.count) await tx.workflowEvent.create({
            data: { workflowId: candidate.id, kind: exhausted ? 'failed' : 'retry_scheduled',
              metadata: { failures } }
          });
        });
      }
      return candidate.id;
    }
    return null;
  }

  private async runStep(id: string, token: string): Promise<void> {
    const run = await this.db.workflowRun.findUniqueOrThrow({ where: { id } });
    if (run.leaseToken !== token || !ACTIVE.includes(run.state)) return;

    if (run.step === 'plan') {
      const plan = {
        version: 1, transport: 'mock', outbound: false,
        steps: ['plan', 'collect_mock_responses', 'await_owner_choice', 'finish'],
        organizations: demoOrganizations.map(org => ({ id: org.id, name: org.name, channel: org.channel }))
      };
      await this.advance(id, token, run.step, {
        step: 'collect', state: 'running', plan: plan as Prisma.InputJsonValue
      }, 'planned');
    } else if (run.step === 'collect') {
      const tasks = new PrismaDemoTaskService(this.db);
      await tasks.create(run.goal, { taskId: id, questionId: run.clarificationId });
      const advanced = await this.advance(id, token, run.step, {
        step: 'await_owner', state: 'waiting_owner', availableAt: new Date(Date.now() + POLL_MS),
        demoTaskId: id
      }, 'owner_question_created');
      if (!advanced) {
        // Lost/expired leases must not cancel a task owned by a different worker.
        const latest = await this.db.workflowRun.findUnique({ where: { id } });
        if (latest?.state === 'cancelled') {
          try { await tasks.stop(id); }
          catch (error) {
            if (!(error instanceof DemoError && error.code === 'TASK_FINISHED')) throw error;
          }
        }
      }
    } else if (run.step === 'await_owner') {
      const tasks = new PrismaDemoTaskService(this.db);
      const task: DemoTask = await tasks.get(id);
      if (task.state === 'completed' || task.state === 'cancelled') {
        await this.advance(id, token, run.step, {
          step: 'done', state: task.state, finishedAt: new Date()
        }, task.state === 'completed' ? 'completed' : 'stopped');
      } else {
        // Keep a durable waiting state and release the lease for other jobs.
        await this.db.workflowRun.updateMany({
          where: { id, leaseToken: token, step: 'await_owner', state: 'waiting_owner' },
          data: { leasedUntil: null, leaseToken: null, availableAt: new Date(Date.now() + POLL_MS) }
        });
      }
    }
  }

  private async advance(id: string, token: string, step: string,
    data: Prisma.WorkflowRunUpdateManyMutationInput, kind: string): Promise<boolean> {
    return this.db.$transaction(async tx => {
      const changed = await tx.workflowRun.updateMany({
        where: { id, leaseToken: token, step, state: { in: ACTIVE },
          leasedUntil: { gt: new Date() } },
        data: { ...data, failures: 0, lastError: null, leaseToken: null, leasedUntil: null }
      });
      if (changed.count) await tx.workflowEvent.create({ data: { workflowId: id, kind } });
      return changed.count === 1;
    });
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIVE = ['queued', 'running', 'waiting_owner'];
const TERMINAL = ['completed', 'cancelled', 'failed'];
const LEASE_MS = 30_000;
const POLL_MS = 3_000;

import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { DemoError, type DemoTask } from '../../core/src/demo.ts';
import { demoOrganizations } from '../../fixtures/src/index.ts';
import { PrismaDemoTaskService } from './prisma.ts';
import { MockResearchPlanner, questionsFromFields, validateProposal,
  type ResearchPlanner } from '../../llm/src/planner.ts';
import { extractQuotedFacts } from '../../core/src/evidence.ts';
import { expireWorkflowOwnerQuestions, type OwnerIdentity } from './owner-questions.ts';
import { authorizeTestText, authorizeWhatsAppTestText, type TestTextPolicy } from '../../transports/src/contracts.ts';

/**
 * One durable step per lease. Steps have deterministic inputs and no live outbound.
 * A job may be reclaimed after a crash. "collect" is idempotent via preallocated
 * task/question UUIDs, so a crash between the demo creation and job transition
 * cannot create a second owner notification.
 */
export class DurableOrchestrator {
  private readonly db: PrismaClient;
  private readonly policy: TestTextPolicy;
  private readonly tdlibPolicy: TestTextPolicy;
  private readonly planner: ResearchPlanner;
  private readonly whatsappPolicy: TestTextPolicy;
  private readonly owner: OwnerIdentity | undefined;
  constructor(db: PrismaClient,
    policy: TestTextPolicy = { enabled: false, allowedChatIds: new Set() },
    tdlibPolicy: TestTextPolicy = { enabled: false, allowedChatIds: new Set() },
    planner: ResearchPlanner = new MockResearchPlanner(),
    whatsappPolicy: TestTextPolicy = { enabled: false, allowedChatIds: new Set() },
    owner?: OwnerIdentity) {
    this.db = db; this.policy = policy; this.tdlibPolicy = tdlibPolicy;
    this.planner = planner; this.whatsappPolicy = whatsappPolicy;
    this.owner = owner;
  }

  async create(goal: unknown, options?: { transport?: string; targetChatId?: unknown }) {
    if (typeof goal !== 'string' || goal.trim().length < 3 || goal.trim().length > 500) {
      throw new DemoError(400, 'INVALID_GOAL', 'Описание задачи должно содержать от 3 до 500 символов');
    }
    const transport = options?.transport ?? 'mock';
    if (!['mock', 'telegram_test', 'telegram_user_test', 'whatsapp_user_test'].includes(transport)) {
      throw new DemoError(400, 'INVALID_TRANSPORT', 'Недопустимый канал');
    }
    if (transport === 'mock' && options?.targetChatId !== undefined) {
      throw new DemoError(400, 'UNEXPECTED_CHAT_ID', 'Chat ID допустим только для тестового канала');
    }
    const targetChatId = transport === 'mock' ? null
      : this.authorizeRecipient(transport, options?.targetChatId);
    const id = randomUUID();
    return this.db.$transaction(async tx => {
      const run = await tx.workflowRun.create({
        data: { id, goal: goal.trim(), clarificationId: randomUUID(), transport, targetChatId }
      });
      // Persist stable target identity once. Mock organizations are fixtures;
      // non-mock recipients are only explicitly allowlisted test chats.
      const targetSpecs = transport === 'mock'
        ? demoOrganizations.map(org => ({
            sourceKey: org.id, label: org.name, channel: org.channel,
            recipientId: null, origin: 'mock_fixture'
          }))
        : [{ sourceKey: 'consented-test-recipient', label: 'Разрешённый тестовый собеседник',
          channel: transport, recipientId: targetChatId, origin: 'explicit_test_allowlist' }];
      const targetRows = targetSpecs.map(target => ({ ...target, id: randomUUID(), workflowId: id }));
      await tx.workflowTarget.createMany({ data: targetRows });
      await tx.workflowConversation.createMany({ data: targetRows.map(target => ({
        workflowId: id, targetId: target.id, channel: target.channel,
        state: transport === 'mock' ? 'mock_simulation' : 'planned'
      })) });
      await tx.workflowEvent.create({ data: { workflowId: id, kind: 'created' } });
      return run;
    });
  }

  private policyFor(transport: string): TestTextPolicy {
    if (transport === 'telegram_user_test') return this.tdlibPolicy;
    if (transport === 'whatsapp_user_test') return this.whatsappPolicy;
    return this.policy;
  }

  private authorizeRecipient(transport: string, recipient: unknown): string {
    const policy = this.policyFor(transport);
    return transport === 'whatsapp_user_test'
      ? authorizeWhatsAppTestText(policy, recipient)
      : authorizeTestText(policy, recipient);
  }

  async list() {
    return this.db.workflowRun.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100,
      include: { events: { orderBy: { createdAt: 'asc' } },
        delivery: true, messages: { orderBy: { createdAt: 'asc' } },
        facts: { orderBy: { createdAt: 'asc' } },
        costs: { orderBy: { createdAt: 'asc' } },
        targets: { orderBy: { createdAt: 'asc' } },
        conversations: { orderBy: { createdAt: 'asc' } },
        ownerQuestions: { orderBy: { createdAt: 'asc' }, include: { notification: true } } }
    });
  }

  async get(id: string) {
    if (!UUID.test(id)) throw new DemoError(404, 'WORKFLOW_NOT_FOUND', 'Поручение не найдено');
    const run = await this.db.workflowRun.findUnique({
      where: { id }, include: { events: { orderBy: { createdAt: 'asc' } },
        delivery: true, messages: { orderBy: { createdAt: 'asc' } },
        facts: { orderBy: { createdAt: 'asc' } },
        costs: { orderBy: { createdAt: 'asc' } },
        targets: { orderBy: { createdAt: 'asc' } },
        conversations: { orderBy: { createdAt: 'asc' } },
        ownerQuestions: { orderBy: { createdAt: 'asc' }, include: { notification: true } } }
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
        where: { id, state: { in: [...ACTIVE, 'paused'] } },
        data: { state, pausedFrom: null, step: 'done', leaseToken: null, leasedUntil: null, finishedAt: new Date() }
      });
      if (changed.count) {
        await tx.workflowConversation.updateMany({
          where: { workflowId: id, state: { not: 'mock_simulation' } },
          data: { state: completed ? 'completed' : 'cancelled' }
        });
        await tx.workflowOwnerQuestion.updateMany({
          where: { workflowId: id, state: 'pending' }, data: { state: 'cancelled' }
        });
        await tx.workflowOwnerNotification.updateMany({
          where: { question: { workflowId: id }, state: 'queued' },
          data: { state: 'cancelled' }
        });
        await tx.workflowEvent.create({
          data: { workflowId: id, kind: completed ? 'completed' : 'stopped' }
        });
      }
    });
    await this.db.textDelivery.updateMany({
      where: { workflowId: id, state: 'queued' }, data: { state: 'cancelled' }
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

  /** Pause is a durable state, not a held lease. No new step can be claimed. */
  async pause(id: string) {
    // Compare the exact state read with the state being paused. Without CAS a
    // worker may advance running -> waiting_external between get() and update(),
    // leaving pausedFrom=running with step=await_external. Resume would then
    // permanently strand the workflow in the wrong state.
    for (let attempt = 0; attempt < 8; attempt++) {
      const run = await this.get(id);
      if (run.state === 'paused') return run;
      if (TERMINAL.includes(run.state)) {
        throw new DemoError(409, 'WORKFLOW_FINISHED', 'Поручение уже завершено');
      }
      const changed = await this.db.$transaction(async tx => {
        const result = await tx.workflowRun.updateMany({
          where: { id, state: run.state, step: run.step,
            leaseToken: run.leaseToken, pausedFrom: null },
          data: { state: 'paused', pausedFrom: run.state,
            leaseToken: null, leasedUntil: null }
        });
        if (result.count) await tx.workflowEvent.create({
          data: { workflowId: id, kind: 'paused' }
        });
        return result.count;
      });
      if (changed) return this.get(id);
    }
    throw new DemoError(409, 'CONCURRENT_UPDATE', 'Поручение изменилось. Повторите паузу.');
  }

  /** Restore the previous waiting/running state without replaying the outbox. */
  async resume(id: string) {
    const run = await this.get(id);
    if (run.state !== 'paused') throw new DemoError(409, 'NOT_PAUSED', 'Поручение не на паузе');
    if (!run.pausedFrom || !ACTIVE.includes(run.pausedFrom)) {
      throw new DemoError(409, 'INVALID_PAUSE_STATE', 'Некорректное состояние паузы');
    }
    await this.db.$transaction(async tx => {
      const changed = await tx.workflowRun.updateMany({
        where: { id, state: 'paused', pausedFrom: run.pausedFrom },
        data: { state: run.pausedFrom, pausedFrom: null, availableAt: new Date(),
          leaseToken: null, leasedUntil: null }
      });
      if (changed.count) await tx.workflowEvent.create({data:{workflowId:id,kind:'resumed'}});
    });
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
      // A model may propose only information fields. It cannot choose a contact,
      // identity, transport, tool or workflow state; deterministic policy owns those.
      if (run.transport !== 'mock') {
        this.authorizeRecipient(run.transport, run.targetChatId);
      }
      const proposal = validateProposal(await this.planner.propose(run.goal));
      const research = { fields: proposal.fields, rationale: proposal.rationale };
      if (run.transport === 'mock') {
        const plan = {
          version: 2, transport: 'mock', outbound: false, research,
          steps: ['plan', 'collect_mock_responses', 'await_owner_choice', 'finish'],
          organizations: demoOrganizations.map(org => ({ id: org.id, name: org.name, channel: org.channel }))
        };
        await this.advance(id, token, run.step, {
          step: 'collect', state: 'running', plan: plan as Prisma.InputJsonValue
        }, 'planned');
      } else {
        await this.advance(id, token, run.step, {
          step: 'send_text', state: 'running',
          plan: { version: 2, transport: run.transport === 'telegram_test' ?
            'telegram_bot_test' : run.transport,
            outbound: 'allowlisted_test_only', research,
            steps: ['plan', 'send_test_text', 'await_reply', 'finish'] }
        }, 'planned');
      }
    } else if (run.step === 'send_text') {
      const chatId = this.authorizeRecipient(run.transport, run.targetChatId);
      const stored = run.plan as { research?: unknown } | null;
      // Validate persisted model fields before interpolating into test message.
      const proposal = validateProposal(stored?.research);
      const researchQuestion = questionsFromFields(proposal.fields);
      await this.db.$transaction(async tx => {
        const updated = await tx.workflowRun.updateMany({
          where: { id, leaseToken: token, step: 'send_text', state: 'running',
            leasedUntil: { gt: new Date() } },
          data: { state: 'waiting_external', step: 'await_external',
            availableAt: new Date(Date.now() + POLL_MS), leaseToken: null, leasedUntil: null }
        });
        if (!updated.count) return;
        await tx.workflowConversation.updateMany({
          where: { workflowId: id, state: 'planned' },
          data: { state: 'waiting_external' }
        });
        await tx.textDelivery.create({
          data: { workflowId: id, chatId,
            channel: run.transport === 'telegram_test' ? 'telegram_bot_test' : run.transport,
            body: 'Integron · тестовый запрос #' + id.slice(0, 8) + '\n\n' +
              run.goal + '\n\nУточните: ' + researchQuestion +
              '\n\nОтветьте reply на это сообщение.',
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) }
        });
        await tx.workflowEvent.create({ data: { workflowId: id, kind: 'text_queued' } });
      });
    } else if (run.step === 'await_external') {
      const delivery = await this.db.textDelivery.findUnique({ where: { workflowId: id } });
      if (delivery && (delivery.state === 'unknown' || delivery.state === 'failed')) {
        await this.advance(id, token, run.step, {
          step: 'done', state: 'failed', finishedAt: new Date()
        }, delivery.state === 'unknown' ? 'send_unknown_review_required' : 'send_rejected');
      } else if (delivery && delivery.expiresAt <= new Date()) {
        await this.advance(id, token, run.step, {
          step: 'done', state: 'failed', finishedAt: new Date()
        }, 'external_reply_timeout');
      } else {
        await this.db.workflowRun.updateMany({
          where: { id, leaseToken: token, step: 'await_external', state: 'waiting_external' },
          data: { leasedUntil: null, leaseToken: null, availableAt: new Date(Date.now() + POLL_MS) }
        });
      }
    } else if (run.step === 'process_external') {
      const received = await this.db.textMessage.findFirst({
        where: { workflowId: id, direction: 'in' }, orderBy: { createdAt: 'asc' }
      });
      if (!received) throw new Error('Missing correlated text evidence');
      const quotes = extractQuotedFacts(received.body);
      const needsOwner = quotes.some(fact => fact.status === 'conflicting');
      // Facts and state advance share a transaction. A concurrent stop clears
      // the lease, preventing a cancelled task from manufacturing a report.
      await this.db.$transaction(async tx => {
        const changed = await tx.workflowRun.updateMany({
          where: { id, leaseToken: token, step: 'process_external', state: 'running',
            leasedUntil: { gt: new Date() } },
          data: { step: needsOwner ? 'await_conflict_review' : 'done',
            state: needsOwner ? 'waiting_owner' : 'completed',
            availableAt: needsOwner ? new Date(Date.now() + POLL_MS) : run.availableAt,
            finishedAt: needsOwner ? null : new Date(),
            failures: 0, lastError: null, leaseToken: null, leasedUntil: null }
        });
        if (!changed.count) return;
        await tx.workflowConversation.updateMany({
          where: { workflowId: id, state: { not: 'mock_simulation' } },
          data: { state: needsOwner ? 'needs_review' : 'completed' }
        });
        if (quotes.length) {
          await tx.workflowFact.createMany({
            data: quotes.map(q => ({ workflowId: id, messageId: received.id,
              field: q.field, value: q.value, quote: q.quote,
              startOffset: q.startOffset, endOffset: q.endOffset, status: q.status })),
            skipDuplicates: true
          });
        }
        if (needsOwner) {
          // Fixed safe prompt. Never echo untrusted chat text into owner Telegram.
          // The answer is advisory data, not a permission for more sends or spending.
          const question = await tx.workflowOwnerQuestion.create({
            data: {
              id: run.clarificationId, workflowId: id,
              requestKey: 'conflict:' + received.id, sourceMessageId: received.id,
              prompt: 'В ответе тестового собеседника обнаружены противоречивые сведения. ' +
                'Укажи, что проверить вручную. Ответ будет сохранён, новых сообщений агент не отправит.',
              ownerUserId: this.owner?.userId ?? null,
              ownerChatId: this.owner?.chatId ?? null,
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
            }
          });
          if (this.owner) {
            await tx.workflowOwnerNotification.create({ data: { questionId: question.id } });
          }
        }
        await tx.workflowEvent.create({
          data: { workflowId: id, kind: needsOwner ? 'conflict_review_requested' : 'text_reply_processed',
            metadata: { extractedFacts: quotes.length } }
        });
      });
    } else if (run.step === 'await_conflict_review') {
      const question = await this.db.workflowOwnerQuestion.findUnique({
        where: { id: run.clarificationId }
      });
      if (!question || question.workflowId !== id) throw new Error('Missing scoped owner question');
      if (question.state === 'answered') {
        await this.advance(id, token, run.step, {
          step: 'done', state: 'completed', finishedAt: new Date()
        }, 'conflict_review_recorded');
      } else if (question.state === 'expired' || question.expiresAt <= new Date()) {
        if (question.state === 'pending') await expireWorkflowOwnerQuestions(this.db);
        await this.advance(id, token, run.step, {
          step: 'done', state: 'failed', finishedAt: new Date()
        }, 'conflict_review_timeout');
      } else if (question.state === 'cancelled') {
        await this.advance(id, token, run.step, {
          step: 'done', state: 'cancelled', finishedAt: new Date()
        }, 'conflict_review_cancelled');
      } else {
        await this.db.workflowRun.updateMany({
          where: { id, leaseToken: token, state: 'waiting_owner', step: 'await_conflict_review' },
          data: { leaseToken: null, leasedUntil: null,
            availableAt: new Date(Date.now() + POLL_MS) }
        });
      }
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
      if (changed.count) {
        if (kind === 'conflict_review_recorded') {
          await tx.workflowConversation.updateMany({
            where: { workflowId: id, state: 'needs_review' }, data: { state: 'reviewed' }
          });
        }
        if (['send_unknown_review_required', 'send_rejected', 'external_reply_timeout',
            'conflict_review_timeout', 'conflict_review_cancelled'].includes(kind)) {
          await tx.workflowConversation.updateMany({
            where: { workflowId: id, state: { in: ['waiting_external', 'needs_review'] } },
            data: { state: 'failed' }
          });
        }
        await tx.workflowEvent.create({ data: { workflowId: id, kind } });
      }
      return changed.count === 1;
    });
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIVE = ['queued', 'running', 'waiting_owner', 'waiting_external'];
const TERMINAL = ['completed', 'cancelled', 'failed'];
const LEASE_MS = 30_000;
const POLL_MS = 3_000;

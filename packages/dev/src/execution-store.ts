/**
 * D5b durable journal, no provider calls, MCP handlers, GitHub write or automatic dispatch.
 * The privileged methods must only be invoked from an authenticated LOCAL owner coordinator.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { AgentRunnerError } from './agent-runner.ts';
import {
  createManagedIntent, digestManagedIntent, uuidFormat, type ManagedCreateIntent
} from './execution-intent.ts';
import { planInExecutionTransaction } from './execution-plan.ts';
import { createManagedPromptIntent, digestManagedPromptIntent, type ManagedPromptIntent } from './prompt-intent.ts';

const KEY = /^[0-9a-f]{64}$/;
const SESSION_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const LOCK = 'SELECT pg_advisory_xact_lock(2026101805)::text';
const fail = (code: string): never => { throw new AgentRunnerError(code); };
const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const interval = 10 * 60_000;
export interface PreparedExecution {
  id: string;
  sessionId: string;
  taskId: string;
  state: string;
  digest: string;
  expiresAt: string;
}
type ExecutionSummary = {
  id: string; sessionId: string; taskId: string; state: string;
  intentDigest: string; expiresAt: Date;
};
const summary = (r: ExecutionSummary): PreparedExecution => ({
  id: r.id, sessionId: r.sessionId, taskId: r.taskId,
  state: r.state, digest: r.intentDigest, expiresAt: r.expiresAt.toISOString()
});

export class DevExecutionStore {
  private readonly db: PrismaClient;
  constructor(db: PrismaClient) { this.db = db; }

  async prepareCreate(input: Omit<ManagedCreateIntent, 'version' | 'action'>,
    now = new Date()): Promise<PreparedExecution> {
    const intent = createManagedIntent(input);
    const digest = digestManagedIntent(intent);
    if (!Number.isFinite(now.getTime())) fail('INVALID_EXECUTION_TIME');
    return this.db.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(2026101802)::text');
      await tx.$queryRawUnsafe(LOCK);
      const previous = await tx.devExecution.findUnique({
        where: { taskId_requestKey: { taskId: intent.taskId, requestKey: intent.requestKey } }
      });
      if (previous) {
        if (previous.intentDigest !== digest) fail('EXECUTION_KEY_COLLISION');
        return summary(previous);
      }
      const task = await tx.devTask.findUnique({
        where: { id: intent.taskId }, include: { phase: true }
      });
      const repository = await tx.devRepository.findUnique({
        where: { fullName: intent.repository }
      });
      if (!task || !repository || !repository.enabled ||
          repository.projectSlug !== task.phase.projectSlug) {
        fail('EXECUTION_SCOPE_DENIED');
      }
      const snapshot = await tx.devGithubSnapshot.findUnique({
        where: { repositoryId: repository.id }
      });
      if (!snapshot || snapshot.stale || snapshot.observedAt > new Date(now.getTime() + 60_000) ||
          now.getTime() - snapshot.observedAt.getTime() > 30 * 60_000 ||
          !snapshot.payload || typeof snapshot.payload !== 'object' ||
          Array.isArray(snapshot.payload) ||
          (snapshot.payload as Record<string, unknown>).integrationSha !== intent.baseSha) {
        fail('INTEGRATION_SHA_CHANGED');
      }
      const scopes = Array.isArray(task.scopes) ? task.scopes : [];
      if (scopes.length !== 1 || !isObject(scopes[0]) ||
          scopes[0].repo !== intent.repository ||
          !Array.isArray(scopes[0].paths) || !scopes[0].paths.length) {
        fail('EXECUTION_SCOPE_DENIED');
      }
      const plan = await planInExecutionTransaction(tx, now);
      if (!plan.readyTaskIds.includes(task.id)) fail('EXECUTION_NOT_READY');
      if (await tx.devAgentSession.count({
        where: { taskId: task.id, state: { in: ['reserved','creating','active','unknown'] } }
      })) fail('EXECUTION_ALREADY_RESERVED');
      const session = await tx.devAgentSession.create({
        data: {
          taskId: intent.taskId, repositoryId: repository.id,
          provider: 'opencode', directory: intent.directory, branch: intent.branch,
          state: 'reserved'
        }
      });
      const execution = await tx.devExecution.create({
        data: {
          taskId: intent.taskId, sessionId: session.id, requestKey: intent.requestKey,
          action: intent.action, intent: intent as unknown as Prisma.InputJsonValue,
          intentDigest: digest, maxCostCents: intent.maxCostCents,
          state: 'pending', expiresAt: new Date(now.getTime() + interval)
        }
      });
      const changed = await tx.devTask.updateMany({
        where: { id: intent.taskId, state: 'planned' }, data: { state: 'paused' }
      });
      if (changed.count !== 1) fail('EXECUTION_CONCURRENT_STATE_CHANGE');
      return summary(execution);
    }, { timeout: 30_000 });
  }

  async inspect(id: string): Promise<PreparedExecution & {
    intent: ManagedCreateIntent; approvedBy: string | null
  }> {
    if (!uuidFormat.test(id)) fail('INVALID_EXECUTION_IDENTITY');
    const row = await this.db.devExecution.findUnique({ where: { id } });
    if (!row) fail('EXECUTION_NOT_FOUND');
    // Fail closed if stored JSON has been tampered with.
    if (!isObject(row.intent)) fail('EXECUTION_INTENT_INVALID');
    const intent = createManagedIntent(row.intent as unknown as Omit<ManagedCreateIntent, 'version'|'action'>);
    if (digestManagedIntent(intent) !== row.intentDigest || intent.taskId !== row.taskId ||
        intent.requestKey !== row.requestKey) fail('EXECUTION_INTENT_INVALID');
    return { ...summary(row), intent, approvedBy: row.approvedBy };
  }

  /** Privileged LOCAL-only operation, after separate interactive owner confirmation. */
  async approveLocal(id: string, digest: string, actor: string,
    now = new Date()): Promise<PreparedExecution> {
    if (!uuidFormat.test(id) || !KEY.test(digest) ||
        actor !== 'local-owner' || !Number.isFinite(now.getTime())) fail('INVALID_APPROVAL');
    return this.db.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(2026101802)::text');
      await tx.$queryRawUnsafe(LOCK);
      const row = await tx.devExecution.findUnique({ where: { id } });
      if (!row || row.intentDigest !== digest) fail('EXECUTION_APPROVAL_MISMATCH');
      if (row.state !== 'pending') fail('EXECUTION_NOT_PENDING');
      if (row.expiresAt <= now) fail('EXECUTION_EXPIRED');
      const updated = await tx.devExecution.updateMany({
        where: { id, state: 'pending', intentDigest: digest, expiresAt: { gt: now } },
        data: { state: 'approved', approvedAt: now, approvedBy: actor }
      });
      if (updated.count !== 1) fail('EXECUTION_CONCURRENT_STATE_CHANGE');
      return summary({ ...row, state: 'approved' });
    });
  }

  /**
   * One-shot fencing claim BEFORE the provider request.
   * If the process crashes, 'attempting' is held for manual reconciliation.
   * This never auto-retries or publishes a prompt.
   */
  async claimApproved(id: string, digest: string,
    now = new Date()): Promise<{ fence: number; intent: ManagedCreateIntent; sessionId: string }> {
    if (!uuidFormat.test(id) || !KEY.test(digest) || !Number.isFinite(now.getTime())) {
      fail('INVALID_EXECUTION_IDENTITY');
    }
    return this.db.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(2026101802)::text');
      await tx.$queryRawUnsafe(LOCK);
      const row = await tx.devExecution.findUnique({
        where: { id }, include: { session: true }
      });
      if (!row || row.state !== 'approved' || row.intentDigest !== digest ||
          !row.approvedAt || row.approvedBy !== 'local-owner') fail('EXECUTION_NOT_APPROVED');
      if (row.expiresAt <= now) fail('EXECUTION_EXPIRED');
      if (row.session.state !== 'reserved') fail('AGENT_SESSION_NOT_RESERVED');
      const openBlockers = await tx.devBlocker.count({ where: { taskId: row.taskId, state: 'open' } });
      if (openBlockers !== 0) fail('EXECUTION_NEW_BLOCKER');
      const repo = await tx.devRepository.findUnique({
        where: { id: row.session.repositoryId }, include: { snapshot: true }
      });
      const current = repo?.snapshot;
      if (!repo?.enabled || !current || current.stale ||
          now.getTime() - current.observedAt.getTime() > 30 * 60_000 ||
          current.observedAt.getTime() > now.getTime() + 60_000) {
        fail('EXECUTION_REPOSITORY_STALE');
      }
      const intent = createManagedIntent(row.intent as unknown as Omit<ManagedCreateIntent,'version'|'action'>);
      if (digestManagedIntent(intent) !== row.intentDigest ||
          intent.taskId !== row.taskId) fail('EXECUTION_INTENT_INVALID');
      const snapshotPayload = current.payload;
      if (!snapshotPayload || typeof snapshotPayload !== 'object' ||
          Array.isArray(snapshotPayload) ||
          (snapshotPayload as Record<string, unknown>).integrationSha !== intent.baseSha) {
        fail('INTEGRATION_SHA_CHANGED');
      }
      const changed = await tx.devExecution.updateMany({
        where: { id, state: 'approved', fence: row.fence },
        data: { state: 'attempting', fence: { increment: 1 }, claimedAt: now }
      });
      if (changed.count !== 1) fail('EXECUTION_CONCURRENT_STATE_CHANGE');
      await tx.devAgentSession.update({
        where: { id: row.sessionId }, data: { state: 'creating' }
      });
      return { fence: row.fence + 1, sessionId: row.sessionId, intent };
    });
  }

  async settleAttempt(id: string, fence: number,
    result: { outcome: 'acknowledged'; externalId: string } |
      { outcome: 'unknown'; errorCode: string }, now = new Date()): Promise<void> {
    if (!uuidFormat.test(id) || !Number.isInteger(fence) || fence <= 0 ||
        !Number.isFinite(now.getTime())) fail('INVALID_EXECUTION_IDENTITY');
    if (result.outcome === 'acknowledged') {
      if (!SESSION_ID.test(result.externalId)) fail('INVALID_SESSION_ID');
    } else if (!/^[A-Z0-9_]{3,70}$/.test(result.errorCode)) {
      fail('INVALID_EXECUTION_ERROR');
    }
    await this.db.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(2026101802)::text');
      await tx.$queryRawUnsafe(LOCK);
      const row = await tx.devExecution.findUnique({ where: { id } });
      if (!row || row.state !== 'attempting' || row.fence !== fence) {
        fail('EXECUTION_FENCE_MISMATCH');
      }
      await tx.devExecution.update({
        where: { id }, data: {
          state: result.outcome, completedAt: now,
          errorCode: result.outcome === 'unknown' ? result.errorCode : null
        }
      });
      await tx.devAgentSession.update({
        where: { id: row.sessionId },
        data: result.outcome === 'acknowledged'
          ? { state: 'active', externalId: result.externalId }
          : { state: 'unknown' }
      });
      // Task remains D2 paused. Provider ACK is NOT code acceptance.
    });
  }


  /**
   * Prepare a separately approved prompt on an acknowledged local session.
   * No prompt text is saved or sent. Only the SHA-256 digest is persisted.
   */
  async preparePrompt(input: {
    sessionId: string; requestKey: string; promptSha256: string;
    modelID: string; maxCostCents: 0
  }, now = new Date()): Promise<PreparedExecution> {
    if (!uuidFormat.test(input.sessionId) || !Number.isFinite(now.getTime())) {
      fail('INVALID_EXECUTION_IDENTITY');
    }
    return this.db.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(2026101802)::text');
      await tx.$queryRawUnsafe(LOCK);
      const session = await tx.devAgentSession.findUnique({
        where: { id: input.sessionId }, include: {
          repository: { include: { snapshot: true } },
          task: { include: { phase: true } }
        }
      });
      if (!session || session.state !== 'active' || !session.externalId ||
          session.task.state !== 'paused' || !session.repository.enabled ||
          session.repository.projectSlug !== session.task.phase.projectSlug) {
        fail('PROMPT_SESSION_NOT_ACTIVE');
      }
      if (await tx.devBlocker.count({
        where: { taskId: session.taskId, state: 'open' }
      })) fail('EXECUTION_NEW_BLOCKER');
      const initial = await tx.devExecution.findFirst({
        where: { sessionId: session.id, action: 'create_session', state: 'acknowledged' },
        orderBy: { createdAt: 'asc' }
      });
      if (!initial) fail('SESSION_CREATE_UNVERIFIED');
      const original = createManagedIntent(initial.intent as unknown as
        Omit<ManagedCreateIntent,'version'|'action'>);
      if (digestManagedIntent(original) !== initial.intentDigest ||
          original.taskId !== session.taskId ||
          original.repository !== session.repository.fullName ||
          original.directory !== session.directory || original.branch !== session.branch) {
        fail('EXECUTION_INTENT_INVALID');
      }
      const snapshot = session.repository.snapshot;
      const payload = snapshot?.payload;
      if (!snapshot || snapshot.stale || !payload || typeof payload !== 'object' ||
          Array.isArray(payload) ||
          (payload as Record<string, unknown>).integrationSha !== original.baseSha ||
          now.getTime() - snapshot.observedAt.getTime() > 30 * 60_000 ||
          snapshot.observedAt.getTime() > now.getTime() + 60_000) {
        fail('INTEGRATION_SHA_CHANGED');
      }
      const intent = createManagedPromptIntent({
        taskId: session.taskId, sessionId: session.id,
        repository: session.repository.fullName, directory: session.directory,
        branch: session.branch, baseSha: original.baseSha,
        externalId: session.externalId, requestKey: input.requestKey,
        promptSha256: input.promptSha256,
        model: { providerID: 'ollama', modelID: input.modelID },
        maxCostCents: input.maxCostCents
      });
      const digest = digestManagedPromptIntent(intent);
      const previous = await tx.devExecution.findUnique({
        where: { taskId_requestKey: {
          taskId: session.taskId, requestKey: intent.requestKey
        } }
      });
      if (previous) {
        if (previous.intentDigest !== digest) fail('EXECUTION_KEY_COLLISION');
        return summary(previous);
      }
      const created = await tx.devExecution.create({
        data: {
          taskId: session.taskId, sessionId: session.id,
          requestKey: intent.requestKey, action: 'start_task',
          intent: intent as unknown as Prisma.InputJsonValue,
          intentDigest: digest, promptSha256: intent.promptSha256,
          maxCostCents: 0, state: 'pending',
          expiresAt: new Date(now.getTime() + interval)
        }
      });
      return summary(created);
    }, { timeout: 30_000 });
  }

  async inspectPrompt(id: string): Promise<PreparedExecution & {
    intent: ManagedPromptIntent; approvedBy: string | null
  }> {
    if (!uuidFormat.test(id)) fail('INVALID_EXECUTION_IDENTITY');
    const row = await this.db.devExecution.findUnique({ where: { id } });
    if (!row || row.action !== 'start_task') fail('PROMPT_EXECUTION_NOT_FOUND');
    const intent = createManagedPromptIntent(row.intent as unknown as
      Omit<ManagedPromptIntent,'version'|'action'>);
    if (digestManagedPromptIntent(intent) !== row.intentDigest ||
        intent.sessionId !== row.sessionId || intent.taskId !== row.taskId ||
        row.promptSha256 !== intent.promptSha256) {
      fail('EXECUTION_INTENT_INVALID');
    }
    return { ...summary(row), intent, approvedBy: row.approvedBy };
  }

  async claimPromptApproved(id: string, digest: string,
    now = new Date()): Promise<{
      fence: number; intent: ManagedPromptIntent
    }> {
    if (!uuidFormat.test(id) || !KEY.test(digest) || !Number.isFinite(now.getTime())) {
      fail('INVALID_EXECUTION_IDENTITY');
    }
    return this.db.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(2026101802)::text');
      await tx.$queryRawUnsafe(LOCK);
      const row = await tx.devExecution.findUnique({
        where: { id }, include: { session: {
          include: { repository: { include: { snapshot: true } } }
        } }
      });
      if (!row || row.action !== 'start_task' || row.state !== 'approved' ||
          row.intentDigest !== digest || row.approvedBy !== 'local-owner' ||
          !row.approvedAt || row.expiresAt <= now) fail('PROMPT_NOT_APPROVED');
      const intent = createManagedPromptIntent(row.intent as unknown as
        Omit<ManagedPromptIntent,'version'|'action'>);
      if (digestManagedPromptIntent(intent) !== digest ||
          row.promptSha256 !== intent.promptSha256 ||
          intent.sessionId !== row.sessionId || intent.taskId !== row.taskId ||
          row.session.state !== 'active' ||
          row.session.externalId !== intent.externalId ||
          row.session.directory !== intent.directory ||
          row.session.branch !== intent.branch ||
          row.session.repository.fullName !== intent.repository) {
        fail('PROMPT_SCOPE_CHANGED');
      }
      const repo = row.session.repository;
      const snap = repo.snapshot;
      if (!repo.enabled || !snap || snap.stale ||
          now.getTime() - snap.observedAt.getTime() > 30 * 60_000 ||
          snap.observedAt.getTime() > now.getTime() + 60_000 ||
          !snap.payload || typeof snap.payload !== 'object' ||
          Array.isArray(snap.payload) ||
          (snap.payload as Record<string, unknown>).integrationSha !== intent.baseSha) {
        fail('INTEGRATION_SHA_CHANGED');
      }
      if (await tx.devBlocker.count({
        where: { taskId: row.taskId, state: 'open' }
      })) fail('EXECUTION_NEW_BLOCKER');
      const changed = await tx.devExecution.updateMany({
        where: { id, state: 'approved', fence: row.fence },
        data: { state: 'attempting', fence: { increment: 1 }, claimedAt: now }
      });
      if (changed.count !== 1) fail('EXECUTION_CONCURRENT_STATE_CHANGE');
      return { fence: row.fence + 1, intent };
    });
  }

  async settlePromptAttempt(id: string, fence: number,
    result: { outcome: 'acknowledged' } |
      { outcome: 'unknown'; errorCode: string }, now = new Date()): Promise<void> {
    if (!uuidFormat.test(id) || !Number.isInteger(fence) || fence <= 0 ||
        !Number.isFinite(now.getTime())) fail('INVALID_EXECUTION_IDENTITY');
    if (result.outcome === 'unknown' && !/^[A-Z0-9_]{3,70}$/.test(result.errorCode)) {
      fail('INVALID_EXECUTION_ERROR');
    }
    await this.db.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(2026101802)::text');
      await tx.$queryRawUnsafe(LOCK);
      const row = await tx.devExecution.findUnique({ where: { id } });
      if (!row || row.action !== 'start_task' || row.state !== 'attempting' ||
          row.fence !== fence) fail('EXECUTION_FENCE_MISMATCH');
      await tx.devExecution.update({
        where: { id }, data: {
          state: result.outcome, completedAt: now,
          errorCode: result.outcome === 'unknown' ? result.errorCode : null
        }
      });
      if (result.outcome === 'unknown') {
        // Unknown provider outcome retains task scope and blocks new prompts.
        await tx.devAgentSession.update({
          where: { id: row.sessionId }, data: { state: 'unknown' }
        });
      }
      // ACK means prompt queued, NOT finished, CI verified or merged.
    });
  }

  /** Only unattempted expired approvals may release held scope. */
  async expireUnattempted(id: string, now = new Date()): Promise<boolean> {
    if (!uuidFormat.test(id) || !Number.isFinite(now.getTime())) {
      fail('INVALID_EXECUTION_IDENTITY');
    }
    return this.db.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(2026101802)::text');
      await tx.$queryRawUnsafe(LOCK);
      const row = await tx.devExecution.findUnique({
        where: { id }, include: { session: true }
      });
      if (!row || !['pending','approved'].includes(row.state) ||
          row.expiresAt > now) return false;
      if (row.action === 'start_task' && row.session.state === 'active') {
        await tx.devExecution.update({ where: { id }, data: { state: 'expired' } });
        // Never close the active session or unpause a task for an unattempted prompt.
        return true;
      }
      if (row.action !== 'create_session' || row.session.state !== 'reserved') return false;
      await tx.devExecution.update({ where: { id }, data: { state: 'expired' } });
      await tx.devAgentSession.update({
        where: { id: row.sessionId }, data: { state: 'closed' }
      });
      await tx.devTask.updateMany({
        where: { id: row.taskId, state: 'paused' }, data: { state: 'planned' }
      });
      return true;
    });
  }

  async listReconciliationNeeded() {
    return this.db.devExecution.findMany({
      where: { state: { in: ['attempting','unknown'] } },
      orderBy: { createdAt: 'asc' }, take: 100,
      select: { id: true, taskId: true, sessionId: true, state: true,
        claimedAt: true, errorCode: true, fence: true }
    });
  }
}

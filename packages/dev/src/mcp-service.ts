/**
 * D3 local MCP service: scoped reads and two-step owner-approved metadata writes.
 * No GitHub write, agent dispatch, phase acceptance, remote MCP auth or merge.
 */
import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { type DevMcpPrincipal, requireDevScope, DevMcpAuthError } from './mcp-auth.ts';
import { DevRoadmapStore } from './roadmap-store.ts';

export type DevMcpIntent =
  | { action: 'add_blocker'; taskId: string; kind: string; detail: string }
  | { action: 'resolve_blocker'; blockerId: string };
export interface PendingDecision {
  id: string;
  projectSlug: string;
  action: DevMcpIntent;
  digest: string;
  expiresAt: string;
  state: 'pending' | 'approved' | 'consumed' | 'rejected' | 'expired';
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const KEY = /^[a-zA-Z0-9_-]{12,80}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/i;
const TTL = 10 * 60_000;
export class DevMcpError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'DevMcpError';
  }
}
function validateIntent(input: DevMcpIntent): DevMcpIntent {
  if (!input || typeof input !== 'object') throw new DevMcpError('INVALID_INTENT');
  if (input.action === 'add_blocker') {
    if (!UUID.test(input.taskId) || !/^[a-z_]{2,50}$/.test(input.kind) ||
        typeof input.detail !== 'string' || input.detail.length < 3 ||
        input.detail.length > 500 || input.detail !== input.detail.trim() ||
        /[\u0000-\u001f\u007f]/.test(input.detail)) throw new DevMcpError('INVALID_INTENT');
    return { action: 'add_blocker', taskId: input.taskId.toLowerCase(),
      kind: input.kind, detail: input.detail };
  }
  if (input.action === 'resolve_blocker') {
    if (!UUID.test(input.blockerId)) throw new DevMcpError('INVALID_INTENT');
    return { action: 'resolve_blocker', blockerId: input.blockerId.toLowerCase() };
  }
  throw new DevMcpError('ACTION_FORBIDDEN');
}
function canonical(actorId: string, projectSlug: string, intent: DevMcpIntent): string {
  return JSON.stringify({ version: 1, actorId, projectSlug, ...intent });
}
export function intentDigest(actorId: string, projectSlug: string, intent: DevMcpIntent): string {
  return createHash('sha256').update(canonical(actorId, projectSlug, validateIntent(intent))).digest('hex');
}
function decodeIntent(value: unknown): DevMcpIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DevMcpError('CORRUPT_INTENT');
  }
  return validateIntent(value as DevMcpIntent);
}
function safeSnapshot(value: unknown) {
  const payload = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const items = Array.isArray(payload.pullRequests) ? payload.pullRequests : [];
  return {
    integrationSha: typeof payload.integrationSha === 'string' && SHA.test(payload.integrationSha)
      ? payload.integrationSha : null,
    observedAt: typeof payload.observedAt === 'string' ? payload.observedAt : null,
    partial: payload.partial === true,
    pullRequests: items.slice(0, 50).flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const pr = item as Record<string, unknown>;
      if (!Number.isInteger(pr.number)) return [];
      const checks = Array.isArray(pr.checkRuns) ? pr.checkRuns : [];
      const validStatus = (v: unknown): string =>
        typeof v === 'string' && /^[a-z_]{2,30}$/.test(v) ? v : 'unknown';
      return [{
        number: pr.number,
        state: validStatus(pr.state),
        draft: pr.draft === true,
        base: typeof pr.base === 'string' && /^[a-zA-Z0-9._/-]{1,120}$/.test(pr.base)
          ? pr.base : null,
        headSha: typeof pr.headSha === 'string' && SHA.test(pr.headSha)
          ? pr.headSha : null,
        mergedAt: typeof pr.mergedAt === 'string' ? pr.mergedAt : null,
        commitStatus: validStatus(pr.commitStatus),
        checksObserved: pr.checksObserved === true,
        checks: checks.slice(0, 100).flatMap(check => {
          if (!check || typeof check !== 'object' || Array.isArray(check)) return [];
          const row = check as Record<string, unknown>;
          return [{
            name: typeof row.name === 'string' ? row.name.slice(0, 100)
              .replace(/[\x00-\x1f\x7f]/g, '') : 'unknown',
            status: validStatus(row.status),
            conclusion: row.conclusion === null ? null : validStatus(row.conclusion)
          }];
        })
      }];
    })
  };
}
export class DevMcpService {
  private readonly db: PrismaClient;
  constructor(db: PrismaClient) { this.db = db; }

  async projects(principal: DevMcpPrincipal) {
    const rows = await this.db.devProject.findMany({
      where: { slug: { in: [...principal.allowedProjects] } },
      select: { slug: true, name: true, repositories: {
        select: { fullName: true, integrationBranch: true, enabled: true },
        orderBy: { fullName: 'asc' }
      } }, orderBy: { slug: 'asc' }
    });
    return rows;
  }

  async status(principal: DevMcpPrincipal, projectSlug: string) {
    requireDevScope(principal, projectSlug);
    const project = await this.db.devProject.findUnique({
      where: { slug: projectSlug },
      select: {
        slug: true, name: true,
        repositories: { orderBy: { fullName: 'asc' }, include: { snapshot: true } },
        phases: { select: { code: true, state: true } }
      }
    });
    if (!project) throw new DevMcpError('PROJECT_NOT_FOUND');
    const counts: Record<string, number> = {};
    for (const phase of project.phases) counts[phase.state] = (counts[phase.state] ?? 0) + 1;
    return { project: project.slug, name: project.name, phaseCounts: counts,
      repositories: project.repositories.map(repo => ({
        fullName: repo.fullName, branch: repo.integrationBranch,
        enabled: repo.enabled, stale: !repo.snapshot || repo.snapshot.stale ||
          Date.now() - repo.snapshot.observedAt.getTime() > 30 * 60_000,
        errorCode: repo.snapshot?.errorCode ?? null,
        ...safeSnapshot(repo.snapshot?.payload)
      }))
    };
  }

  async roadmap(principal: DevMcpPrincipal, projectSlug: string) {
    requireDevScope(principal, projectSlug);
    const phases = await this.db.devPhase.findMany({
      where: { projectSlug }, orderBy: { code: 'asc' },
      include: { prerequisites: { include: {
        prerequisite: { select: { projectSlug: true, code: true, state: true } }
      } }, tasks: { orderBy: { priority: 'asc' },
        select: { id: true, key: true, title: true, state: true, priority: true }
      } }
    });
    return phases.map(phase => ({
      id: phase.id, code: phase.code, workstream: phase.workstream, title: phase.title,
      state: phase.state, acceptedAt: phase.acceptedAt?.toISOString() ?? null,
      acceptanceCriteria: phase.acceptanceCriteria,
      prerequisites: phase.prerequisites.map(edge => ({
        project: principal.allowedProjects.includes(edge.prerequisite.projectSlug)
          ? edge.prerequisite.projectSlug : 'restricted',
        phase: principal.allowedProjects.includes(edge.prerequisite.projectSlug)
          ? edge.prerequisite.code : 'restricted',
        state: principal.allowedProjects.includes(edge.prerequisite.projectSlug)
          ? edge.prerequisite.state : 'restricted'
      })), tasks: phase.tasks
    }));
  }

  async blockers(principal: DevMcpPrincipal, projectSlug: string) {
    requireDevScope(principal, projectSlug);
    return this.db.devBlocker.findMany({
      where: { task: { phase: { projectSlug } } },
      orderBy: { createdAt: 'desc' }, take: 150,
      select: { id: true, taskId: true, kind: true, detail: true,
        state: true, createdAt: true, resolvedAt: true }
    });
  }

  async availableTasks(principal: DevMcpPrincipal, projectSlug: string) {
    requireDevScope(principal, projectSlug);
    const plan = await new DevRoadmapStore(this.db).plan();
    // The global scheduler uses all projects for conflict/capacity accounting.
    // Filter results and cross-project dependency refs before returning them.
    const accessibleIds = new Set((await this.db.devPhase.findMany({
      where: { projectSlug: { in: [...principal.allowedProjects] } },
      select: { id: true }
    })).map(phase => phase.id));
    const decisions = plan.decisions
      .filter(decision => decision.projectSlug === projectSlug)
      .map(decision => ({
        ...decision,
        reasons: decision.reasons.map(reason => ({
          code: reason.code,
          ref: reason.code === 'dependency_unverified' && reason.ref &&
            !accessibleIds.has(reason.ref) ? 'restricted' : reason.ref
        }))
      }));
    return { observedAt: plan.observedAt,
      readyTaskIds: decisions.filter(d => d.state === 'ready').map(d => d.taskId),
      decisions };
  }

  async decisions(principal: DevMcpPrincipal, projectSlug: string) {
    requireDevScope(principal, projectSlug);
    return this.db.devDecision.findMany({
      where: { projectSlug }, orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, state: true, actionType: true, intentDigest: true,
        createdAt: true, expiresAt: true, approvedAt: true, consumedAt: true }
    });
  }

  async request(
    principal: DevMcpPrincipal, projectSlug: string, requestKey: string,
    requestedIntent: DevMcpIntent
  ): Promise<PendingDecision> {
    requireDevScope(principal, projectSlug, true);
    if (!KEY.test(requestKey)) throw new DevMcpError('INVALID_IDEMPOTENCY_KEY');
    const intent = validateIntent(requestedIntent);
    await this.assertTarget(projectSlug, intent);
    const digest = intentDigest(principal.actorId, projectSlug, intent);
    const current = await this.db.devDecision.findUnique({
      where: { actorId_requestKey: { actorId: principal.actorId, requestKey } }
    });
    if (current) {
      if (current.intentDigest !== digest || current.projectSlug !== projectSlug) {
        throw new DevMcpError('IDEMPOTENCY_CONFLICT');
      }
      return this.decisionResponse(current);
    }
    try {
      const created = await this.db.$transaction(async tx => {
        const decision = await tx.devDecision.create({
          data: { actorId: principal.actorId, projectSlug, requestKey,
            actionType: intent.action, intent: intent as Prisma.InputJsonValue,
            intentDigest: digest, expiresAt: new Date(Date.now() + TTL) }
        });
        await tx.devEvent.create({
          data: { projectSlug, eventKey: 'requested:' + decision.id,
            actorId: principal.actorId, kind: 'decision_requested',
            targetId: decision.id, decisionId: decision.id,
            metadata: { digest, actionType: intent.action } }
        });
        return decision;
      });
      return this.decisionResponse(created);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        throw error;
      }
      const existing = await this.db.devDecision.findUnique({
        where: { actorId_requestKey: { actorId: principal.actorId, requestKey } }
      });
      if (!existing || existing.intentDigest !== digest || existing.projectSlug !== projectSlug) {
        throw new DevMcpError('IDEMPOTENCY_CONFLICT');
      }
      return this.decisionResponse(existing);
    }
  }

  /** Out of band ONLY: called by the operator's interactive local CLI. */
  async localDecision(
    id: string, digest: string, choice: 'approve' | 'reject'
  ): Promise<{ state: string; id: string }> {
    if (!UUID.test(id) || !DIGEST.test(digest)) throw new DevMcpError('INVALID_DECISION');
    const decision = await this.db.devDecision.findUnique({ where: { id } });
    if (!decision) throw new DevMcpError('DECISION_NOT_FOUND');
    if (decision.intentDigest !== digest) throw new DevMcpError('DIGEST_MISMATCH');
    if (decision.state !== 'pending') throw new DevMcpError('DECISION_ALREADY_CLOSED');
    if (decision.expiresAt.getTime() <= Date.now()) throw new DevMcpError('DECISION_EXPIRED');
    return this.db.$transaction(async tx => {
      const changed = await tx.devDecision.updateMany({
        where: { id, intentDigest: digest, state: 'pending',
          expiresAt: { gt: new Date() } },
        data: choice === 'approve'
          ? { state: 'approved', approvedAt: new Date(), approvedBy: 'local_tty_owner' }
          : { state: 'rejected', approvedBy: 'local_tty_owner' }
      });
      if (changed.count !== 1) throw new DevMcpError('DECISION_CONCURRENT_CHANGE');
      await tx.devEvent.create({
        data: { projectSlug: decision.projectSlug, actorId: 'local_tty_owner',
          eventKey: choice + ':' + id, kind: choice === 'approve' ? 'decision_approved' : 'decision_rejected',
          targetId: id, decisionId: id,
          metadata: { digest } }
      });
      return { state: choice === 'approve' ? 'approved' : 'rejected', id };
    });
  }

  async applyApproved(
    principal: DevMcpPrincipal, projectSlug: string, decisionId: string, digest: string
  ): Promise<{ decisionId: string; result: unknown; replay: boolean }> {
    requireDevScope(principal, projectSlug, true);
    if (!UUID.test(decisionId) || !DIGEST.test(digest)) throw new DevMcpError('INVALID_DECISION');
    return this.db.$transaction(async tx => {
      const decision = await tx.devDecision.findUnique({ where: { id: decisionId } });
      if (!decision || decision.projectSlug !== projectSlug || decision.actorId !== principal.actorId) {
        throw new DevMcpError('DECISION_NOT_FOUND');
      }
      if (decision.intentDigest !== digest) throw new DevMcpError('DIGEST_MISMATCH');
      if (decision.state === 'consumed') {
        return { decisionId, result: decision.result, replay: true };
      }
      if (decision.state !== 'approved' || !decision.approvedAt ||
          decision.approvedBy !== 'local_tty_owner') throw new DevMcpError('NOT_APPROVED');
      if (decision.expiresAt.getTime() <= Date.now()) throw new DevMcpError('DECISION_EXPIRED');
      const intent = decodeIntent(decision.intent);
      if (intentDigest(principal.actorId, projectSlug, intent) !== digest ||
          intent.action !== decision.actionType) throw new DevMcpError('CORRUPT_INTENT');
      // Atomic claim and writes in one transaction. A concurrent caller cannot
      // apply the same decision twice; rollback restores approval on failure.
      const changed = await tx.devDecision.updateMany({
        where: { id: decisionId, state: 'approved', intentDigest: digest,
          expiresAt: { gt: new Date() } },
        data: { state: 'consumed', consumedAt: new Date() }
      });
      if (changed.count !== 1) throw new DevMcpError('DECISION_CONCURRENT_CHANGE');
      let result: unknown;
      if (intent.action === 'add_blocker') {
        const target = await tx.devTask.findUnique({
          where: { id: intent.taskId }, include: { phase: true }
        });
        if (!target || target.phase.projectSlug !== projectSlug) {
          throw new DevMcpError('TARGET_CHANGED');
        }
        const created = await tx.devBlocker.create({
          data: { taskId: intent.taskId, kind: intent.kind, detail: intent.detail }
        });
        result = { blockerId: created.id, state: 'open' };
      } else {
        const target = await tx.devBlocker.findUnique({
          where: { id: intent.blockerId },
          include: { task: { include: { phase: true } } }
        });
        if (!target || target.task.phase.projectSlug !== projectSlug ||
            target.state !== 'open') throw new DevMcpError('TARGET_CHANGED');
        const updated = await tx.devBlocker.updateMany({
          where: { id: intent.blockerId, state: 'open' },
          data: { state: 'resolved', resolvedAt: new Date() }
        });
        if (updated.count !== 1) throw new DevMcpError('TARGET_CHANGED');
        result = { blockerId: intent.blockerId, state: 'resolved' };
      }
      await tx.devDecision.update({
        where: { id: decisionId },
        data: { result: result as Prisma.InputJsonValue }
      });
      await tx.devEvent.create({
        data: { projectSlug, actorId: principal.actorId,
          eventKey: 'applied:' + decisionId, decisionId,
          kind: 'approved_action_applied', targetId: decisionId,
          metadata: { digest, actionType: intent.action } }
      });
      return { decisionId, result, replay: false };
    }, { timeout: 15_000 });
  }

  async inspectLocalDecision(id: string) {
    if (!UUID.test(id)) throw new DevMcpError('INVALID_DECISION');
    const decision = await this.db.devDecision.findUnique({ where: { id } });
    if (!decision) throw new DevMcpError('DECISION_NOT_FOUND');
    return {
      id: decision.id, projectSlug: decision.projectSlug,
      actorId: decision.actorId, requestKey: decision.requestKey,
      action: decodeIntent(decision.intent), digest: decision.intentDigest,
      state: decision.state, expiresAt: decision.expiresAt.toISOString()
    };
  }

  private async assertTarget(projectSlug: string, intent: DevMcpIntent): Promise<void> {
    if (intent.action === 'add_blocker') {
      const target = await this.db.devTask.findUnique({
        where: { id: intent.taskId }, select: { phase: { select: { projectSlug: true } } }
      });
      if (!target || target.phase.projectSlug !== projectSlug) {
        throw new DevMcpAuthError('TARGET_FORBIDDEN');
      }
    } else {
      const target = await this.db.devBlocker.findUnique({
        where: { id: intent.blockerId },
        select: { state: true, task: { select: { phase: { select: { projectSlug: true } } } } }
      });
      if (!target || target.task.phase.projectSlug !== projectSlug) {
        throw new DevMcpAuthError('TARGET_FORBIDDEN');
      }
      if (target.state !== 'open') throw new DevMcpError('BLOCKER_NOT_OPEN');
    }
  }

  private decisionResponse(decision: {
    id: string; projectSlug: string; state: string; intent: unknown;
    intentDigest: string; expiresAt: Date
  }): PendingDecision {
    return { id: decision.id, projectSlug: decision.projectSlug,
      action: decodeIntent(decision.intent), digest: decision.intentDigest,
      expiresAt: decision.expiresAt.toISOString(),
      state: decision.state as PendingDecision['state'] };
  }
}

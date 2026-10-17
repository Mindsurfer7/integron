/**
 * D5c: read-only GitHub PR evidence reconciliation.
 * This NEVER merges, marks DevTask completed, or grants provider permissions.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { AgentRunnerError } from './agent-runner.ts';
import { GithubReadonlyClient, type ManagedPrEvidence } from './github.ts';
import { DEVELOPMENT_PROJECTS } from './registry.ts';
import { uuidFormat } from './execution-intent.ts';

export interface ObservedManagedPr {
  artifactId: string;
  sessionId: string;
  executionId: string;
  repository: string;
  prNumber: number;
  url: string;
  headSha: string;
  state: string;
  draft: boolean;
  checksObserved: boolean;
  /** Means GitHub PR/head was observed, NOT that CI or task is approved. */
  githubVerified: true;
  ciAccepted: false;
  phaseAccepted: false;
  observedAt: string;
}
export class DevPrEvidenceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code); this.code = code; this.name = 'DevPrEvidenceError';
  }
}
const error = (code: string): never => { throw new DevPrEvidenceError(code); };

export class DevPrEvidenceStore {
  constructor(private readonly db: PrismaClient,
    private readonly github: GithubReadonlyClient) {}

  async observe(sessionId: string, prNumber: number,
    now = new Date()): Promise<ObservedManagedPr> {
    if (!uuidFormat.test(sessionId) || !Number.isSafeInteger(prNumber) ||
        prNumber <= 0 || prNumber > 10_000_000 ||
        !Number.isFinite(now.getTime())) {
      return error('INVALID_PR_OBSERVATION');
    }
    const session = await this.db.devAgentSession.findUnique({
      where: { id: sessionId }, include: {
        repository: true,
        task: { include: { phase: true } },
        executions: { where: { action: 'create_session', state: 'acknowledged' },
          orderBy: { createdAt: 'asc' }, take: 1 }
      }
    });
    if (!session || session.state !== 'active' || !session.externalId ||
        session.executions.length !== 1 || !session.repository.enabled ||
        session.repository.projectSlug !== session.task.phase.projectSlug ||
        !DEVELOPMENT_PROJECTS.some(p => p.slug === session.task.phase.projectSlug &&
          p.repos.some(r => r.fullName === session.repository.fullName))) {
      return error('MANAGED_SESSION_NOT_VERIFIED');
    }
    const evidence = await this.github.managedPrEvidence(
      session.repository.fullName, prNumber, now
    );
    this.checkBinding(session.repository.fullName, session.repository.integrationBranch,
      session.branch, evidence);

    const preparedMetadata: Prisma.InputJsonValue = {
      prNumber, url: evidence.url, state: evidence.state,
      draft: evidence.draft, mergedAt: evidence.mergedAt,
      headBranch: evidence.headBranch, baseBranch: evidence.baseBranch,
      checksObserved: evidence.checksObserved,
      commitStatus: evidence.commitStatus,
      // Truncate/normalize untrusted CI labels. Evidence is never instructions.
      checkRuns: evidence.checkRuns.slice(0, 100).map(x => ({
        name: x.name.slice(0, 150), status: x.status,
        conclusion: x.conclusion
      })),
      note: 'GitHub observation only; no merge or task acceptance authorization'
    };
    const executionId = session.executions[0].id;
    const artifact = await this.db.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(2026101805)::text');
      // Revalidate after network call, before saving evidence.
      const latest = await tx.devAgentSession.findUnique({
        where: { id: sessionId }, include: { repository: true }
      });
      const execution = await tx.devExecution.findUnique({
        where: { id: executionId }
      });
      if (!latest || latest.state !== 'active' ||
          latest.repository.fullName !== evidence.repository ||
          latest.repository.integrationBranch !== evidence.baseBranch ||
          latest.branch !== evidence.headBranch ||
          !execution || execution.state !== 'acknowledged' ||
          execution.sessionId !== sessionId) return error('SESSION_CHANGED');
      return tx.devArtifact.upsert({
        where: { executionId_source_kind_sha: {
          executionId, source: 'github_observer',
          kind: 'pull_request', sha: evidence.headSha
        } },
        create: {
          sessionId, executionId, source: 'github_observer',
          kind: 'pull_request', repository: evidence.repository,
          sha: evidence.headSha, reference: evidence.url,
          verifiedAt: now, observedAt: now, metadata: preparedMetadata
        },
        update: { observedAt: now, verifiedAt: now, metadata: preparedMetadata }
      });
    });
    return {
      artifactId: artifact.id, sessionId, executionId,
      repository: evidence.repository, prNumber, url: evidence.url,
      headSha: evidence.headSha, state: evidence.state,
      draft: evidence.draft, checksObserved: evidence.checksObserved,
      githubVerified: true, ciAccepted: false, phaseAccepted: false,
      observedAt: evidence.observedAt
    };
  }

  private checkBinding(repo: string, integrationBranch: string,
    sessionBranch: string, evidence: ManagedPrEvidence): void {
    if (evidence.repository !== repo || evidence.headRepo !== repo ||
        evidence.baseBranch !== integrationBranch ||
        evidence.headBranch !== sessionBranch) {
      throw new DevPrEvidenceError('PR_SESSION_SCOPE_MISMATCH');
    }
  }
}

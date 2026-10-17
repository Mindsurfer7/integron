import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { DevExecutionStore } from '../packages/dev/src/execution-store.ts';
import { AgentRunnerError } from '../packages/dev/src/agent-runner.ts';
import { createManagedIntent, digestManagedIntent } from '../packages/dev/src/execution-intent.ts';
import { promptSha256 } from '../packages/dev/src/prompt-intent.ts';

test('D5b PostgreSQL: concurrent idempotency, fenced claims, unknown/expired outcomes', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const db = new PrismaClient();
  const now = new Date();
  const projectSlug = 'flowboard';
  const fullName = 'Qonbex/qonbaq-flowboard';
  const code = 'D5B-' + randomUUID().slice(0, 8);
  const branch = 'feat/d5b-' + code.toLowerCase();
  const key = 'd5b_request_' + randomUUID().slice(0, 12);
  const integrationSha = 'a'.repeat(40);
  const id = randomUUID();
  let phaseId: string | null = null;
  let repoId: string | null = null;
  let savedSnapshot: {
    payload: unknown; observedAt: Date; stale: boolean; errorCode: string | null
  } | null = null;
  let createdSnapshot = false;
  const store = new DevExecutionStore(db);
  const error = (code: string) => (e: unknown) =>
    e instanceof AgentRunnerError && e.code === code;
  try {
    await db.devProject.upsert({
      where: { slug: projectSlug }, create: { slug: projectSlug, name: 'Flowboard' },
      update: {}
    });
    const repository = await db.devRepository.upsert({
      where: { fullName }, create: { projectSlug, fullName, integrationBranch: 'dev' },
      update: {}
    });
    repoId = repository.id;
    const old = await db.devGithubSnapshot.findUnique({
      where: { repositoryId: repoId }
    });
    if (old) {
      savedSnapshot = {
        payload: old.payload, observedAt: old.observedAt,
        stale: old.stale, errorCode: old.errorCode
      };
    } else createdSnapshot = true;
    await db.devGithubSnapshot.upsert({
      where: { repositoryId: repoId },
      create: { repositoryId: repoId, payload: { integrationSha }, observedAt: now, stale: false },
      update: { payload: { integrationSha }, observedAt: now, stale: false, errorCode: null }
    });

    const phase = await db.devPhase.create({
      data: { projectSlug, code, title: 'D5 test isolated phase', workstream: 'test',
        acceptanceCriteria: ['Commit SHA and CI evidence'] }
    });
    phaseId = phase.id;
    await db.devTask.create({
      data: { id, phaseId, key: 'worker', title: 'D5 worker', priority: 0,
        scopes: [{ repo: fullName, paths: ['docs/d5b-fixture-unique/**'] }],
        coordinationKeys: [] }
    });
    const input = {
      taskId: id, repository: fullName, directory: '/tmp/d5b-' + code,
      branch, baseSha: integrationSha, title: 'D5 integration', requestKey: key, maxCostCents: 0
    };
    const [first, second] = await Promise.all([
      store.prepareCreate(input, now), store.prepareCreate(input, now)
    ]);
    assert.equal(first.id, second.id);
    assert.equal(first.sessionId, second.sessionId);
    assert.equal(first.state, 'pending');
    assert.equal(await db.devAgentSession.count({ where: { taskId: id } }), 1);
    assert.equal((await db.devTask.findUniqueOrThrow({ where: { id } })).state, 'paused');
    await assert.rejects(store.prepareCreate({ ...input, title: 'changed' }, now),
      error('EXECUTION_KEY_COLLISION'));
    await assert.rejects(store.prepareCreate({ ...input, requestKey: key + '_2' }, now),
      error('EXECUTION_NOT_READY'));

    assert.deepEqual((await store.inspect(first.id)).intent.title, input.title);
    await assert.rejects(store.approveLocal(first.id, 'f'.repeat(64), 'local-owner', now),
      error('EXECUTION_APPROVAL_MISMATCH'));
    await assert.rejects(store.approveLocal(first.id, first.digest, 'model', now),
      error('INVALID_APPROVAL'));
    const approved = await store.approveLocal(first.id, first.digest, 'local-owner', now);
    assert.equal(approved.state, 'approved');
    await assert.rejects(store.approveLocal(first.id, first.digest, 'local-owner', now),
      error('EXECUTION_NOT_PENDING'));

    // D3 blocker changes after preparation revoke dispatch until resolved.
    const blocker = await db.devBlocker.create({
      data: { taskId: id, kind: 'owner_review', detail: 'Approval revoked by D3' }
    });
    await assert.rejects(store.claimApproved(first.id, first.digest, now),
      error('EXECUTION_NEW_BLOCKER'));
    await db.devBlocker.delete({ where: { id: blocker.id } });
    // A changed integration branch HEAD invalidates the approved intent.
    await db.devGithubSnapshot.update({
      where: { repositoryId: repoId! }, data: { payload: { integrationSha: 'b'.repeat(40) } }
    });
    await assert.rejects(store.claimApproved(first.id, first.digest, now),
      error('INTEGRATION_SHA_CHANGED'));
    await db.devGithubSnapshot.update({
      where: { repositoryId: repoId! }, data: { payload: { integrationSha } }
    });
    // A stale observer snapshot must never authorize a new provider side effect.
    await db.devGithubSnapshot.update({
      where: { repositoryId: repoId! },
      data: { observedAt: new Date(now.getTime() - 60 * 60_000) }
    });
    await assert.rejects(store.claimApproved(first.id, first.digest, now),
      error('EXECUTION_REPOSITORY_STALE'));
    await db.devGithubSnapshot.update({
      where: { repositoryId: repoId! }, data: { observedAt: now }
    });
    const claim = await store.claimApproved(first.id, first.digest, now);
    assert.equal(claim.fence, 1);
    assert.equal(claim.sessionId, first.sessionId);
    await assert.rejects(store.claimApproved(first.id, first.digest, now),
      error('EXECUTION_NOT_APPROVED'));
    await assert.rejects(store.settleAttempt(first.id, 2, {
      outcome: 'acknowledged', externalId: 'ses_12345'
    }, now), error('EXECUTION_FENCE_MISMATCH'));
    await store.settleAttempt(first.id, claim.fence, {
      outcome: 'unknown', errorCode: 'OPENCODE_OUTCOME_UNKNOWN'
    }, now);
    const awaiting = await store.listReconciliationNeeded();
    assert.ok(awaiting.some(e => e.id === first.id && e.state === 'unknown'));
    assert.equal(await store.expireUnattempted(first.id, new Date(now.getTime() + 20 * 60_000)), false);
    assert.equal((await db.devTask.findUniqueOrThrow({ where: { id } })).state, 'paused');
    assert.equal((await db.devAgentSession.findUniqueOrThrow({
      where: { id: first.sessionId }
    })).state, 'unknown');

    // Expiration of a different, NEVER attempted task is safe to release.
    const secondTask = await db.devTask.create({
      data: { phaseId, key: 'another', title: 'D5 second worker', priority: 0,
        scopes: [{ repo: fullName, paths: ['docs/d5b-other-unique/**'] }],
        coordinationKeys: [] }
    });
    // The unknown session keeps a capacity slot; make it terminal only in test
    // after explicit operator-style fixture cleanup. Never production auto-release.
    await db.devAgentSession.update({
      where: { id: first.sessionId }, data: { state: 'closed' }
    });
    await db.devTask.update({ where: { id }, data: { state: 'cancelled' } });
    const other = await store.prepareCreate({
      ...input, taskId: secondTask.id, requestKey: key + '_other',
      branch: 'feat/d5b-second'
    }, now);
    assert.equal(await store.expireUnattempted(other.id, new Date(now.getTime() + 20 * 60_000)), true);
    assert.equal((await db.devTask.findUniqueOrThrow({ where: { id: secondTask.id } })).state, 'planned');

    // D5d: previously acknowledged empty session may acquire one separate,
    // exact-digest local-model prompt; task remains paused until PR/CI review.
    const thirdTask = await db.devTask.create({
      data: { phaseId, key: 'third', title: 'D5d local prompt', priority: 0,
        state: 'paused',
        scopes: [{ repo: fullName, paths: ['docs/d5d-third-unique/**'] }],
        coordinationKeys: [] }
    });
    const originalIntent = createManagedIntent({
      taskId: thirdTask.id, repository: fullName,
      directory: '/tmp/d5d-third', branch: 'feat/d5d-third',
      baseSha: integrationSha, title: 'D5d session',
      requestKey: 'create_request_123456', maxCostCents: 0
    });
    const thirdSession = await db.devAgentSession.create({ data: {
      taskId: thirdTask.id, repositoryId: repoId!,
      provider: 'opencode', directory: originalIntent.directory,
      branch: originalIntent.branch, externalId: 'ses_d5d_123',
      state: 'active'
    } });
    await db.devExecution.create({ data: {
      taskId: thirdTask.id, sessionId: thirdSession.id,
      requestKey: originalIntent.requestKey, action: 'create_session',
      intent: originalIntent, intentDigest: digestManagedIntent(originalIntent),
      state: 'acknowledged', maxCostCents: 0,
      expiresAt: new Date(now.getTime() + 60_000)
    } });
    const promptDigest = promptSha256('Write a short README inside scoped folder.');
    const promptInput = {
      sessionId: thirdSession.id, requestKey: 'prompt_request_123456',
      promptSha256: promptDigest, modelID: 'coder-local', maxCostCents: 0 as const
    };
    const pendingPrompt = await store.preparePrompt(promptInput, now);
    const replayPrompt = await store.preparePrompt(promptInput, now);
    assert.equal(pendingPrompt.id, replayPrompt.id);
    assert.equal(pendingPrompt.state, 'pending');
    await assert.rejects(store.preparePrompt({
      ...promptInput, promptSha256: 'b'.repeat(64)
    }, now), error('EXECUTION_KEY_COLLISION'));
    const inspected = await store.inspectPrompt(pendingPrompt.id);
    assert.equal(inspected.intent.model.providerID, 'ollama');
    assert.equal(inspected.intent.promptSha256, promptDigest);
    await store.approveLocal(pendingPrompt.id, pendingPrompt.digest, 'local-owner', now);
    const newBlocker = await db.devBlocker.create({ data: {
      taskId: thirdTask.id, kind: 'owner_review', detail: 'D3 owner blocker'
    } });
    await assert.rejects(store.claimPromptApproved(
      pendingPrompt.id, pendingPrompt.digest, now
    ), error('EXECUTION_NEW_BLOCKER'));
    await db.devBlocker.delete({ where: { id: newBlocker.id } });
    const promptClaim = await store.claimPromptApproved(
      pendingPrompt.id, pendingPrompt.digest, now
    );
    assert.equal(promptClaim.fence, 1);
    assert.equal(promptClaim.intent.externalId, 'ses_d5d_123');
    await assert.rejects(store.claimPromptApproved(
      pendingPrompt.id, pendingPrompt.digest, now
    ), error('PROMPT_NOT_APPROVED'));
    await store.settlePromptAttempt(pendingPrompt.id, promptClaim.fence, {
      outcome: 'acknowledged'
    }, now);
    assert.equal((await db.devAgentSession.findUniqueOrThrow({
      where: { id: thirdSession.id }
    })).state, 'active');
    assert.equal((await db.devTask.findUniqueOrThrow({
      where: { id: thirdTask.id }
    })).state, 'paused');

  } finally {
    if (phaseId) {
      const sessions = await db.devAgentSession.findMany({
        where: { task: { phaseId } }, select: { id: true }
      });
      const sessionIds = sessions.map(s => s.id);
      if (sessionIds.length) {
        await db.devArtifact.deleteMany({ where: { sessionId: { in: sessionIds } } });
        await db.devExecution.deleteMany({ where: { sessionId: { in: sessionIds } } });
        await db.devAgentSession.deleteMany({ where: { id: { in: sessionIds } } });
      }
      await db.devBlocker.deleteMany({ where: { task: { phaseId } } });
      await db.devTask.deleteMany({ where: { phaseId } });
      await db.devPhase.delete({ where: { id: phaseId } });
    }
    if (repoId) {
      if (savedSnapshot) {
        await db.devGithubSnapshot.update({
          where: { repositoryId: repoId },
          data: { payload: savedSnapshot.payload as never,
            observedAt: savedSnapshot.observedAt,
            stale: savedSnapshot.stale, errorCode: savedSnapshot.errorCode }
        });
      } else if (createdSnapshot) {
        await db.devGithubSnapshot.delete({ where: { repositoryId: repoId } });
      }
    }
    await db.$disconnect();
  }
});

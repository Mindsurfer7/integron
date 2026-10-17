import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { DevPrEvidenceStore } from '../packages/dev/src/pr-evidence.ts';
import { type GithubReadonlyClient, type ManagedPrEvidence } from '../packages/dev/src/github.ts';

test('D5c PostgreSQL: verified PR evidence upserts per SHA and never accepts a phase', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const db = new PrismaClient();
  const projectSlug = 'flowboard', fullName = 'Qonbex/qonbaq-flowboard';
  const code = 'D5C-' + randomUUID().slice(0, 8);
  const taskId = randomUUID();
  const SHA = 'a'.repeat(40);
  const now = new Date();
  let phaseId: string | null = null, sessionId: string | null = null;
  const pr: ManagedPrEvidence = {
    repository: fullName, number: 42,
    url: 'https://github.com/' + fullName + '/pull/42',
    headBranch: 'feat/d5c-evidence', headRepo: fullName, headSha: SHA,
    baseBranch: 'dev', state: 'open', draft: false, mergedAt: null,
    checksObserved: true,
    checkRuns: [{ name: 'unit', status: 'completed', conclusion: 'success', url: null }],
    commitStatus: 'success', observedAt: now.toISOString()
  };
  let response = pr;
  const calls: string[] = [];
  const client = {
    managedPrEvidence: async (repo: string, number: number) => {
      calls.push(repo + ':' + number);
      return response;
    }
  } as unknown as GithubReadonlyClient;
  try {
    await db.devProject.upsert({
      where: { slug: projectSlug },
      create: { slug: projectSlug, name: 'Flowboard' }, update: {}
    });
    const repository = await db.devRepository.upsert({
      where: { fullName }, create: {
        projectSlug, fullName, integrationBranch: 'dev'
      }, update: {}
    });
    const phase = await db.devPhase.create({
      data: {
        projectSlug, code, title: 'D5c evidence fixture',
        workstream: 'test', acceptanceCriteria: ['Independent owner review']
      }
    });
    phaseId = phase.id;
    await db.devTask.create({ data: {
      id: taskId, phaseId, key: 'evidence', title: 'D5c evidence',
      scopes: [{ repo: fullName, paths: ['docs/d5c-fixture/**'] }],
      coordinationKeys: [], state: 'paused'
    } });
    const session = await db.devAgentSession.create({ data: {
      taskId, repositoryId: repository.id, provider: 'opencode',
      directory: '/tmp/isolated-d5c-fixture', branch: 'feat/d5c-evidence',
      externalId: 'ses_d5c_' + randomUUID().replaceAll('-', '').slice(0, 10),
      state: 'active'
    } });
    sessionId = session.id;
    const executionId = randomUUID();
    await db.devExecution.create({ data: {
      id: executionId, taskId, sessionId, requestKey: 'request_d5c_' +
        randomUUID().slice(0, 12),
      action: 'create_session', intent: { safe: 'fixture' },
      intentDigest: 'f'.repeat(64), maxCostCents: 0, state: 'acknowledged',
      expiresAt: new Date(now.getTime() + 60_000)
    } });

    const service = new DevPrEvidenceStore(db, client);
    const first = await service.observe(sessionId, 42, now);
    assert.equal(first.headSha, SHA);
    assert.equal(first.githubVerified, true);
    assert.equal(first.ciAccepted, false);
    assert.equal(first.phaseAccepted, false);
    assert.equal(first.checksObserved, true);
    const second = await service.observe(sessionId, 42, new Date(now.getTime() + 1000));
    assert.equal(first.artifactId, second.artifactId);
    assert.equal(await db.devArtifact.count({ where: { sessionId } }), 1);
    assert.equal((await db.devPhase.findUniqueOrThrow({ where: { id: phaseId } })).state,
      'planned');

    response = { ...pr, headBranch: 'feat/attacker' };
    await assert.rejects(service.observe(sessionId, 42), /PR_SESSION_SCOPE_MISMATCH/);
    response = pr;
    await db.devAgentSession.update({ where: { id: sessionId },
      data: { state: 'unknown' } });
    await assert.rejects(service.observe(sessionId, 42), /MANAGED_SESSION_NOT_VERIFIED/);
    assert.equal(calls.length, 3);
  } finally {
    if (sessionId) {
      await db.devArtifact.deleteMany({ where: { sessionId } });
      await db.devExecution.deleteMany({ where: { sessionId } });
      await db.devAgentSession.delete({ where: { id: sessionId } });
    }
    if (phaseId) {
      await db.devTask.deleteMany({ where: { phaseId } });
      await db.devPhase.delete({ where: { id: phaseId } });
    }
    await db.$disconnect();
  }
});

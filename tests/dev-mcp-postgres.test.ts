import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { DevMcpService } from '../packages/dev/src/mcp-service.ts';
import { type DevMcpPrincipal } from '../packages/dev/src/mcp-auth.ts';

const SAFE_TEST_DB = /\/[a-zA-Z0-9_-]*(?:_ci|_test)(?:\?|$)/.test(
  process.env.DATABASE_URL ?? ''
);
const OWNER: DevMcpPrincipal = {
  actorId: 'local-owner', role: 'write',
  allowedProjects: ['qonbaq']
};
const READ: DevMcpPrincipal = {
  actorId: 'local-owner', role: 'read',
  allowedProjects: ['qonbaq']
};
const SHA = 'a'.repeat(40);

test('D3 owner approvals are exact, scoped, audited and replay-safe', {
  skip: !SAFE_TEST_DB
}, async () => {
  const db = new PrismaClient();
  const suffix = randomUUID().slice(0, 8);
  let phaseId: string | undefined;
  let taskId: string | undefined;
  try {
    await db.$connect();
    await db.devProject.upsert({
      where: { slug: 'qonbaq' },
      create: { slug: 'qonbaq', name: 'Qonbaq' },
      update: {}
    });
    const phase = await db.devPhase.create({
      data: {
        projectSlug: 'qonbaq', code: 'D3-TEST-' + suffix,
        workstream: 'd3', title: 'D3 audit acceptance fixture',
        acceptanceCriteria: ['Owner approved exact digest']
      }
    });
    phaseId = phase.id;
    const task = await db.devTask.create({
      data: {
        phaseId, key: 'fixture', title: 'Review blocker workflow',
        scopes: [{ repo: 'Qonbex/qonbaq', paths: ['apps/api/**'] }],
        coordinationKeys: []
      }
    });
    taskId = task.id;
    const api = new DevMcpService(db);
    const intent = {
      action: 'add_blocker' as const,
      taskId: task.id, kind: 'owner_review',
      detail: 'Need explicit approval before editing product roadmap'
    };
    const requestKey = randomUUID();
    await assert.rejects(() => api.request(READ, 'qonbaq', requestKey, intent),
      /WRITE_FORBIDDEN/);
    await assert.rejects(() => api.request(OWNER, 'flowboard', randomUUID(), intent),
      /PROJECT_FORBIDDEN/);
    const prepared = await api.request(OWNER, 'qonbaq', requestKey, intent);
    assert.equal(prepared.state, 'pending');
    const again = await api.request(OWNER, 'qonbaq', requestKey, intent);
    assert.equal(again.id, prepared.id);
    await assert.rejects(
      () => api.request(OWNER, 'qonbaq', requestKey, {
        ...intent, detail: 'Changed the intent after first request'
      }), /IDEMPOTENCY_CONFLICT/);
    await assert.rejects(() => api.applyApproved(OWNER, 'qonbaq', prepared.id, prepared.digest),
      /NOT_APPROVED/);
    assert.equal(await db.devBlocker.count({ where: { taskId: task.id } }), 0);
    await assert.rejects(() => api.localDecision(prepared.id, '0'.repeat(64), 'approve'),
      /DIGEST_MISMATCH/);
    const approved = await api.localDecision(prepared.id, prepared.digest, 'approve');
    assert.equal(approved.state, 'approved');
    await assert.rejects(() => api.localDecision(prepared.id, prepared.digest, 'approve'),
      /DECISION_ALREADY_CLOSED/);
    const result = await api.applyApproved(OWNER, 'qonbaq', prepared.id, prepared.digest);
    assert.equal(result.replay, false);
    const blockerId = (result.result as {blockerId: string}).blockerId;
    assert.ok(blockerId);
    assert.equal(await db.devBlocker.count({ where: { taskId: task.id } }), 1);
    const replay = await api.applyApproved(OWNER, 'qonbaq', prepared.id, prepared.digest);
    assert.equal(replay.replay, true);
    assert.deepEqual(replay.result, result.result);
    assert.equal(await db.devBlocker.count({ where: { taskId: task.id } }), 1);
    await assert.rejects(() => api.applyApproved(READ, 'qonbaq', prepared.id, prepared.digest),
      /WRITE_FORBIDDEN/);
    const eventKinds = (await db.devEvent.findMany({
      where: { decisionId: prepared.id }, select: { kind: true }
    })).map(row => row.kind).sort();
    assert.deepEqual(eventKinds, [
      'approved_action_applied', 'decision_approved', 'decision_requested'
    ]);
    // The database itself must refuse changes to the append-only audit.
    const oneEvent = await db.devEvent.findFirstOrThrow({ where: { decisionId: prepared.id } });
    await assert.rejects(() => db.devEvent.delete({ where: { id: oneEvent.id } }));
    await assert.rejects(() => db.devEvent.update({
      where: { id: oneEvent.id }, data: { kind: 'tampered' }
    }));

    const resolution = await api.request(OWNER, 'qonbaq', randomUUID(),
      { action: 'resolve_blocker', blockerId });
    const refused = await api.request(OWNER, 'qonbaq', randomUUID(), {
      action: 'add_blocker', taskId: task.id, kind: 'review',
      detail: 'This request will be rejected'
    });
    await api.localDecision(refused.id, refused.digest, 'reject');
    await assert.rejects(() => api.applyApproved(OWNER, 'qonbaq', refused.id, refused.digest),
      /NOT_APPROVED/);
    await api.localDecision(resolution.id, resolution.digest, 'approve');
    const resolved = await api.applyApproved(OWNER, 'qonbaq', resolution.id, resolution.digest);
    assert.deepEqual(resolved.result, { blockerId, state: 'resolved' });
    assert.equal((await db.devBlocker.findUniqueOrThrow({
      where: { id: blockerId }
    })).state, 'resolved');
    await assert.rejects(() => api.request(OWNER, 'qonbaq', randomUUID(),
      { action: 'resolve_blocker', blockerId }), /BLOCKER_NOT_OPEN/);

    const expired = await api.request(OWNER, 'qonbaq', randomUUID(), intent);
    await db.devDecision.update({
      where: { id: expired.id }, data: { expiresAt: new Date(0) }
    });
    await assert.rejects(() => api.localDecision(expired.id, expired.digest, 'approve'),
      /DECISION_EXPIRED/);

    const all = await api.decisions(OWNER, 'qonbaq');
    assert.ok(all.some(item => item.id === prepared.id && item.state === 'consumed'));
    const otherProject: DevMcpPrincipal = {
      actorId: 'other-user', role: 'write', allowedProjects: ['qonbaq']
    };
    await assert.rejects(
      () => api.applyApproved(otherProject, 'qonbaq', prepared.id, prepared.digest),
      /DECISION_NOT_FOUND/);
    // Even fabricated evidence cannot be supplied via D3: no phase acceptance action.
    assert.equal((await db.devPhase.findUniqueOrThrow({ where: { id: phaseId } })).acceptedAt, null);
    assert.match(SHA, /^[0-9a-f]{40}$/);
  } finally {
    // Audit and approvals remain immutable; only the synthetic phase/task are
    // removed, leaving no active task on this test DB. On production DB skip.
    if (taskId) await db.devBlocker.deleteMany({ where: { taskId } });
    if (phaseId) await db.devTask.deleteMany({ where: { phaseId } });
    if (phaseId) await db.devPhase.deleteMany({ where: { id: phaseId } });
    await db.$disconnect();
  }
});

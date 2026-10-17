import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { DevRoadmapStore } from '../packages/dev/src/roadmap-store.ts';

test('D2 imports cross-product DAG atomically, rejects cycles, preserves locks and blockers', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const db = new PrismaClient();
  const suffix = randomUUID().slice(0, 8);
  const qa = 'D2Q-' + suffix, fb = 'D2F-' + suffix, ms = 'D2M-' + suffix;
  const q = { projectSlug: 'qonbaq', code: qa, workstream: 'example', title: 'Backend foundation',
    acceptanceCriteria: ['Verified PR + repository SHA'], dependsOn: [],
    tasks: [{ key: 'backend', title: 'API work', priority: 10,
      scopes: [{ repo: 'Qonbex/qonbaq', paths: ['apps/api/**'] }],
      coordinationKeys: ['contract:demo-v1'] }] };
  const f = { projectSlug: 'flowboard', code: fb, workstream: 'example', title: 'UI integration',
    acceptanceCriteria: ['Visual review'], dependsOn: [{ projectSlug: 'qonbaq', code: qa }],
    tasks: [{ key: 'ui', title: 'UI work', priority: 20,
      scopes: [{ repo: 'Qonbex/qonbaq-flowboard', paths: ['src/**'] }],
      coordinationKeys: ['contract:demo-v1'] }] };
  const m = { projectSlug: 'mindsurfing', code: ms, workstream: 'example', title: 'Downstream build',
    acceptanceCriteria: ['Integration tested'], dependsOn: [{ projectSlug: 'flowboard', code: fb }],
    tasks: [{ key: 'web', title: 'Web work', priority: 30,
      scopes: [{ repo: 'MindsurfingClub/mindsurfing', paths: ['app/**'] }],
      coordinationKeys: [] }] };
  const manifest = { version: 1, phases: [q, f, m] };
  const codes = [qa, fb, ms];
  try {
    const store = new DevRoadmapStore(db);
    const once = await store.importManifest(manifest);
    assert.deepEqual(once, { phases: 3, tasks: 3, dependencies: 2 });
    await store.importManifest(manifest);
    const phases = await db.devPhase.findMany({
      where: { code: { in: codes } }, include: { tasks: true }
    });
    assert.equal(phases.length, 3);
    assert.ok(phases.every(p => p.state === 'planned' && p.acceptedAt === null &&
      p.acceptanceEvidence === null && p.tasks.length === 1));

    const ids = new Map(phases.map(p => [p.code, p.id]));
    const before = await db.devDependency.findMany({
      where: { phaseId: { in: [...ids.values()] } }
    });
    assert.equal(before.length, 2);
    await assert.rejects(() => store.importManifest({
      version: 1, phases: [{ ...q, dependsOn: [{ projectSlug: 'mindsurfing', code: ms }] }]
    }), /CYCLIC_DEPENDENCY/);
    // The rejected cycle was rolled back, including deletion/replacement of prior edges.
    const after = await db.devDependency.findMany({
      where: { phaseId: { in: [...ids.values()] } }
    });
    assert.deepEqual(after.map(x => x.phaseId + ':' + x.requiresPhaseId).sort(),
      before.map(x => x.phaseId + ':' + x.requiresPhaseId).sort());

    const frontend = phases.find(p => p.code === fb)!;
    const frontendTask = frontend.tasks[0];
    const blocker = await store.addBlocker(frontendTask.id, 'owner_decision',
      'Manual review of current UI contract');
    assert.equal(typeof blocker, 'string');
    const pending = await store.plan();
    const marked = pending.decisions.find(d => d.taskId === frontendTask.id)!;
    assert.equal(marked.state, 'blocked');
    assert.ok(marked.reasons.some(r => r.code === 'dependency_unverified'));
    assert.ok(marked.reasons.some(r => r.code === 'manual_blocker'));
    assert.equal(await store.resolveBlocker(blocker), true);
    assert.equal(await store.resolveBlocker(blocker), false);

    await db.devTask.update({ where: { id: frontendTask.id }, data: { state: 'running' } });
    await assert.rejects(() => store.importManifest({
      version: 1, phases: [{ ...f, tasks: [{
        ...f.tasks[0],
        scopes: [{ repo: 'Qonbex/qonbaq-flowboard', paths: ['other/**'] }]
      }] }]
    }), /TASK_LOCKED/);
    await db.devTask.update({ where: { id: frontendTask.id }, data: { state: 'planned' } });

    await db.devPhase.update({ where: { id: frontend.id }, data: { state: 'active' } });
    await assert.rejects(() => store.importManifest({
      version: 1, phases: [{ ...f, acceptanceCriteria: ['New criteria after work started'] }]
    }), /PHASE_LOCKED/);
    await db.devPhase.update({ where: { id: frontend.id }, data: { state: 'planned' } });
  } finally {
    const phases = await db.devPhase.findMany({
      where: { code: { in: codes } }, select: { id: true }
    });
    const ids = phases.map(p => p.id);
    if (ids.length) {
      await db.devDependency.deleteMany({ where: {
        OR: [{ phaseId: { in: ids } }, { requiresPhaseId: { in: ids } }]
      } });
      await db.devBlocker.deleteMany({ where: { task: { phaseId: { in: ids } } } });
      await db.devTask.deleteMany({ where: { phaseId: { in: ids } } });
      await db.devPhase.deleteMany({ where: { id: { in: ids } } });
    }
    await db.$disconnect();
  }
});

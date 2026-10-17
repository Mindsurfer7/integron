import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acceptedWithEvidence, buildDevelopmentPlan, pathsOverlap, tasksConflict,
  topologicalOrder, type PhaseNode, type TaskNode,
  type RepositoryObservation
} from '../packages/dev/src/planner.ts';
import { parseRoadmapManifest } from '../packages/dev/src/manifest.ts';

const NOW = new Date('2026-10-18T12:00:00.000Z');
const SHA = 'a'.repeat(40);
const BACK = 'Qonbex/qonbaq', MOBILE = 'Qonbex/qonbaq-mobile',
  FLOW = 'Qonbex/qonbaq-flowboard', MINDS = 'MindsurfingClub/mindsurfing';
const phase = (id: string, projectSlug: string, state: PhaseNode['state'] = 'planned'): PhaseNode => ({
  id, projectSlug, code: id, state,
  acceptanceCriteria: ['Evidence of tested acceptance'],
  acceptedAt: state === 'accepted' ? NOW.toISOString() : null,
  acceptanceEvidence: state === 'accepted'
    ? [{ repo: BACK, sha: SHA, verifiedAt: NOW.toISOString() }] : []
});
const task = (id: string, phaseId: string, repo: string, paths: string[], priority = 100): TaskNode => ({
  id, phaseId, key: id, title: 'Task ' + id, priority, state: 'planned',
  scopes: [{ repo, paths }], coordinationKeys: [], openBlockers: []
});
const observed = (repo: string, stale = false): RepositoryObservation => ({
  fullName: repo, enabled: true, stale,
  observedAt: NOW.toISOString(), integrationSha: SHA
});
const plan = (input: Partial<Parameters<typeof buildDevelopmentPlan>[0]> = {}) =>
  buildDevelopmentPlan({
    phases: [phase('F1','flowboard'), phase('C1','qonbaq')],
    dependencies: [], tasks: [], repositories: [observed(FLOW), observed(BACK), observed(MOBILE),
      observed(MINDS)], now: NOW, ...input
  });
const reason = (result: ReturnType<typeof plan>, taskId: string) =>
  result.decisions.find(decision => decision.taskId === taskId)?.reasons.map(x => x.code);

test('cross-project phase requires explicit acceptance evidence, not a merged PR', () => {
  const tasks = [task('cloud', 'C1', BACK, ['packages/cloud/**'])];
  const edge = [{ phaseId: 'C1', requiresPhaseId: 'F1' }];
  const waiting = plan({ tasks, dependencies: edge });
  assert.deepEqual(reason(waiting, 'cloud'), ['dependency_unverified']);
  assert.deepEqual(waiting.readyTaskIds, []);

  const noEvidence = phase('F1', 'flowboard', 'accepted');
  noEvidence.acceptanceEvidence = [];
  assert.equal(acceptedWithEvidence(noEvidence), false);
  assert.deepEqual(reason(plan({
    phases: [noEvidence, phase('C1','qonbaq')], tasks, dependencies: edge
  }), 'cloud'), ['dependency_unverified']);

  const ready = plan({
    phases: [phase('F1','flowboard','accepted'), phase('C1','qonbaq')],
    tasks, dependencies: edge
  });
  assert.deepEqual(ready.readyTaskIds, ['cloud']);
  assert.deepEqual(ready.orderedPhaseIds, ['F1', 'C1']);
});

test('full dependency graph rejects cycles, missing phases and duplicate edges', () => {
  const phases = [phase('A','qonbaq'), phase('B','flowboard'), phase('C','mindsurfing')];
  assert.deepEqual(topologicalOrder(phases, [
    { phaseId: 'C', requiresPhaseId: 'B' },
    { phaseId: 'B', requiresPhaseId: 'A' }
  ]), ['A','B','C']);
  assert.throws(() => topologicalOrder(phases, [
    { phaseId: 'A', requiresPhaseId: 'B' },
    { phaseId: 'B', requiresPhaseId: 'C' },
    { phaseId: 'C', requiresPhaseId: 'A' }
  ]), /CYCLIC_DEPENDENCY/);
  assert.throws(() => topologicalOrder(phases, [
    { phaseId: 'C', requiresPhaseId: 'UNKNOWN' }
  ]), /UNKNOWN_DEPENDENCY/);
  assert.throws(() => topologicalOrder(phases, [
    { phaseId: 'C', requiresPhaseId: 'B' },
    { phaseId: 'C', requiresPhaseId: 'B' }
  ]), /DUPLICATE_DEPENDENCY/);
});

test('parallel tasks are selected only for disjoint scope and capacity', () => {
  const tasks = [
    task('backend', 'C1', BACK, ['packages/cloud/**'], 1),
    task('mobile', 'C1', MOBILE, ['lib/**'], 2),
    task('backend-overlap', 'C1', BACK, ['packages/cloud/service.ts'], 3),
    task('backend-other', 'C1', BACK, ['packages/payments/**'], 4)
  ];
  const result = plan({ tasks });
  assert.deepEqual(result.readyTaskIds, ['backend', 'mobile', 'backend-other']);
  assert.ok(reason(result, 'backend-overlap')?.includes('selected_conflict'));
  assert.ok(reason(plan({ tasks, maxActivePerRepo: 1 }), 'backend-other')?.includes('repository_capacity'));
});

test('running/paused work retains conflicts; no reallocation after an expired session', () => {
  const existing = task('existing','C1',BACK,['prisma/schema.prisma']);
  existing.state = 'paused';
  const competing = task('migration','C1',BACK,['prisma/migrations/**']);
  const result = plan({ tasks: [existing, competing] });
  assert.equal(result.decisions.find(x => x.taskId === 'existing')?.state, 'active');
  assert.ok(reason(result, 'migration')?.includes('active_conflict'));
  assert.equal(pathsOverlap('prisma/schema.prisma', 'prisma/migrations/2026.sql'), true);
});

test('coordination keys detect cross-repository, cross-project contract overlap', () => {
  const a = task('api', 'C1', BACK, ['src/api/**']);
  a.coordinationKeys = ['contract:payment-v2'];
  const b = task('ui', 'F1', FLOW, ['src/ui/**']);
  b.coordinationKeys = ['contract:payment-v2'];
  assert.equal(tasksConflict(a, b), true);
  assert.ok(reason(plan({ tasks: [a, b] }), 'ui')?.includes('selected_conflict'));
});

test('stale, absent and disabled GitHub state are not treated as readiness', () => {
  const tasks = [task('frontend', 'F1', FLOW, ['src/**'])];
  assert.deepEqual(reason(plan({ tasks, repositories: [] }), 'frontend'), ['repository_unobserved']);
  assert.deepEqual(reason(plan({ tasks, repositories: [observed(FLOW, true)] }), 'frontend'),
    ['repository_stale']);
  const branchMissing = observed(FLOW);
  branchMissing.integrationSha = null;
  assert.deepEqual(reason(plan({ tasks, repositories: [branchMissing] }), 'frontend'),
    ['repository_missing_branch']);
  const old = observed(FLOW);
  old.observedAt = new Date(NOW.getTime() - 3_600_000).toISOString();
  assert.deepEqual(reason(plan({ tasks, repositories: [old] }), 'frontend'), ['repository_stale']);
});

test('explicit blockers and already accepted phases are not scheduled', () => {
  const blocked = task('blocked','C1',BACK,['packages/**']);
  blocked.openBlockers = ['owner-decision'];
  assert.ok(reason(plan({ tasks: [blocked] }), 'blocked')?.includes('manual_blocker'));
  assert.ok(reason(plan({
    phases: [phase('C1', 'qonbaq', 'accepted')],
    tasks: [blocked]
  }), 'blocked')?.includes('phase_already_accepted'));
});

test('manifest parser rejects foreign repos, traversal, wildcard injection and duplicate keys', () => {
  const good = {
    version: 1,
    phases: [{
      projectSlug: 'flowboard', code: 'F99', workstream: 'F', title: 'Example',
      acceptanceCriteria: ['Test and review output'],
      dependsOn: [{ projectSlug: 'qonbaq', code: 'C1' }],
      tasks: [{
        key: 'demo', title: 'Build new viewer', priority: 10,
        scopes: [{ repo: FLOW, paths: ['src/viewer/**'] }],
        coordinationKeys: ['flowboard:components']
      }]
    }]
  };
  const parsed = parseRoadmapManifest(good);
  assert.equal(parsed.phases[0].tasks[0].scopes[0].repo, FLOW);
  assert.deepEqual(parsed.phases[0].dependsOn, [{ projectSlug: 'qonbaq', code: 'C1' }]);
  assert.throws(() => parseRoadmapManifest({
    ...good, phases: [...good.phases, good.phases[0]]
  }), /DUPLICATE_MANIFEST_KEY/);
  assert.throws(() => parseRoadmapManifest({
    ...good, phases: [{ ...good.phases[0], tasks: [{
      ...good.phases[0].tasks[0], scopes: [{ repo: BACK, paths: ['src/**'] }]
    }] }]
  }), /REPOSITORY_OUT_OF_PROJECT/);
  assert.throws(() => parseRoadmapManifest({
    ...good, phases: [{ ...good.phases[0], tasks: [{
      ...good.phases[0].tasks[0], scopes: [{ repo: FLOW, paths: ['../secrets'] }]
    }] }]
  }), /INVALID_SCOPE_PATH/);
  assert.throws(() => parseRoadmapManifest({
    ...good, phases: [{ ...good.phases[0], tasks: [{
      ...good.phases[0].tasks[0], scopes: [{ repo: FLOW, paths: ['src/**/*.ts'] }]
    }] }]
  }), /INVALID_SCOPE_PATH/);
});

test('no implicit stage acceptance based on completion without verified evidence', () => {
  const completed = phase('F1','flowboard','accepted');
  completed.acceptedAt = null;
  assert.equal(acceptedWithEvidence(completed), false);
  completed.acceptedAt = NOW.toISOString();
  completed.acceptanceEvidence = [{ repo: FLOW, sha: 'not-a-sha', verifiedAt: NOW.toISOString() }];
  assert.equal(acceptedWithEvidence(completed), false);
});

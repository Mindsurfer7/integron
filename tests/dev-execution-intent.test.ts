import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createManagedIntent, digestManagedIntent, canTransitionExecution
} from '../packages/dev/src/execution-intent.ts';

const valid = () => ({
  taskId: randomUUID(), repository: 'Qonbex/qonbaq',
  directory: '/tmp/integron-agent/task-1',
  branch: 'feat/d5-task-1', baseSha: 'a'.repeat(40), title: 'Review backend adapter',
  requestKey: 'request_123456789', maxCostCents: 0
});

test('D5b intent digest binds workspace, branch, task, cost and request key', () => {
  const input = valid();
  const envelope = createManagedIntent(input);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.action, 'create_session');
  const digest = digestManagedIntent(envelope);
  assert.match(digest, /^[0-9a-f]{64}$/);
  for (const patch of [
    { branch: 'feat/other' }, { directory: '/tmp/integron-agent/task-2' },
    { maxCostCents: 10 }, { baseSha: 'b'.repeat(40) }, { requestKey: 'request_987654321' },
    { title: 'Another instruction' }, { taskId: randomUUID() }
  ]) {
    assert.notEqual(digestManagedIntent(createManagedIntent({ ...input, ...patch })), digest);
  }
});

test('D5b refuses foreign repo, traversal, bad branch, broken budget and malformed IDs', () => {
  const base = valid();
  for (const patch of [
    { repository: 'attacker/other' }, { directory: '/tmp/../secrets' },
    { directory: 'relative/root' }, { branch: 'main' },
    { branch: 'feat/../unsafe' }, { title: '\nunsafe' },
    { taskId: 'not-a-uuid' }, { requestKey: 'short' },
    { maxCostCents: -1 }, { maxCostCents: 100001 },
    { maxCostCents: 1.25 }, { baseSha: 'invalid' }
  ]) {
    assert.throws(() => createManagedIntent({ ...base, ...patch }));
  }
});

test('attempt lifecycle forbids retry from unknown, replay from ack and bypass of approval', () => {
  assert.equal(canTransitionExecution('pending', 'attempting'), false);
  assert.equal(canTransitionExecution('pending', 'approved'), true);
  assert.equal(canTransitionExecution('approved', 'attempting'), true);
  assert.equal(canTransitionExecution('attempting', 'unknown'), true);
  assert.equal(canTransitionExecution('attempting', 'acknowledged'), true);
  assert.equal(canTransitionExecution('unknown', 'attempting'), false);
  assert.equal(canTransitionExecution('acknowledged', 'approved'), false);
  assert.equal(canTransitionExecution('expired', 'approved'), false);
});

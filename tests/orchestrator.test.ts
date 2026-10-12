import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { DemoError } from '../packages/core/src/demo.ts';
import { PrismaDemoTaskService } from '../packages/storage/src/prisma.ts';
import { DurableOrchestrator } from '../packages/storage/src/orchestrator.ts';

async function fixture(fn: (db: PrismaClient, jobs: DurableOrchestrator, tasks: PrismaDemoTaskService) => Promise<void>) {
  const db = new PrismaClient();
  await db.$connect();
  try {
    await db.workflowRun.deleteMany();
    await db.demoTask.deleteMany();
    await fn(db, new DurableOrchestrator(db), new PrismaDemoTaskService(db));
  } finally {
    await db.workflowRun.deleteMany();
    await db.demoTask.deleteMany();
    await db.$disconnect();
  }
}

test('durable plan -> mock collect -> owner answer -> resume after restart', {
  skip: !process.env.DATABASE_URL
}, () => fixture(async (db, jobs, tasks) => {
  const original = await jobs.create('Сравни предложение трёх фирм');
  assert.equal(original.state, 'queued');
  assert.equal(await jobs.tick(), original.id);
  let state = await jobs.get(original.id);
  assert.equal(state.step, 'collect');
  assert.equal(state.state, 'running');
  assert.equal((state.plan as { outbound: boolean }).outbound, false);

  assert.equal(await jobs.tick(), original.id);
  state = await jobs.get(original.id);
  assert.equal(state.state, 'waiting_owner');
  assert.equal(state.demoTaskId, original.id);
  assert.equal((await tasks.get(original.id)).results.length, 3);
  assert.equal(await db.ownerNotification.count(), 1);

  const nextConnection = new PrismaClient();
  try {
    const restarted = new DurableOrchestrator(nextConnection);
    // A second instance points at the same database and reads persisted steps.
    assert.equal((await restarted.get(original.id)).step, 'await_owner');
    await tasks.answerQuestion(original.clarificationId, 'fastest');
    await db.workflowRun.update({ where: { id: original.id }, data: { availableAt: new Date(0) } });
    assert.equal(await restarted.tick(), original.id);
    state = await jobs.get(original.id);
    assert.equal(state.state, 'completed');
    assert.equal(state.step, 'done');
    assert.deepEqual(state.events.map(x => x.kind),
      ['created', 'planned', 'owner_question_created', 'completed']);
    assert.equal(await restarted.tick(), null);
  } finally { await nextConnection.$disconnect(); }
}));

test('crash between creating question and saving workflow transition is idempotent', {
  skip: !process.env.DATABASE_URL
}, () => fixture(async (db, jobs, tasks) => {
  const run = await jobs.create('Проверь варианты ответа');
  await jobs.tick(); // plan -> collect
  // Simulate executor crash *after* the transactional DemoTask insert.
  await tasks.create(run.goal, { taskId: run.id, questionId: run.clarificationId });
  await tasks.create(run.goal, { taskId: run.id, questionId: run.clarificationId });
  assert.equal(await db.demoTask.count(), 1);
  assert.equal(await db.ownerNotification.count(), 1);
  await jobs.tick(); // restart replays collect
  assert.equal((await jobs.get(run.id)).state, 'waiting_owner');
  assert.equal(await db.ownerNotification.count(), 1);
  assert.equal((await db.ownerClarification.findUniqueOrThrow({ where: { id: run.clarificationId } })).state, 'pending');
}));

test('lease is honored, expired lease is reclaimable and stop closes owner question', {
  skip: !process.env.DATABASE_URL
}, () => fixture(async (db, jobs, tasks) => {
  const run = await jobs.create('Проверь lease и отмену');
  await db.workflowRun.update({ where: { id: run.id },
    data: { leaseToken: 'dead-worker', leasedUntil: new Date(Date.now() + 60_000) } });
  assert.equal(await jobs.tick(), null);
  await db.workflowRun.update({ where: { id: run.id },
    data: { leasedUntil: new Date(Date.now() - 60_000) } });
  await jobs.tick();
  assert.equal((await jobs.get(run.id)).step, 'collect');
  await jobs.tick();
  assert.equal((await jobs.get(run.id)).state, 'waiting_owner');

  await jobs.stop(run.id);
  assert.equal((await jobs.get(run.id)).state, 'cancelled');
  assert.equal((await tasks.get(run.id)).state, 'cancelled');
  assert.equal((await db.ownerClarification.findUniqueOrThrow({ where: { id: run.clarificationId } })).state, 'cancelled');
  await assert.rejects(
    () => tasks.answerQuestion(run.clarificationId, 'cheapest'),
    (e: unknown) => e instanceof DemoError && e.code === 'QUESTION_CLOSED'
  );
  assert.equal(await jobs.tick(), null);
}));

test('queued stop never creates messages and invalid goals are rejected', {
  skip: !process.env.DATABASE_URL
}, () => fixture(async (db, jobs) => {
  await assert.rejects(() => jobs.create('x'), (e: unknown) => e instanceof DemoError && e.code === 'INVALID_GOAL');
  const run = await jobs.create('Отмени до отправки');
  await jobs.stop(run.id);
  assert.equal((await jobs.get(run.id)).state, 'cancelled');
  assert.equal(await jobs.tick(), null);
  assert.equal(await db.demoTask.count(), 0);
  assert.equal(await db.ownerNotification.count(), 0);
}));

test('P1 normalized targets and conversations distinguish mock fixtures from consented test recipients', {
  skip: !process.env.DATABASE_URL
}, () => fixture(async (db, _jobs) => {
  const policy = { enabled: true, allowedChatIds: new Set(['42']) };
  const jobs = new DurableOrchestrator(db, policy);
  const mock = await jobs.create('Сравнить вымышленные предложения');
  const initial = await jobs.get(mock.id);
  assert.equal(initial.targets.length, 3);
  assert.equal(initial.conversations.length, 3);
  assert.ok(initial.targets.every(t => t.origin === 'mock_fixture' && t.recipientId === null));
  assert.ok(initial.conversations.every(c => c.state === 'mock_simulation'));
  await jobs.stop(mock.id);

  const external = await jobs.create('Уточни цену для теста', {
    transport: 'telegram_test', targetChatId: '42'
  });
  let state = await jobs.get(external.id);
  assert.equal(state.targets.length, 1);
  assert.equal(state.targets[0].origin, 'explicit_test_allowlist');
  assert.equal(state.targets[0].recipientId, '42');
  assert.equal(state.conversations[0].state, 'planned');
  await jobs.tick();
  await jobs.tick();
  state = await jobs.get(external.id);
  assert.equal(state.state, 'waiting_external');
  assert.equal(state.conversations[0].state, 'waiting_external');
  assert.equal((await jobs.stop(external.id)).conversations[0].state, 'cancelled');
  assert.equal(await db.workflowTarget.count({ where: { workflowId: external.id } }), 1);
  assert.equal(await db.workflowConversation.count({ where: { workflowId: external.id } }), 1);
}));

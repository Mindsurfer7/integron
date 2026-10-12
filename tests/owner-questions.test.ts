import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { DemoError } from '../packages/core/src/demo.ts';
import { DurableOrchestrator } from '../packages/storage/src/orchestrator.ts';
import { PrismaDemoTaskService } from '../packages/storage/src/prisma.ts';
import { answerWorkflowOwnerQuestion, expireWorkflowOwnerQuestions, readOwnerIdentity,
  validateOwnerText } from '../packages/storage/src/owner-questions.ts';
import { handleTestText } from '../packages/storage/src/text-gateway.ts';
import { buildFastifyApp } from '../apps/api/src/fastify-app.ts';
import { flushWorkflowOwnerOutbox, handleOwnerUpdate, TelegramBotClient,
  type TelegramUpdate } from '../packages/notifications/src/telegram.ts';

const policy = { enabled: true, allowedChatIds: new Set(['42', '44']) };
const owner = { userId: '42', chatId: '43' };
function telegram() {
  let seq = 900;
  let networkFails = false;
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const transport = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(String(init?.body));
    calls.push({ method, body });
    if (method === 'sendMessage' && networkFails) throw new Error('network interrupted');
    return new Response(JSON.stringify({ ok: true,
      result: method === 'sendMessage' ? { message_id: ++seq } : true
    }), { status: 200 });
  }) as typeof fetch;
  return { bot: new TelegramBotClient({ token: 'fake:token',
    ownerUserId: owner.userId, ownerChatId: owner.chatId }, transport),
    calls, networkFails: (value: boolean) => { networkFails = value; } };
}
async function fixture(fn: (db: PrismaClient) => Promise<void>) {
  const db = new PrismaClient();
  await db.$connect();
  try {
    await db.workflowRun.deleteMany({});
    await db.demoTask.deleteMany({});
    await fn(db);
  } finally {
    await db.workflowRun.deleteMany({});
    await db.demoTask.deleteMany({});
    await db.$disconnect();
  }
}

async function conflict(db: PrismaClient, jobs: DurableOrchestrator,
  chatId: string, price: string, providerId: string) {
  const run = await jobs.create('Уточни цену и доступность', {
    transport: 'telegram_test', targetChatId: chatId
  });
  await jobs.tick(); await jobs.tick();
  await db.textDelivery.update({ where: { workflowId: run.id },
    data: { state: 'sent', providerId } });
  assert.equal(await handleTestText(db, policy, {
    updateId: Number(providerId), providerMessageId: 'reply-' + providerId,
    chatId, senderId: chatId, chatType: 'private',
    replyToProviderId: providerId, body: price
  }), true);
  assert.equal(await jobs.tick(), run.id);
  const waiting = await jobs.get(run.id);
  assert.equal(waiting.state, 'waiting_owner');
  assert.equal(waiting.step, 'await_conflict_review');
  assert.ok(waiting.facts.some(f => f.status === 'conflicting'));
  assert.equal(waiting.ownerQuestions.length, 1);
  assert.equal(waiting.conversations[0].state, 'needs_review');
  return { run, q: waiting.ownerQuestions[0] };
}

test('P1 owner text validators fail closed and identity must be paired', () => {
  assert.deepEqual(readOwnerIdentity({}), undefined);
  assert.deepEqual(readOwnerIdentity({
    OWNER_TELEGRAM_USER_ID: '42', OWNER_TELEGRAM_CHAT_ID: '43'
  }), owner);
  assert.throws(() => readOwnerIdentity({ OWNER_TELEGRAM_USER_ID: '42' }));
  assert.throws(() => readOwnerIdentity({ OWNER_TELEGRAM_CHAT_ID: '43' }));
  assert.throws(() => validateOwnerText('x'), (e: unknown) =>
    e instanceof DemoError && e.code === 'INVALID_OWNER_TEXT');
  assert.throws(() => validateOwnerText('x'.repeat(501)));
  assert.throws(() => validateOwnerText('hello\u0000'));
  assert.equal(validateOwnerText('  Уточни вручную  '), 'Уточни вручную');
});

test('two simultaneous conflicts: exact owner question ID/reply-to, restart, no outbound replay', {
  skip: !process.env.DATABASE_URL
}, () => fixture(async db => {
  const jobs = new DurableOrchestrator(db, policy, undefined, undefined, undefined, owner);
  const first = await conflict(db, jobs, '42', 'Цена 350 THB и 400 THB', '711');
  const second = await conflict(db, jobs, '44', 'Нет в наличии, но есть в наличии', '712');
  assert.notEqual(first.q.id, second.q.id);
  assert.equal(await db.workflowOwnerQuestion.count(), 2);
  assert.equal(await db.workflowOwnerNotification.count(), 2);
  const fake = telegram();
  assert.equal(await flushWorkflowOwnerOutbox(db, fake.bot), 2);
  assert.equal(await flushWorkflowOwnerOutbox(db, fake.bot), 0);
  assert.equal(fake.calls.filter(c => c.method === 'sendMessage').length, 2);
  assert.ok(fake.calls.every(c => !String(c.body.text).includes('350 THB')));
  const n1 = await db.workflowOwnerNotification.findUniqueOrThrow({
    where: { questionId: first.q.id }
  });
  const n2 = await db.workflowOwnerNotification.findUniqueOrThrow({
    where: { questionId: second.q.id }
  });

  const command = async (updateId: number, text: string, from = 42, chat = 43,
    replyToMessageId?: number) => handleOwnerUpdate(db, fake.bot, {
      update_id: updateId, message: { message_id: updateId, text,
        from: { id: from }, chat: { id: chat },
        ...(replyToMessageId === undefined ? {} :
          { reply_to_message: { message_id: replyToMessageId } }) }
    });
  await command(1, '/reply ' + first.q.id + ' Не подтверждай цену', 999);
  await command(2, '/reply ' + first.q.id + ' Не подтверждай цену', 42, 999);
  await command(3, 'Не подтверждай цену');
  await command(4, 'Не подтверждай цену', 42, 43, 999999);
  assert.equal((await db.workflowOwnerQuestion.findUniqueOrThrow({
    where: { id: first.q.id } })).state, 'pending');

  await command(5, 'Уточни у поставщика', 42, 43, Number(n2.messageId));
  assert.equal((await db.workflowOwnerQuestion.findUniqueOrThrow({
    where: { id: second.q.id } })).answer, 'Уточни у поставщика');
  assert.equal((await db.workflowOwnerQuestion.findUniqueOrThrow({
    where: { id: first.q.id } })).state, 'pending');

  await command(6, '/reply ' + first.q.id + ' Проверь вручную');
  await command(7, '/reply ' + first.q.id + ' Проверь вручную');
  assert.equal((await db.workflowEvent.count({
    where: { workflowId: first.run.id, kind: 'owner_text_answered' }
  })), 1);
  await assert.rejects(
    () => answerWorkflowOwnerQuestion(db, first.q.id, 'Другой ответ',
      'telegram', owner),
    (e: unknown) => e instanceof DemoError && e.code === 'QUESTION_CLOSED'
  );
  const recovery = new PrismaClient();
  try {
    const restarted = new DurableOrchestrator(recovery, policy, undefined,
      undefined, undefined, owner);
    const processed = [await restarted.tick(), await restarted.tick()];
    assert.deepEqual(new Set(processed), new Set([first.run.id, second.run.id]));
    assert.equal((await restarted.get(first.run.id)).state, 'completed');
    const other = await restarted.get(second.run.id);
    assert.equal(other.state, 'completed');
    assert.equal(other.ownerQuestions[0].answer, 'Уточни у поставщика');
    assert.equal(other.conversations[0].state, 'reviewed');
  } finally { await recovery.$disconnect(); }
  assert.equal(await db.textDelivery.count(), 2);
  assert.equal(await db.textMessage.count({ where: { direction: 'in' } }), 2);
  assert.equal(await db.workflowFact.count({ where: { workflowId: first.run.id } }), 2);
}));

test('pause holds queued owner notice; stop revokes question; expired/unknown cannot be resent', {
  skip: !process.env.DATABASE_URL
}, () => fixture(async db => {
  const jobs = new DurableOrchestrator(db, policy, undefined, undefined, undefined, owner);
  const stopped = await conflict(db, jobs, '42', 'Цена 100 THB, 200 THB', '713');
  const fake = telegram();
  await jobs.pause(stopped.run.id);
  assert.equal(await flushWorkflowOwnerOutbox(db, fake.bot), 0);
  assert.equal((await db.workflowOwnerNotification.findUniqueOrThrow({
    where: { questionId: stopped.q.id } })).state, 'queued');
  await jobs.resume(stopped.run.id);
  assert.equal(await flushWorkflowOwnerOutbox(db, fake.bot), 1);
  await jobs.stop(stopped.run.id);
  assert.equal((await db.workflowOwnerQuestion.findUniqueOrThrow({
    where: { id: stopped.q.id } })).state, 'cancelled');
  await assert.rejects(() => answerWorkflowOwnerQuestion(db, stopped.q.id,
    'Ответ после остановки', 'telegram', owner));

  const uncertain = await conflict(db, jobs, '42', 'Цена 300 THB, 400 THB', '714');
  fake.networkFails(true);
  assert.equal(await flushWorkflowOwnerOutbox(db, fake.bot), 0);
  assert.equal((await db.workflowOwnerNotification.findUniqueOrThrow({
    where: { questionId: uncertain.q.id } })).state, 'unknown');
  fake.networkFails(false);
  assert.equal(await flushWorkflowOwnerOutbox(db, fake.bot), 0);

  const late = await conflict(db, jobs, '42', 'Цена 500 THB, 600 THB', '715');
  await db.workflowOwnerQuestion.update({
    where: { id: late.q.id }, data: { expiresAt: new Date(Date.now() - 1000) }
  });
  assert.equal(await expireWorkflowOwnerQuestions(db), 1);
  assert.equal((await db.workflowOwnerNotification.findUniqueOrThrow({
    where: { questionId: late.q.id } })).state, 'cancelled');
  await assert.rejects(() => answerWorkflowOwnerQuestion(db, late.q.id,
    'Ответ поздно', 'telegram', owner));
  assert.equal(await jobs.tick(), late.run.id);
  assert.equal((await jobs.get(late.run.id)).state, 'failed');
}));

test('loopback web inbox enforces parent workflow ID and browser origin, no extra sends', {
  skip: !process.env.DATABASE_URL
}, () => fixture(async db => {
  const jobs = new DurableOrchestrator(db, policy);
  const { run, q } = await conflict(db, jobs, '42', 'Цена 100 THB или 200 THB', '716');
  assert.equal(await db.workflowOwnerNotification.count(), 0); // no configured bot owner
  const wrong = await jobs.create('Другое независимое поручение');
  const app = buildFastifyApp(new PrismaDemoTaskService(db), 'postgres', jobs);
  try {
    const path = '/api/workflows/' + run.id + '/owner-questions/' + q.id + '/answer';
    const host = '127.0.0.1:4317';
    const invalidHost = await app.inject({
      method: 'POST', url: path, headers: { host: 'evil.example' },
      payload: { text: 'Уточни вручную' }
    });
    assert.equal(invalidHost.statusCode, 403);
    const invalidOrigin = await app.inject({
      method: 'POST', url: path, headers: { host, origin: 'http://evil.example' },
      payload: { text: 'Уточни вручную' }
    });
    assert.equal(invalidOrigin.statusCode, 403);
    const wrongWorkflow = await app.inject({
      method: 'POST', url: '/api/workflows/' + wrong.id +
        '/owner-questions/' + q.id + '/answer',
      headers: { host }, payload: { text: 'Уточни вручную' }
    });
    assert.equal(wrongWorkflow.statusCode, 404);
    const invalid = await app.inject({
      method: 'POST', url: path, headers: { host }, payload: { text: 'x' }
    });
    assert.equal(invalid.statusCode, 400);
    const accepted = await app.inject({
      method: 'POST', url: path, headers: { host }, payload: { text: 'Уточни вручную' }
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().question.answer, 'Уточни вручную');
    const repeat = await app.inject({
      method: 'POST', url: path, headers: { host }, payload: { text: 'Уточни вручную' }
    });
    assert.equal(repeat.statusCode, 200);
    assert.equal((await db.workflowEvent.count({
      where: { workflowId: run.id, kind: 'owner_text_answered' }
    })), 1);
    assert.equal(await jobs.tick(), run.id);
    assert.equal((await jobs.get(run.id)).state, 'completed');
    assert.equal(await db.textDelivery.count({ where: { workflowId: run.id } }), 1);
  } finally { await app.close(); }
}));

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { DurableOrchestrator } from '../packages/storage/src/orchestrator.ts';
import { AgentTelegramTestAdapter } from '../packages/transports/src/telegram-test.ts';
import { authorizeTestText, readTestTextPolicy } from '../packages/transports/src/contracts.ts';
import { flushTestTextOutbox, pollTestText } from '../packages/storage/src/text-gateway.ts';

const policy = { enabled: true, allowedChatIds: new Set(['42', '43']) };
function fakeTelegram() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let updates: object[] = [];
  let networkFailure = false;
  let refusal = false;
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop() ?? '';
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ method, body });
    if (method === 'sendMessage' && networkFailure) throw new Error('simulated disconnect after send');
    if (method === 'sendMessage' && refusal) return new Response('denied', { status: 403 });
    const result = method === 'sendMessage' ? { message_id: 711 } :
      method === 'getMe' ? { id: 987654, is_bot: true } :
      updates.filter((u: any) => u.update_id >= Number(body.offset));
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as typeof fetch;
  return {
    adapter: new AgentTelegramTestAdapter('12345:test-token12345', http),
    calls,
    updates: (list: object[]) => { updates = list; },
    failsNetwork: (value: boolean) => { networkFailure = value; },
    refuses: (value: boolean) => { refusal = value; }
  };
}
async function dbFixture(fn: (db: PrismaClient, jobs: DurableOrchestrator) => Promise<void>) {
  const db = new PrismaClient();
  await db.$connect();
  try {
    await db.agentTelegramCursor.deleteMany({});
    await db.workflowRun.deleteMany({});
    await db.demoTask.deleteMany({});
    await fn(db, new DurableOrchestrator(db, policy));
  } finally {
    await db.agentTelegramCursor.deleteMany({});
    await db.workflowRun.deleteMany({});
    await db.demoTask.deleteMany({});
    await db.$disconnect();
  }
}
test('test-only transport policy refuses unlisted and disabled recipients', () => {
  assert.deepEqual([...readTestTextPolicy({ TEST_TELEGRAM_ENABLED: 'true',
    AGENT_TELEGRAM_ALLOWED_CHAT_IDS: '42,43' }).allowedChatIds], ['42','43']);
  assert.throws(() => authorizeTestText({ enabled: false, allowedChatIds: new Set(['42']) }, '42'));
  assert.throws(() => authorizeTestText(policy, '999'));
  assert.throws(() => readTestTextPolicy({ TEST_TELEGRAM_ENABLED: 'true' }));
  assert.throws(() => readTestTextPolicy({ TEST_TELEGRAM_ENABLED: 'true',
    AGENT_TELEGRAM_ALLOWED_CHAT_IDS: '-100123,42' }));
  assert.throws(() => readTestTextPolicy({ TEST_TELEGRAM_ENABLED: 'true',
    AGENT_TELEGRAM_ALLOWED_CHAT_IDS: '42,42' }));
});

test('real-adapter shape, durable outbound, inbound reply and workflow restart with fake HTTP', {
  skip: !process.env.DATABASE_URL
}, () => dbFixture(async (db, jobs) => {
  await assert.rejects(() => jobs.create('Test forbid', { transport: 'telegram_test', targetChatId: '99' }));
  const run = await jobs.create('Проверь наличие у тестового собеседника',
    { transport: 'telegram_test', targetChatId: '42' });
  await jobs.tick();
  assert.equal((await jobs.get(run.id)).step, 'send_text');
  await jobs.tick();
  assert.equal((await jobs.get(run.id)).state, 'waiting_external');
  assert.equal(await db.textDelivery.count(), 1);

  const fake = fakeTelegram();
  assert.equal(await fake.adapter.health(), true);
  assert.equal(await flushTestTextOutbox(db, fake.adapter, policy), 1);
  assert.equal(await flushTestTextOutbox(db, fake.adapter, policy), 0);
  assert.equal(fake.calls.filter(c => c.method === 'sendMessage').length, 1);
  assert.equal(fake.calls.find(c => c.method === 'sendMessage')?.body.chat_id, '42');
  assert.equal((await db.textDelivery.findUniqueOrThrow({ where: { workflowId: run.id } })).providerId, '711');

  // Three nonmatching updates: different chat, spoofed sender and uncorrelated text.
  fake.updates([
    { update_id: 100, message: { message_id: 300, text: 'Wrong chat',
      from: { id: 43 }, chat: { id: 43, type: 'private' }, reply_to_message: { message_id: 711 } } },
    { update_id: 101, message: { message_id: 301, text: 'Wrong sender',
      from: { id: 999 }, chat: { id: 42, type: 'private' }, reply_to_message: { message_id: 711 } } },
    { update_id: 102, message: { message_id: 302, text: 'Unrelated message',
      from: { id: 42 }, chat: { id: 42, type: 'private' } } }
  ]);
  assert.equal(await pollTestText(db, fake.adapter, policy), 3);
  assert.equal((await jobs.get(run.id)).state, 'waiting_external');
  assert.equal(await db.textMessage.count(), 1); // outgoing only

  fake.updates([{ update_id: 103, message: { message_id: 303, text: 'Да, есть в наличии. 350 THB',
    from: { id: 42 }, chat: { id: 42, type: 'private' }, reply_to_message: { message_id: 711 } } }]);
  assert.equal(await pollTestText(db, fake.adapter, policy), 1);
  assert.equal((await jobs.get(run.id)).step, 'process_external');
  assert.equal((await db.textMessage.count({ where: { direction: 'in' } })), 1);

  const other = new PrismaClient();
  try {
    const resumed = new DurableOrchestrator(other, policy);
    assert.equal(await resumed.tick(), run.id);
    const done = await resumed.get(run.id);
    assert.equal(done.state, 'completed');
    assert.equal(done.messages.length, 2);
    assert.equal(done.messages.find(m => m.direction === 'in')?.body, 'Да, есть в наличии. 350 THB');
    assert.equal(done.events.at(-1)?.kind, 'text_reply_processed');
  } finally { await other.$disconnect(); }
  assert.equal(await pollTestText(db, fake.adapter, policy), 0);
  assert.equal(await db.textMessage.count(), 2);
}));

test('stop before sending, lost network response, duplicate reply and late answer fail closed', {
  skip: !process.env.DATABASE_URL
}, () => dbFixture(async (db, jobs) => {
  const before = await jobs.create('Отмена тестового исходящего', { transport: 'telegram_test', targetChatId: '42' });
  await jobs.tick();
  await jobs.tick();
  await jobs.stop(before.id);
  const fake = fakeTelegram();
  assert.equal(await flushTestTextOutbox(db, fake.adapter, policy), 0);
  assert.equal(fake.calls.filter(c => c.method === 'sendMessage').length, 0);
  assert.equal((await db.textDelivery.findUniqueOrThrow({ where: { workflowId: before.id } })).state, 'cancelled');

  const uncertain = await jobs.create('Тест неизвестного результата доставки',
    { transport: 'telegram_test', targetChatId: '42' });
  await jobs.tick();
  await jobs.tick();
  fake.failsNetwork(true);
  assert.equal(await flushTestTextOutbox(db, fake.adapter, policy), 0);
  fake.failsNetwork(false);
  assert.equal((await db.textDelivery.findUniqueOrThrow({ where: { workflowId: uncertain.id } })).state, 'unknown');
  assert.equal(await flushTestTextOutbox(db, fake.adapter, policy), 0);
  await db.workflowRun.update({ where: { id: uncertain.id }, data: { availableAt: new Date(0) } });
  await jobs.tick();
  assert.equal((await jobs.get(uncertain.id)).state, 'failed');
  assert.equal((await jobs.get(uncertain.id)).events.at(-1)?.kind, 'send_unknown_review_required');

  const late = await jobs.create('Тест опоздавшего ответа', { transport: 'telegram_test', targetChatId: '43' });
  await jobs.tick();
  await jobs.tick();
  assert.equal(await flushTestTextOutbox(db, fake.adapter, policy), 1);
  await db.textDelivery.update({ where: { workflowId: late.id },
    data: { expiresAt: new Date(Date.now() - 1000) } });
  fake.updates([{ update_id: 200, message: { message_id: 400, text: 'Late',
    from: { id: 43 }, chat: { id: 43, type: 'private' }, reply_to_message: { message_id: 711 } } }]);
  assert.equal(await pollTestText(db, fake.adapter, policy), 1);
  assert.equal((await jobs.get(late.id)).state, 'waiting_external');
  assert.equal(await db.textMessage.count({ where: { workflowId: late.id, direction: 'in' } }), 0);
  await db.workflowRun.update({ where: { id: late.id }, data: { availableAt: new Date(0) } });
  await jobs.tick();
  assert.equal((await jobs.get(late.id)).state, 'failed');
}));

test('provider explicit refusal is not resent', { skip: !process.env.DATABASE_URL }, () =>
  dbFixture(async (db, jobs) => {
    const run = await jobs.create('Проверь отказ поставщика', { transport: 'telegram_test', targetChatId: '42' });
    await jobs.tick(); await jobs.tick();
    const fake = fakeTelegram();
    fake.refuses(true);
    await flushTestTextOutbox(db, fake.adapter, policy);
    assert.equal((await db.textDelivery.findUniqueOrThrow({ where: { workflowId: run.id } })).state, 'failed');
    await flushTestTextOutbox(db, fake.adapter, policy);
    assert.equal(fake.calls.filter(x => x.method === 'sendMessage').length, 1);
  })
);

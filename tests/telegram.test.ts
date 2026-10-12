import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { DemoError } from '../packages/core/src/demo.ts';
import { PrismaDemoTaskService } from '../packages/storage/src/prisma.ts';
import {
  TelegramBotClient, flushOwnerOutbox, handleOwnerUpdate, pollOwnerUpdates,
  type TelegramUpdate
} from '../packages/notifications/src/telegram.ts';

function mockTelegram() {
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  let failNetwork = false;
  let updates: TelegramUpdate[] = [];
  const transport = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop() ?? '';
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ method, body });
    if (method === 'sendMessage' && failNetwork) throw new Error('Simulated lost network response');
    let result: unknown = true;
    if (method === 'sendMessage') result = { message_id: 150 + sent.length };
    if (method === 'getUpdates') result = updates.filter(u => u.update_id >= Number(body.offset));
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return {
    sent,
    bot: new TelegramBotClient({ token: 'test-token', ownerUserId: '42', ownerChatId: '43' }, transport),
    setUpdates: (value: TelegramUpdate[]) => { updates = value; },
    setNetworkFailure: (value: boolean) => { failNetwork = value; }
  };
}
const dbAvailable = Boolean(process.env.DATABASE_URL);
test('P1 durable outbox, owner-only correlated reply, duplicate delivery and restart cursor', {
  skip: !dbAvailable
}, async () => {
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    await prisma.telegramPollingCursor.deleteMany({});
    await prisma.demoTask.deleteMany({});
    const taskService = new PrismaDemoTaskService(prisma);
    const a = await taskService.create('Сравни стоимость трёх вариантов');
    const b = await taskService.create('Выбери быстрый вариант');
    const mock = mockTelegram();

    const q = await prisma.ownerClarification.findUniqueOrThrow({ where: { id: a.question.id }, include: { notification: true } });
    assert.equal(q.state, 'pending');
    assert.equal(q.notification?.state, 'queued');

    assert.equal(await flushOwnerOutbox(prisma, mock.bot), 2);
    assert.equal(await flushOwnerOutbox(prisma, mock.bot), 0);
    const sent = mock.sent.filter(x => x.method === 'sendMessage');
    assert.equal(sent.length, 2);
    const buttons = (sent[0].body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    assert.match(buttons[0][0].callback_data, new RegExp(a.question.id));
    const messageRow = await prisma.ownerNotification.findUniqueOrThrow({ where: { clarificationId: a.question.id } });
    assert.equal(messageRow.state, 'sent');
    assert.ok(messageRow.messageId);

    // Any other Telegram account (even if it sees a forwarded callback) is ignored.
    await handleOwnerUpdate(prisma, mock.bot, {
      update_id: 1, callback_query: { id: 'foreign', from: { id: 999 }, data: 'q:' + a.question.id + ':cheapest',
        message: { chat: { id: 43 }, message_id: Number(messageRow.messageId) } }
    });
    assert.equal((await taskService.get(a.id)).state, 'waiting_owner');

    const authorized: TelegramUpdate = {
      update_id: 100, callback_query: { id: 'real', from: { id: 42 }, data: 'q:' + a.question.id + ':cheapest',
        message: { chat: { id: 43 }, message_id: Number(messageRow.messageId) } }
    };
    mock.setUpdates([authorized]);
    assert.equal(await pollOwnerUpdates(prisma, mock.bot), 1);
    const secondClient = new PrismaClient();
    try {
      const restartedService = new PrismaDemoTaskService(secondClient);
      assert.equal((await restartedService.get(a.id)).state, 'completed');
    } finally { await secondClient.$disconnect(); }
    assert.equal((await taskService.get(b.id)).state, 'waiting_owner');
    assert.equal((await prisma.ownerClarification.findUniqueOrThrow({ where: { id: a.question.id } })).state, 'answered');
    assert.equal(await pollOwnerUpdates(prisma, mock.bot), 0);
    assert.equal((await prisma.telegramPollingCursor.findUniqueOrThrow({ where: { id: 1 } })).lastUpdateId, 100n);

    // A stale callback is acknowledged but cannot change the first answer.
    await handleOwnerUpdate(prisma, mock.bot, authorized);
    assert.equal((await taskService.get(a.id)).recommendation?.organizationId, 'mock-alpha');
    assert.equal((await taskService.get(a.id)).events.filter(e => e.type === 'owner.answered.mock').length, 1);
    assert.equal(mock.sent.filter(x => x.method === 'answerCallbackQuery').length, 2);

    // A reply-to bot message is another correctly correlated input.
    const secondNotice = await prisma.ownerNotification.findUniqueOrThrow({ where: { clarificationId: b.question.id } });
    await handleOwnerUpdate(prisma, mock.bot, {
      update_id: 101, message: { message_id: 500, from: { id: 42 }, chat: { id: 43 },
        text: 'fastest', reply_to_message: { message_id: Number(secondNotice.messageId) } }
    });
    assert.equal((await taskService.get(b.id)).recommendation?.organizationId, 'mock-beta');

    await prisma.telegramPollingCursor.deleteMany({});
    await prisma.demoTask.deleteMany({});
  } finally { await prisma.$disconnect(); }
});

test('ambiguous send becomes UNKNOWN and is not retried; expired question cannot authorize', {
  skip: !dbAvailable
}, async () => {
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    await prisma.telegramPollingCursor.deleteMany({});
    await prisma.demoTask.deleteMany({});
    const service = new PrismaDemoTaskService(prisma);
    const a = await service.create('Тест неопределённой доставки');
    const mock = mockTelegram();
    mock.setNetworkFailure(true);
    assert.equal(await flushOwnerOutbox(prisma, mock.bot), 0);
    assert.equal((await prisma.ownerNotification.findUniqueOrThrow({
      where: { clarificationId: a.question.id }
    })).state, 'unknown');
    mock.setNetworkFailure(false);
    assert.equal(await flushOwnerOutbox(prisma, mock.bot), 0);

    const b = await service.create('Тест просроченного вопроса');
    await prisma.ownerClarification.update({
      where: { id: b.question.id }, data: { expiresAt: new Date(Date.now() - 1000) }
    });
    await assert.rejects(
      () => service.answerQuestion(b.question.id, 'cheapest'),
      (error: unknown) => error instanceof DemoError && error.code === 'QUESTION_CLOSED'
    );
    assert.equal((await service.get(b.id)).state, 'waiting_owner');
    assert.equal(await service.expirePending(), 1);
    assert.equal((await service.get(b.id)).state, 'cancelled');
    assert.equal((await prisma.ownerClarification.findUniqueOrThrow({ where: { id: b.question.id } })).state, 'expired');
    assert.equal((await prisma.ownerNotification.findUniqueOrThrow({ where: { clarificationId: b.question.id } })).state, 'cancelled');

    await prisma.telegramPollingCursor.deleteMany({});
    await prisma.demoTask.deleteMany({});
  } finally { await prisma.$disconnect(); }
});

test('stuck sending is recovered as UNKNOWN without repeating the request', { skip: !dbAvailable }, async () => {
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    await prisma.telegramPollingCursor.deleteMany({});
    await prisma.demoTask.deleteMany({});
    const service = new PrismaDemoTaskService(prisma);
    const task = await service.create('Остановленная отправка');
    await prisma.ownerNotification.update({
      where: { clarificationId: task.question.id },
      data: { state: 'sending', leasedUntil: new Date(Date.now() - 60_000) }
    });
    const mock = mockTelegram();
    assert.equal(await flushOwnerOutbox(prisma, mock.bot), 0);
    assert.equal(mock.sent.length, 0);
    assert.equal((await prisma.ownerNotification.findUniqueOrThrow({ where: { clarificationId: task.question.id } })).state, 'unknown');
    await prisma.demoTask.deleteMany({});
    await prisma.telegramPollingCursor.deleteMany({});
  } finally { await prisma.$disconnect(); }
});

test('Telegram command authorization, stop, and uncorrelated text are fail-closed', { skip: !dbAvailable }, async () => {
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    await prisma.telegramPollingCursor.deleteMany({});
    await prisma.demoTask.deleteMany({});
    const tasks = new PrismaDemoTaskService(prisma);
    const task = await tasks.create('Команда остановки');
    const mock = mockTelegram();
    await handleOwnerUpdate(prisma, mock.bot, {
      update_id: 201, message: { message_id: 21, from: { id: 42 }, chat: { id: 43 }, text: 'cheapest' }
    });
    assert.equal((await tasks.get(task.id)).state, 'waiting_owner');
    await handleOwnerUpdate(prisma, mock.bot, {
      update_id: 202, message: { message_id: 22, from: { id: 42 }, chat: { id: 12345 },
        text: '/stop ' + task.id }
    });
    assert.equal((await tasks.get(task.id)).state, 'waiting_owner');
    await handleOwnerUpdate(prisma, mock.bot, {
      update_id: 203, message: { message_id: 23, from: { id: 42 }, chat: { id: 43 },
        text: '/stop ' + task.id }
    });
    assert.equal((await tasks.get(task.id)).state, 'cancelled');
    assert.equal((await prisma.ownerNotification.findUniqueOrThrow({
      where: { clarificationId: task.question.id }
    })).state, 'cancelled');
    await assert.rejects(() => tasks.answerQuestion(task.question.id, 'cheapest'),
      (error: unknown) => error instanceof DemoError && error.code === 'QUESTION_CLOSED');
    await prisma.demoTask.deleteMany({});
    await prisma.telegramPollingCursor.deleteMany({});
  } finally { await prisma.$disconnect(); }
});

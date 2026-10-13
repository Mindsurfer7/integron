import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { DemoError } from '../packages/core/src/demo.ts';
import { DurableOrchestrator } from '../packages/storage/src/orchestrator.ts';
import { PrismaDemoTaskService } from '../packages/storage/src/prisma.ts';
import {
  approvalIntentDigest, consumeMockApproval, decideWorkflowApproval,
  expireWorkflowApprovals, normalizeApprovalIntent, requestMockApproval
} from '../packages/storage/src/approvals.ts';
import { flushWorkflowApprovalOutbox, handleOwnerUpdate,
  TelegramBotClient } from '../packages/notifications/src/telegram.ts';
import { buildFastifyApp } from '../apps/api/src/fastify-app.ts';

const owner = { userId: '42', chatId: '43' };
const booking = { actionType: 'booking' as const, recipientRef: 'mock-alpha',
  summary: 'Демонстрационная запись в вымышленную организацию' };
const payment = { actionType: 'payment' as const, recipientRef: 'mock-alpha',
  summary: 'Исключительно фиктивная тестовая оплата', amountMinor: 12345, currency: 'THB' };
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
function fakeBot() {
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  let next = 800;
  let fail = false;
  const transport = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ method, body });
    if (method === 'sendMessage' && fail) throw new Error('Lost provider response');
    return new Response(JSON.stringify({ ok: true,
      result: method === 'sendMessage' ? { message_id: ++next } : true
    }), { status: 200 });
  }) as typeof fetch;
  return {
    bot: new TelegramBotClient({ token: 'fake-bot', ownerUserId: owner.userId,
      ownerChatId: owner.chatId }, transport),
    sent, setFail(value: boolean) { fail = value; }
  };
}

test('approval intent digest is exact and rejects forged amount/currency', () => {
  assert.equal(approvalIntentDigest(booking), approvalIntentDigest({ ...booking }));
  assert.notEqual(approvalIntentDigest(payment), approvalIntentDigest({ ...payment, amountMinor: 12346 }));
  assert.throws(() => normalizeApprovalIntent({ ...payment, amountMinor: 0 }));
  assert.throws(() => normalizeApprovalIntent({ ...payment, amountMinor: -1 }));
  assert.throws(() => normalizeApprovalIntent({ ...payment, currency: 'thb' }));
  assert.throws(() => normalizeApprovalIntent({ ...booking, amountMinor: 100 }));
  assert.throws(() => normalizeApprovalIntent({ ...booking, summary: 'hi' }));
});

test('immutable idempotent request; concurrent decisions; one-time mock consumption never performs I/O', {
  skip: !process.env.DATABASE_URL
}, () => fixture(async db => {
  const jobs = new DurableOrchestrator(db, undefined, undefined, undefined, undefined, owner);
  const wf = await jobs.create('Создай три демонстрационных предложения');
  const a = await jobs.requestDemoApproval(wf.id);
  const duplicate = await jobs.requestDemoApproval(wf.id);
  assert.equal(a.id, duplicate.id);
  assert.equal(await db.workflowApproval.count(), 1);
  assert.equal(await db.workflowApprovalNotification.count(), 1);
  await assert.rejects(() => requestMockApproval(db, wf.id, 'demo-booking:mock-alpha',
    payment, owner), (e: unknown) => e instanceof DemoError && e.code === 'APPROVAL_INTENT_CONFLICT');
  await assert.rejects(() => requestMockApproval(db, wf.id, 'custom:bad-target',
    { ...booking, recipientRef: 'external-recipient' }, owner));
  await assert.rejects(() => requestMockApproval(db, wf.id, 'custom:wrong-owner',
    booking, undefined));
  const responses = await Promise.allSettled([
    decideWorkflowApproval(db, a.id, 'approve', owner),
    decideWorkflowApproval(db, a.id, 'approve', owner)
  ]);
  assert.ok(responses.every(x => x.status === 'fulfilled'));
  assert.equal((await db.workflowApproval.findUniqueOrThrow({ where: { id: a.id } })).state, 'approved');
  assert.equal(await db.workflowEvent.count({
    where: { workflowId: wf.id, kind: 'approval_granted' }
  }), 1);
  await assert.rejects(() => decideWorkflowApproval(db, a.id, 'deny', owner));
  await assert.rejects(() => consumeMockApproval(db, wf.id, a.id,
    { ...booking, summary: booking.summary + ' — другое действие' }));
  const [first, second] = await Promise.allSettled([
    jobs.consumeDemoApproval(wf.id, a.id),
    jobs.consumeDemoApproval(wf.id, a.id)
  ]);
  const outcomes = [first, second];
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(x => x.status === 'rejected').length, 1);
  const success = outcomes.find(x => x.status === 'fulfilled') as PromiseFulfilledResult<any>;
  assert.equal(success.value.simulated, true);
  assert.equal(success.value.externalActions, 0);
  assert.equal(success.value.approval.state, 'consumed');
  assert.equal(await db.workflowEvent.count({
    where: { workflowId: wf.id, kind: 'approval_mock_consumed' }
  }), 1);
  assert.equal(await db.textDelivery.count(), 0);
  assert.equal(await db.textMessage.count(), 0);
  assert.equal((await jobs.get(wf.id)).approvals[0].state, 'consumed');
}));

test('owner Telegram callback belongs to exact sent notification; wrong sender, chat or message cannot vote', {
  skip: !process.env.DATABASE_URL
}, () => fixture(async db => {
  const jobs = new DurableOrchestrator(db, undefined, undefined, undefined, undefined, owner);
  const firstRun = await jobs.create('Проверь согласования разных задач');
  const secondRun = await jobs.create('Другая демонстрационная задача');
  const first = await requestMockApproval(db, firstRun.id, 'book:alpha', booking, owner);
  const second = await requestMockApproval(db, secondRun.id, 'pay:alpha', payment, owner);
  const tg = fakeBot();
  assert.equal(await flushWorkflowApprovalOutbox(db, tg.bot), 2);
  assert.equal(await flushWorkflowApprovalOutbox(db, tg.bot), 0);
  assert.equal(tg.sent.filter(x => x.method === 'sendMessage').length, 2);
  assert.ok(tg.sent.some(x => String(x.body.text).includes('12345 минорных единиц THB')));
  assert.ok(tg.sent.every(x => String(x.body.text).includes('симуляци') ||
    String(x.body.text).includes('симуляц')));
  const n1 = await db.workflowApprovalNotification.findUniqueOrThrow({
    where: { approvalId: first.id }
  });
  const n2 = await db.workflowApprovalNotification.findUniqueOrThrow({
    where: { approvalId: second.id }
  });
  const callback = async (updateId: number, approvalId: string, msgId: number,
    from = 42, chat = 43, decision = 'yes') =>
    handleOwnerUpdate(db, tg.bot, { update_id: updateId,
      callback_query: { id: String(updateId), from: { id: from },
        message: { chat: { id: chat }, message_id: msgId },
        data: 'ap:' + approvalId + ':' + decision }
    });
  await callback(1, first.id, Number(n1.messageId), 999);
  await callback(2, first.id, Number(n1.messageId), 42, 999);
  await callback(3, first.id, Number(n2.messageId));
  assert.equal((await db.workflowApproval.findUniqueOrThrow({
    where: { id: first.id } })).state, 'pending');

  await callback(4, second.id, Number(n2.messageId), 42, 43, 'no');
  assert.equal((await db.workflowApproval.findUniqueOrThrow({
    where: { id: second.id } })).state, 'denied');
  await assert.rejects(() => consumeMockApproval(db, secondRun.id, second.id, payment));
  assert.equal((await db.workflowApproval.findUniqueOrThrow({
    where: { id: first.id } })).state, 'pending');
  await callback(5, first.id, Number(n1.messageId));
  await callback(6, first.id, Number(n1.messageId));
  assert.equal((await db.workflowApproval.findUniqueOrThrow({
    where: { id: first.id } })).state, 'approved');
  assert.equal(await db.workflowEvent.count({
    where: { workflowId: firstRun.id, kind: 'approval_granted' }
  }), 1);
  // A textual explicit command is also tied to the authenticated owner IDs.
  const third = await requestMockApproval(db, firstRun.id, 'pay:second', payment, owner);
  await handleOwnerUpdate(db, tg.bot, { update_id: 7, message: {
    message_id: 7, from: { id: 999 }, chat: { id: 43 }, text: '/approve ' + third.id
  } });
  assert.equal((await db.workflowApproval.findUniqueOrThrow({ where: { id: third.id } })).state, 'pending');
  await handleOwnerUpdate(db, tg.bot, { update_id: 8, message: {
    message_id: 8, from: { id: 42 }, chat: { id: 43 }, text: '/deny ' + third.id
  } });
  assert.equal((await db.workflowApproval.findUniqueOrThrow({ where: { id: third.id } })).state, 'denied');
}));

test('paused queue, stop and expired approvals fail closed; ambiguous send is never retried', {
  skip: !process.env.DATABASE_URL
}, () => fixture(async db => {
  const jobs = new DurableOrchestrator(db, undefined, undefined, undefined, undefined, owner);
  const run = await jobs.create('Симуляция разрешения и остановки');
  const a = await jobs.requestDemoApproval(run.id);
  const tg = fakeBot();
  await jobs.pause(run.id);
  assert.equal(await flushWorkflowApprovalOutbox(db, tg.bot), 0);
  assert.equal((await db.workflowApprovalNotification.findUniqueOrThrow({
    where: { approvalId: a.id }
  })).state, 'queued');
  await jobs.resume(run.id);
  tg.setFail(true);
  assert.equal(await flushWorkflowApprovalOutbox(db, tg.bot), 0);
  assert.equal((await db.workflowApprovalNotification.findUniqueOrThrow({
    where: { approvalId: a.id }
  })).state, 'unknown');
  tg.setFail(false);
  assert.equal(await flushWorkflowApprovalOutbox(db, tg.bot), 0);
  await decideWorkflowApproval(db, a.id, 'approve', owner);
  await jobs.stop(run.id);
  assert.equal((await db.workflowApproval.findUniqueOrThrow({
    where: { id: a.id }
  })).state, 'cancelled');
  await assert.rejects(() => jobs.consumeDemoApproval(run.id, a.id));
  const nextRun = await jobs.create('Демонстрация просроченного подтверждения');
  const late = await jobs.requestDemoApproval(nextRun.id);
  await db.workflowApproval.update({ where: { id: late.id },
    data: { expiresAt: new Date(Date.now() - 1000) } });
  await assert.rejects(() => decideWorkflowApproval(db, late.id, 'approve', owner));
  assert.equal(await expireWorkflowApprovals(db), 1);
  assert.equal((await db.workflowApproval.findUniqueOrThrow({
    where: { id: late.id }
  })).state, 'expired');
  assert.equal((await db.workflowApprovalNotification.findUniqueOrThrow({
    where: { approvalId: late.id }
  })).state, 'cancelled');
}));

test('only mock targets can request approval and local API only simulates consumption', {
  skip: !process.env.DATABASE_URL
}, () => fixture(async db => {
  const jobs = new DurableOrchestrator(db, undefined, undefined, undefined, undefined, owner);
  const run = await jobs.create('Проверь демо-согласование через API');
  const app = buildFastifyApp(new PrismaDemoTaskService(db), 'postgres', jobs);
  try {
    const host = '127.0.0.1:4317';
    const path = '/api/workflows/' + run.id + '/approvals/demo';
    const blocked = await app.inject({ method: 'POST', url: path,
      headers: { host: 'evil.example:4317' } });
    assert.equal(blocked.statusCode, 403);
    const crossOrigin = await app.inject({ method: 'POST', url: path,
      headers: { host, origin: 'http://evil.example' } });
    assert.equal(crossOrigin.statusCode, 403);
    const created = await app.inject({ method: 'POST', url: path, headers: { host } });
    assert.equal(created.statusCode, 200);
    const a = created.json().approval;
    assert.equal(a.mode, 'simulation_only');
    assert.equal((await app.inject({ method: 'POST', url: path,
      headers: { host } })).json().approval.id, a.id);
    await decideWorkflowApproval(db, a.id, 'approve', owner);
    const consumed = await app.inject({ method: 'POST',
      url: '/api/workflows/' + run.id + '/approvals/' + a.id + '/consume-demo',
      headers: { host } });
    assert.equal(consumed.statusCode, 200);
    assert.deepEqual([consumed.json().result.simulated,
      consumed.json().result.externalActions], [true, 0]);
    const again = await app.inject({ method: 'POST',
      url: '/api/workflows/' + run.id + '/approvals/' + a.id + '/consume-demo',
      headers: { host } });
    assert.equal(again.statusCode, 409);
    assert.equal((await db.workflowEvent.count({ where: {
      workflowId: run.id, kind: 'approval_mock_consumed'
    } })), 1);
    assert.equal(await db.textDelivery.count(), 0);
  } finally { await app.close(); }
}));

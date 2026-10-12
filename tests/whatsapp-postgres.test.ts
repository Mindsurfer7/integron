import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { DurableOrchestrator } from '../packages/storage/src/orchestrator.ts';
import { WhatsAppUserTestAdapter } from '../packages/transports/src/whatsapp-user.ts';
import { flushTestTextOutbox, handleTestText, WHATSAPP_ROUTE } from '../packages/storage/src/text-gateway.ts';

const JID = '12345678901@s.whatsapp.net', AGENT = '77777777777@s.whatsapp.net';
const policy = { enabled: true, allowedChatIds: new Set([JID]) };
class FakeSocket {
  user = { id: AGENT };
  private readonly handlers = new Map<string, Set<(event: any) => void>>();
  readonly ev = {
    on: (kind: string, fn: (event: any) => void) => {
      if (!this.handlers.has(kind)) this.handlers.set(kind, new Set());
      this.handlers.get(kind)!.add(fn);
    },
    off: (kind: string, fn: (event: any) => void) => this.handlers.get(kind)?.delete(fn)
  };
  emit(kind: string, event: any) { for (const fn of this.handlers.get(kind) ?? []) fn(event); }
  sends = 0;
  sendAck = true;
  async sendMessage(chat: string, _content: { text: string }) {
    this.sends++;
    const key = { remoteJid: chat, id: 'OUTBOUND12345', fromMe: true };
    if (this.sendAck) setImmediate(() => this.emit('messages.update', [{ key, update: { status: 2 } }]));
    return { key };
  }
}
async function fixture(fn: (db: PrismaClient, jobs: DurableOrchestrator) => Promise<void>) {
  const db = new PrismaClient();
  await db.$connect();
  try {
    await db.workflowRun.deleteMany();
    await db.demoTask.deleteMany();
    await fn(db, new DurableOrchestrator(db, undefined, undefined, policy));
  } finally {
    await db.workflowRun.deleteMany();
    await db.demoTask.deleteMany();
    await db.$disconnect();
  }
}
test('Postgres fake WhatsApp -> confirmed outgoing -> correlated reply -> workflow completes once', {
  skip: !process.env.DATABASE_URL
}, () => fixture(async (db,jobs) => {
  await assert.rejects(() => jobs.create('Запрети другой контакт',
    { transport: 'whatsapp_user_test', targetChatId: '10987654321@s.whatsapp.net' }));
  const run = await jobs.create('Узнай цену тестового товара',
    { transport: 'whatsapp_user_test', targetChatId: JID });
  await jobs.tick(); await jobs.tick();
  assert.equal((await jobs.get(run.id)).step, 'await_external');
  const client = new FakeSocket();
  const adapter = new WhatsAppUserTestAdapter(client, AGENT, policy, 1000);
  try {
    assert.equal(await flushTestTextOutbox(db, adapter, policy, 1, WHATSAPP_ROUTE), 1);
    assert.equal(client.sends, 1);
    const delivery = await db.textDelivery.findUniqueOrThrow({ where: { workflowId: run.id } });
    assert.equal(delivery.state, 'sent');
    assert.equal(delivery.providerId, 'OUTBOUND12345');
    const incoming = { updateId: 0, providerMessageId: 'INBOUND12345',
      replyToProviderId: 'OUTBOUND12345', chatId: JID, senderId: JID,
      chatType: 'private', body: '350 THB, тестовый ответ' };
    assert.equal(await handleTestText(db, policy, { ...incoming, senderId: 'wrong' }, WHATSAPP_ROUTE), false);
    assert.equal(await handleTestText(db, policy, { ...incoming, replyToProviderId: 'other' }, WHATSAPP_ROUTE), false);
    assert.equal(await handleTestText(db, policy, incoming, WHATSAPP_ROUTE), true);
    assert.equal(await handleTestText(db, policy, incoming, WHATSAPP_ROUTE), false);
    const restarted = new DurableOrchestrator(db, undefined, undefined, policy);
    assert.equal((await restarted.get(run.id)).step, 'process_external');
    await restarted.tick();
    assert.equal((await restarted.get(run.id)).state, 'completed');
    assert.equal((await db.textMessage.count({ where: { workflowId: run.id, direction: 'in' } })), 1);
    assert.equal(await flushTestTextOutbox(db, adapter, policy, 1, WHATSAPP_ROUTE), 0);
    assert.equal(client.sends, 1);
  } finally { await adapter.close(); }
}));

test('Postgres stopped WhatsApp workflow never dispatches queued text', {
  skip: !process.env.DATABASE_URL
}, () => fixture(async (db,jobs) => {
  const run = await jobs.create('Останови до отправки',
    { transport: 'whatsapp_user_test', targetChatId: JID });
  await jobs.tick(); await jobs.tick();
  await jobs.stop(run.id);
  const client = new FakeSocket();
  const adapter = new WhatsAppUserTestAdapter(client, AGENT, policy);
  try {
    assert.equal(await flushTestTextOutbox(db, adapter, policy, 1, WHATSAPP_ROUTE), 0);
    assert.equal(client.sends, 0);
    assert.equal((await db.textDelivery.findUniqueOrThrow({ where:{workflowId:run.id} })).state, 'cancelled');
  } finally { await adapter.close(); }
}));

test('Postgres WhatsApp delivery with unknown server ACK is never automatically resent', {
  skip: !process.env.DATABASE_URL
}, () => fixture(async (db, jobs) => {
  const run = await jobs.create('Проверь неопределённую доставку',
    { transport: 'whatsapp_user_test', targetChatId: JID });
  await jobs.tick(); await jobs.tick();
  const fake = new FakeSocket(); fake.sendAck = false;
  const adapter = new WhatsAppUserTestAdapter(fake, AGENT, policy, 15);
  try {
    assert.equal(await flushTestTextOutbox(db, adapter, policy, 1, WHATSAPP_ROUTE), 0);
    assert.equal((await db.textDelivery.findUniqueOrThrow({
      where: { workflowId: run.id }
    })).state, 'unknown');
    assert.equal(await flushTestTextOutbox(db, adapter, policy, 1, WHATSAPP_ROUTE), 0);
    assert.equal(fake.sends, 1);
    await db.workflowRun.update({ where: { id: run.id },
      data: { availableAt: new Date(0) } });
    await jobs.tick();
    assert.equal((await jobs.get(run.id)).state, 'failed');
    assert.equal((await jobs.get(run.id)).events.at(-1)?.kind, 'send_unknown_review_required');
  } finally { await adapter.close(); }
}));

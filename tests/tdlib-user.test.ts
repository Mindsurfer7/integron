import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { readTdlibUserPolicy } from '../packages/transports/src/contracts.ts';
import { TdlibUserTransport, parseTdlibIncoming, TdlibDefiniteSendError } from '../packages/transports/src/tdlib-user.ts';
import { TDLIB_ROUTE, flushTestTextOutbox, handleTestText } from '../packages/storage/src/text-gateway.ts';
import { DurableOrchestrator } from '../packages/storage/src/orchestrator.ts';

const policy = { enabled: true, allowedChatIds: new Set(['42','43']) };
const incoming = (id = '1702', sender = 42, chatId = 42, replyId = '711') => ({
  _: 'updateNewMessage', message: {
    id, chat_id: chatId, is_outgoing: false,
    sender_id: { _: 'messageSenderUser', user_id: sender },
    reply_to: { _: 'messageReplyToMessage', message_id: replyId },
    content: { _: 'messageText', text: { _: 'formattedText', text: 'Да, есть. 350 THB' } }
  }
});
class FakeTdlib {
  listeners = new Set<(value: Record<string, any>) => void>();
  calls: Record<string,any>[] = [];
  history: Record<string,any>[] = [];
  userId = 777;
  chatType = 'chatTypePrivate';
  failSending = false;
  on(_event: 'update', cb: (u: Record<string,any>) => void) { this.listeners.add(cb); }
  off(_event: 'update', cb: (u: Record<string,any>) => void) { this.listeners.delete(cb); }
  emit(update: Record<string,any>) { for (const fn of this.listeners) fn(update); }
  async invoke(request: Record<string,any>) {
    this.calls.push(request);
    if (request._ === 'getMe') return { id: this.userId, type: { _: 'userTypeRegular' } };
    if (request._ === 'getChat') return { id: request.chat_id,
      type: { _: this.chatType, user_id: request.chat_id } };
    if (request._ === 'getChatHistory') return { messages: this.history };
    if (request._ === 'sendMessage') {
      if (this.failSending) this.emit({ _: 'updateMessageSendFailed',
        chat_id: request.chat_id, message_id: 900, error_code: 403 });
      else this.emit({ _: 'updateMessageSendSucceeded',
        old_message_id: 900, message: { id: 711, chat_id: request.chat_id } });
      return { id: 900, sending_state: { _: 'messageSendingStatePending' } };
    }
    throw new Error('Unexpected TDLib method');
  }
  async close() {}
}
async function fixture(fn: (db: PrismaClient, jobs: DurableOrchestrator) => Promise<void>) {
  const db = new PrismaClient();
  await db.$connect();
  try {
    await db.workflowRun.deleteMany({});
    await db.demoTask.deleteMany({});
    await fn(db, new DurableOrchestrator(db, undefined, policy));
  } finally {
    await db.workflowRun.deleteMany({});
    await db.demoTask.deleteMany({});
    await db.$disconnect();
  }
}
test('TDLib auth boundary and message parser fail closed', async () => {
  assert.deepEqual([...readTdlibUserPolicy({
    TEST_TDLIB_ENABLED:'true', TDLIB_ALLOWED_CHAT_IDS:'42,43'
  }).allowedChatIds], ['42','43']);
  assert.throws(() => readTdlibUserPolicy({ TEST_TDLIB_ENABLED:'true' }));
  const f = new FakeTdlib();
  const adapter = new TdlibUserTransport(f,'777',policy);
  assert.equal(await adapter.health(), true);
  await assert.rejects(() => adapter.send({workflowId:'test',chatId:'99',body:'hello'}));
  await assert.rejects(() => adapter.send({workflowId:'test',chatId:'42',body:''}),
    e => e instanceof TdlibDefiniteSendError);
  f.chatType = 'chatTypeSupergroup';
  await assert.rejects(() => adapter.send({workflowId:'test',chatId:'42',body:'hello'}),
    e => e instanceof TdlibDefiniteSendError);
  f.chatType = 'chatTypePrivate';
  f.userId = 999;
  await assert.rejects(() => adapter.health());
  assert.equal(parseTdlibIncoming(incoming('1702'))?.replyToProviderId,'711');
  assert.equal(parseTdlibIncoming({_: 'updateNewMessage', message: {
    ...incoming().message, is_outgoing: true
  } }), null);
  assert.equal(parseTdlibIncoming({_: 'updateNewMessage',message:{
    ...incoming().message, reply_to: undefined
  }}), null);
  await adapter.close();
});

test('TDLib confirmed provider ID -> reply evidence -> restart same workflow', {
  skip: !process.env.DATABASE_URL
}, () => fixture(async (db,jobs) => {
  const job = await jobs.create('Уточни у согласившегося тестового контакта',
    {transport:'telegram_user_test',targetChatId:'42'});
  const fake = new FakeTdlib();
  const adapter = new TdlibUserTransport(fake,'777',policy);
  await adapter.health();
  const unsubscribe = adapter.subscribe(msg => handleTestText(db,policy,msg,TDLIB_ROUTE));
  try {
    await jobs.tick(); await jobs.tick();
    assert.equal((await jobs.get(job.id)).state, 'waiting_external');
    assert.equal((await db.textDelivery.findUniqueOrThrow({
      where:{ workflowId:job.id }
    })).channel, 'telegram_user_test');
    assert.equal(await flushTestTextOutbox(db,adapter,policy,2,TDLIB_ROUTE),1);
    const delivery = await db.textDelivery.findUniqueOrThrow({where:{workflowId:job.id}});
    assert.equal(delivery.providerId,'711');
    assert.equal(delivery.state,'sent');
    const sendCall = fake.calls.find(call => call._ === 'sendMessage');
    assert.equal(sendCall.chat_id,42);
    assert.match(sendCall.input_message_content.text.text,/тестовый запрос/);

    // Bad user and unrelated chat cannot modify the workflow.
    fake.emit(incoming('1703',999));
    fake.emit(incoming('1704',43,43));
    fake.emit(incoming('1705',42,42,'999'));
    await new Promise(resolve=>setTimeout(resolve,15));
    assert.equal((await jobs.get(job.id)).state,'waiting_external');
    assert.equal(await db.textMessage.count({where:{direction:'in'}}),0);

    const real = incoming('1706');
    fake.emit(real);
    // Handler is async; reconciling must also apply exactly once.
    fake.history = [real.message];
    for(const msg of await adapter.reconcile('42')) {
      await handleTestText(db,policy,msg,TDLIB_ROUTE);
    }
    const second = new PrismaClient();
    try {
      const resumed = new DurableOrchestrator(second,undefined,policy);
      assert.equal((await resumed.get(job.id)).step,'process_external');
      assert.equal(await resumed.tick(),job.id);
      assert.equal((await resumed.get(job.id)).state,'completed');
      assert.equal(await resumed.tick(),null);
    } finally { await second.$disconnect(); }
    assert.equal(await db.textMessage.count({where:{direction:'in'}}),1);
    assert.equal((await db.textMessage.findFirstOrThrow({
      where:{direction:'in'}
    })).providerMessageId,'1706');
  } finally {unsubscribe(); await adapter.close();}
}));

test('TDLib definitive failure, unknown interrupted send, expiry and stop', {
  skip: !process.env.DATABASE_URL
}, () => fixture(async (db,jobs) => {
  const stopped = await jobs.create('Отмени тест до отправки', {
    transport:'telegram_user_test',targetChatId:'42'
  });
  await jobs.tick();await jobs.tick();
  await jobs.stop(stopped.id);
  const f = new FakeTdlib();
  const a = new TdlibUserTransport(f,'777',policy);
  assert.equal(await flushTestTextOutbox(db,a,policy,2,TDLIB_ROUTE),0);
  assert.equal(f.calls.filter(x=>x._==='sendMessage').length,0);
  const failed = await jobs.create('Отказ отправки', {
    transport:'telegram_user_test',targetChatId:'42'
  });
  await jobs.tick();await jobs.tick();
  f.failSending = true;
  await flushTestTextOutbox(db,a,policy,2,TDLIB_ROUTE);
  assert.equal((await db.textDelivery.findUniqueOrThrow({
    where:{workflowId:failed.id}
  })).state,'failed');
  assert.equal(await flushTestTextOutbox(db,a,policy,2,TDLIB_ROUTE),0);
  await a.close();

  const unknown = await jobs.create('Неопределённая доставка', {
    transport:'telegram_user_test',targetChatId:'43'
  });
  await jobs.tick();await jobs.tick();
  await db.textDelivery.update({where:{workflowId:unknown.id},
    data:{state:'sending',leasedUntil:new Date(Date.now()-60_000)}});
  const b = new TdlibUserTransport(new FakeTdlib(),'777',policy);
  await flushTestTextOutbox(db,b,policy,2,TDLIB_ROUTE);
  assert.equal((await db.textDelivery.findUniqueOrThrow({
    where:{workflowId:unknown.id}
  })).state,'unknown');
  assert.equal(await db.textMessage.count({where:{workflowId:unknown.id}}),0);
  await db.workflowRun.update({where:{id:unknown.id},data:{availableAt:new Date(0)}});
  await jobs.tick();
  assert.equal((await jobs.get(unknown.id)).state,'failed');
  await b.close();
}));

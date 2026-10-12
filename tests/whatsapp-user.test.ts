import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readWhatsAppUserPolicy, authorizeWhatsAppTestText } from '../packages/transports/src/contracts.ts';
import { WhatsAppUserTestAdapter, accountJid, parseWhatsAppIncoming } from '../packages/transports/src/whatsapp-user.ts';

const ALLOWED = '12345678901@s.whatsapp.net';
const OTHER = '10987654321@s.whatsapp.net';
const AGENT = '77777777777@s.whatsapp.net';
const policy = { enabled: true, allowedChatIds: new Set([ALLOWED]) };
const intent = { workflowId: 'offline-only', chatId: ALLOWED, body: 'Opt-in test request' };
type Handler = (event: any) => void;
class FakeSocket {
  user = { id: '77777777777:3@s.whatsapp.net' };
  listeners = new Map<string, Set<Handler>>();
  sends: { jid: string; text: string }[] = [];
  mode: 'early' | 'late' | 'timeout' | 'bad' = 'late';
  ev = {
    on: (event: 'messages.upsert' | 'messages.update', callback: Handler) => {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(callback);
    },
    off: (event: 'messages.upsert' | 'messages.update', callback: Handler) =>
      this.listeners.get(event)?.delete(callback)
  };
  emit(event: string, data: any) {
    for (const fn of this.listeners.get(event) ?? []) fn(data);
  }
  async sendMessage(jid: string, content: { text: string }) {
    this.sends.push({ jid, text: content.text });
    const response = { key: { id: 'ABCDEF123456', remoteJid: jid, fromMe: true } };
    const ack = [{ key: response.key, update: { status: 2 } }];
    if (this.mode === 'early') this.emit('messages.update', ack);
    if (this.mode === 'late') setImmediate(() => this.emit('messages.update', ack));
    if (this.mode === 'bad') return { key: { ...response.key, remoteJid: OTHER } };
    return response;
  }
}
function reply({ chat = ALLOWED, fromMe = false, id = 'INBOUND1234',
  stanza = 'ABCDEF123456', body = 'Есть, 350 THB', participant = undefined } = {}) {
  return { key: { id, remoteJid: chat, fromMe, participant },
    message: { extendedTextMessage: {
      text: body, contextInfo: { stanzaId: stanza }
    } } };
}

test('policy fails closed on default, groups, contacts, duplicates and account reuse', () => {
  assert.equal(readWhatsAppUserPolicy({}).enabled, false);
  assert.throws(() => readWhatsAppUserPolicy({ TEST_WHATSAPP_USER_ENABLED: 'yes' }));
  assert.throws(() => readWhatsAppUserPolicy({ TEST_WHATSAPP_USER_ENABLED: 'true' }));
  assert.throws(() => readWhatsAppUserPolicy({ TEST_WHATSAPP_USER_ENABLED: 'true',
    WHATSAPP_ALLOWED_JIDS: '123@g.us', WHATSAPP_AGENT_JID: AGENT }));
  assert.throws(() => readWhatsAppUserPolicy({ TEST_WHATSAPP_USER_ENABLED: 'true',
    WHATSAPP_ALLOWED_JIDS: ALLOWED + ',' + ALLOWED, WHATSAPP_AGENT_JID: AGENT }));
  assert.throws(() => readWhatsAppUserPolicy({ TEST_WHATSAPP_USER_ENABLED: 'true',
    WHATSAPP_ALLOWED_JIDS: ALLOWED, WHATSAPP_AGENT_JID: ALLOWED }));
  assert.deepEqual([...readWhatsAppUserPolicy({ TEST_WHATSAPP_USER_ENABLED: 'true',
    WHATSAPP_ALLOWED_JIDS: ALLOWED, WHATSAPP_AGENT_JID: AGENT }).allowedChatIds], [ALLOWED]);
  assert.equal(authorizeWhatsAppTestText(policy, ALLOWED), ALLOWED);
  assert.throws(() => authorizeWhatsAppTestText(policy, OTHER));
  assert.throws(() => authorizeWhatsAppTestText(policy, '12345678901@g.us'));
  assert.equal(accountJid('77777777777:3@s.whatsapp.net'), AGENT);
  assert.equal(accountJid('77777777777@broadcast'), null);
});

test('strict inbound: single contact, actual reply to sent message, text only', () => {
  assert.equal(parseWhatsAppIncoming(reply())?.replyToProviderId, 'ABCDEF123456');
  assert.equal(parseWhatsAppIncoming(reply())?.senderId, ALLOWED);
  assert.equal(parseWhatsAppIncoming(reply({ chat: '12345678901@g.us' })), null);
  assert.equal(parseWhatsAppIncoming(reply({ fromMe: true })), null);
  assert.equal(parseWhatsAppIncoming(reply({ stanza: 'bad' })), null);
  assert.equal(parseWhatsAppIncoming(reply({ participant: OTHER })), null);
  assert.equal(parseWhatsAppIncoming({ key: { remoteJid: ALLOWED, fromMe: false, id: 'REAL1234' },
    message: { imageMessage: { mimetype: 'image/jpeg' } } }), null);
});

test('ACK before and after send result yields confirmed ID, not merely socket enqueue', async () => {
  for (const mode of ['early', 'late'] as const) {
    const client = new FakeSocket(); client.mode = mode;
    const adapter = new WhatsAppUserTestAdapter(client, AGENT, policy, 200);
    try {
      assert.equal(await adapter.health(), true);
      assert.equal((await adapter.send(intent)).providerMessageId, 'ABCDEF123456');
      assert.deepEqual(client.sends, [{ jid: ALLOWED, text: 'Opt-in test request' }]);
    } finally { await adapter.close(); }
  }
});

test('wrong identity/chat never sends; unknown ACK stays unknown, no auto-retry', async () => {
  const client = new FakeSocket();
  const adapter = new WhatsAppUserTestAdapter(client, AGENT, policy, 20);
  try {
    await assert.rejects(() => adapter.send({ ...intent, chatId: OTHER }));
    assert.equal(client.sends.length, 0);
    client.user.id = '99999999999@s.whatsapp.net';
    await assert.rejects(() => adapter.send(intent), /identity mismatch/);
    assert.equal(client.sends.length, 0);
    client.user.id = AGENT;
    client.mode = 'bad';
    await assert.rejects(() => adapter.send(intent), /outcome unknown/);
    assert.equal(client.sends.length, 1);
    client.mode = 'timeout';
    await assert.rejects(() => adapter.send(intent), /outcome unknown/);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(client.sends.length, 2);
  } finally { await adapter.close(); }
});

test('inbound handler only gets explicit notify private allowlisted replies', async () => {
  const client = new FakeSocket();
  const adapter = new WhatsAppUserTestAdapter(client, AGENT, policy, 50);
  const messages: string[] = [];
  const unsubscribe = adapter.subscribe(async incoming => { messages.push(incoming.body); });
  try {
    client.emit('messages.upsert', { type: 'append', messages: [reply()] });
    client.emit('messages.upsert', { type: 'notify', messages: [reply({chat:OTHER}), reply()] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(messages, ['Есть, 350 THB']);
    unsubscribe();
    client.emit('messages.upsert', { type: 'notify', messages: [reply()] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(messages, ['Есть, 350 THB']);
  } finally { await adapter.close(); }
});

test('WhatsApp offline preflight accepts synthetic opt-in env and never logs JIDs', () => {
  const args = ['scripts/local-preflight.mjs', 'whatsapp'];
  const env = { ...process.env, TEST_WHATSAPP_USER_ENABLED: 'true',
    WHATSAPP_LIVE_CONNECT_ENABLED: 'true', OUTBOUND_ENABLED: 'false',
    WHATSAPP_AGENT_JID: AGENT, WHATSAPP_ALLOWED_JIDS: ALLOWED,
    DATABASE_URL: 'postgresql://fake:fake@127.0.0.1:5432/no_connection_attempt' };
  const output = execFileSync(process.execPath, args, { env, encoding: 'utf8' });
  assert.match(output, /Offline preflight passed/);
  assert.doesNotMatch(output, /77777777777|12345678901|fake:fake/);
  assert.throws(() => execFileSync(process.execPath, args, {
    env: { ...env, TEST_WHATSAPP_USER_ENABLED: 'false' }, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'] }));
});

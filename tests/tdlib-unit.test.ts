import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TdlibUserTransport, TdlibDefiniteSendError, parseTdlibIncoming } from '../packages/transports/src/tdlib-user.ts';

type Event = Record<string, any>;
type Mode = 'early-success' | 'late-success' | 'failure' | 'no-state';
class FakeClient {
  readonly listeners = new Set<(update: Event) => void>();
  readonly calls: Event[] = [];
  readonly mode: Mode;
  constructor(mode: Mode) { this.mode = mode; }
  on(_event: 'update', fn: (update: Event) => void) { this.listeners.add(fn); }
  off(_event: 'update', fn: (update: Event) => void) { this.listeners.delete(fn); }
  emit(update: Event) { for (const fn of this.listeners) fn(update); }
  async invoke(req: Event): Promise<Event> {
    this.calls.push(req);
    if (req._ === 'getMe') return { id: 777, type: { _: 'userTypeRegular' } };
    if (req._ === 'getChat') return { type: { _: 'chatTypePrivate', user_id: req.chat_id } };
    if (req._ !== 'sendMessage') throw new Error('unexpected TDLib invocation');
    if (this.mode === 'no-state') return { id: -900 };
    if (this.mode === 'failure') {
      this.emit({ _: 'updateMessageSendFailed', old_message_id: -900, error: { code: 403 } });
    } else {
      const success = { _: 'updateMessageSendSucceeded',
        old_message_id: -900, message: { id: 711, chat_id: req.chat_id } };
      if (this.mode === 'early-success') this.emit(success);
      else setImmediate(() => this.emit(success));
    }
    return { id: -900, sending_state: { _: 'messageSendingStatePending' } };
  }
  async close() {}
}
const allowlist = { enabled: true, allowedChatIds: new Set(['42']) };
const intent = { workflowId: 'fake-workflow', chatId: '42', body: 'Opt-in test only' };

test('signed TDLib temporary IDs resolve to final provider IDs (early and late update)', async () => {
  for (const mode of ['early-success', 'late-success'] as const) {
    const client = new FakeClient(mode);
    const adapter = new TdlibUserTransport(client, '777', allowlist);
    try {
      assert.equal(await adapter.health(), true);
      const receipt = await adapter.send(intent);
      assert.equal(receipt.providerMessageId, '711');
      assert.equal(client.calls.filter(c => c._ === 'sendMessage').length, 1);
    } finally { await adapter.close(); }
  }
});

test('a missing TDLib sending state is never treated as confirmed delivery', async () => {
  const client = new FakeClient('no-state');
  const adapter = new TdlibUserTransport(client, '777', allowlist);
  try {
    await assert.rejects(() => adapter.send(intent), /outcome unknown/);
    assert.equal(client.calls.filter(c => c._ === 'sendMessage').length, 1);
  } finally { await adapter.close(); }
});

test('failed sending is definitive; disallowed recipients never dispatch', async () => {
  const client = new FakeClient('failure');
  const adapter = new TdlibUserTransport(client, '777', allowlist);
  try {
    await assert.rejects(() => adapter.send({ ...intent, chatId: '43' }));
    assert.equal(client.calls.filter(c => c._ === 'sendMessage').length, 0);
    await assert.rejects(() => adapter.send(intent),
      error => error instanceof TdlibDefiniteSendError);
    assert.equal(client.calls.filter(c => c._ === 'sendMessage').length, 1);
  } finally { await adapter.close(); }
});

test('incoming parser requires a correlated reply from a private-user sender', () => {
  const message = { id: 100, chat_id: 42, is_outgoing: false,
    sender_id: { _: 'messageSenderUser', user_id: 42 },
    reply_to: { _: 'messageReplyToMessage', message_id: 711 },
    content: { _: 'messageText', text: { text: 'Test reply' } } };
  const parsed = parseTdlibIncoming({ _: 'updateNewMessage', message });
  assert.equal(parsed?.replyToProviderId, '711');
  assert.equal(parsed?.body, 'Test reply');
  assert.equal(parseTdlibIncoming({ _: 'updateNewMessage', message: { ...message, is_outgoing: true } }), null);
  assert.equal(parseTdlibIncoming({ _: 'updateNewMessage', message: { ...message, reply_to: null } }), null);
  assert.equal(parseTdlibIncoming({ _: 'updateNewMessage', message: { ...message,
    sender_id: { _: 'messageSenderChat', chat_id: 42 } } }), null);
});

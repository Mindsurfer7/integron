import type { IncomingText, TextSendIntent, TextSendReceipt, TestTextPolicy } from './contracts.ts';
import { authorizeTestText, TRANSPORT_CAPABILITIES } from './contracts.ts';

type ObjectValue = Record<string, any>;
export interface TdlibClientLike {
  invoke(request: ObjectValue): Promise<ObjectValue>;
  on(event: 'update', callback: (value: ObjectValue) => void): unknown;
  off?(event: 'update', callback: (value: ObjectValue) => void): unknown;
  close(): Promise<void>;
}

export class TdlibDefiniteSendError extends Error {
  readonly definite = true;
  constructor() { super('TDLib definitively rejected the test send'); }
}
function decimalId(value: unknown): string | null {
  if (typeof value === 'string' && /^[0-9]{1,20}$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}
/** TDLib temporary message IDs are signed int53; final provider IDs are positive. */
function temporaryId(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value !== 0 ? String(value) : null;
  if (typeof value !== 'string' || !/^-?[1-9][0-9]*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number !== 0 ? String(number) : null;
}
function numericChatId(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('TDLib chat ID exceeds JS safe integer');
  return n;
}

/** Extract only TEXT replies from private users; never execute instructions from messages. */
export function parseTdlibIncoming(update: ObjectValue): IncomingText | null {
  if (update?._ !== 'updateNewMessage') return null;
  const message = update.message;
  if (!message || message.is_outgoing ||
      message.sender_id?._ !== 'messageSenderUser' ||
      message.content?._ !== 'messageText') return null;
  const chatId = decimalId(message.chat_id);
  const senderId = decimalId(message.sender_id.user_id);
  const messageId = decimalId(message.id);
  const reply = message.reply_to;
  const replyId = reply?._ === 'messageReplyToMessage' ? decimalId(reply.message_id) : null;
  const body = message.content.text?.text;
  if (!chatId || !senderId || !messageId || !replyId || typeof body !== 'string' || !body.trim()) return null;
  return { updateId: 0, chatId, senderId, providerMessageId: messageId,
    replyToProviderId: replyId, body, chatType: 'private' };
}

/** Native TDLib streaming transport. Dependency is loaded by its standalone worker,
 * not by the HTTP/demo runtimes. Uses distinct USER login, not the owner bot. */
export class TdlibUserTransport {
  readonly capabilities = TRANSPORT_CAPABILITIES.find(c => c.channel === 'telegram_user_test')!;
  private readonly client: TdlibClientLike;
  private readonly expectedUserId: string;
  private readonly policy: TestTextPolicy;
  private readonly replies = new Set<(message: IncomingText) => Promise<unknown>>();
  private readonly successful = new Map<string, string>();
  private readonly failed = new Set<string>();
  private readonly waiters = new Map<string, {resolve: (id: string) => void; reject: (err: Error) => void}>();
  private readonly onUpdate: (update: ObjectValue) => void;

  constructor(client: TdlibClientLike, expectedUserId: string, policy: TestTextPolicy) {
    if (!/^[1-9][0-9]{0,15}$/.test(expectedUserId) || !policy.enabled) {
      throw new Error('Expected Telegram USER ID and explicit TDLib allowlist required');
    }
    this.client = client; this.expectedUserId = expectedUserId; this.policy = policy;
    this.onUpdate = update => { void this.processUpdate(update).catch(() => {
      // Handler failures are recovered from private chat history on worker cycles.
    }); };
    this.client.on('update', this.onUpdate);
  }

  async health(): Promise<boolean> {
    const me = await this.client.invoke({ _: 'getMe' });
    const id = decimalId(me?.id);
    if (id !== this.expectedUserId || me?.type?._ === 'userTypeBot' || me?.is_bot === true) {
      throw new Error('TDLib session identity mismatch; refusing outbound');
    }
    return true;
  }

  private async isPrivate(chatId: string): Promise<boolean> {
    authorizeTestText(this.policy, chatId);
    const chat = await this.client.invoke({ _: 'getChat', chat_id: numericChatId(chatId) });
    return chat?.type?._ === 'chatTypePrivate' &&
      decimalId(chat.type.user_id) === chatId;
  }

  private async processUpdate(update: ObjectValue): Promise<void> {
    const kind = update?._;
    if (kind === 'updateMessageSendSucceeded' || kind === 'updateMessageSendFailed') {
      const old = temporaryId(update.old_message_id ?? update.message_id);
      const id = decimalId(update.message?.id);
      if (!old) return;
      if (kind === 'updateMessageSendSucceeded' && id) {
        this.successful.set(old, id);
        this.waiters.get(old)?.resolve(id);
      } else if (kind === 'updateMessageSendFailed') {
        this.failed.add(old);
        this.waiters.get(old)?.reject(new TdlibDefiniteSendError());
      }
      return;
    }
    const incoming = parseTdlibIncoming(update);
    if (!incoming || !this.policy.allowedChatIds.has(incoming.chatId) ||
        incoming.senderId !== incoming.chatId || !await this.isPrivate(incoming.chatId)) return;
    for (const fn of this.replies) await fn(incoming);
  }

  subscribe(handler: (incoming: IncomingText) => Promise<unknown>): () => void {
    this.replies.add(handler);
    return () => { this.replies.delete(handler); };
  }

  async send(intent: TextSendIntent): Promise<TextSendReceipt> {
    const chatId = authorizeTestText(this.policy, intent.chatId);
    if (!await this.isPrivate(chatId)) throw new TdlibDefiniteSendError();
    if (intent.body.length > 1024 || intent.body.trim().length === 0) {
      throw new TdlibDefiniteSendError();
    }
    // TDLib sendMessage returns a temporary ID. Actual confirmed provider ID
    // arrives in updateMessageSendSucceeded; persisting temporary IDs is unsafe.
    const sent = await this.client.invoke({
      _: 'sendMessage', chat_id: numericChatId(chatId),
      input_message_content: {
        _: 'inputMessageText',
        text: { _: 'formattedText', text: intent.body, entities: [] },
        clear_draft: false
      }
    });
    const tempId = temporaryId(sent?.id);
    if (!tempId) throw new Error('TDLib send result lacks temporary message ID');
    if (sent.sending_state?._ === 'messageSendingStateFailed' || this.failed.has(tempId)) {
      throw new TdlibDefiniteSendError();
    }
    const immediate = this.successful.get(tempId);
    if (immediate) return { providerMessageId: immediate };
    // Without a confirmed final ID, the outcome is UNKNOWN, never a successful
    // delivery. TDLib may omit sending_state in a malformed/incompatible response.
    if (sent.sending_state?._ !== 'messageSendingStatePending') {
      throw new Error('TDLib send has no confirmed provider ID; outcome unknown');
    }
    const providerId = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(tempId);
        reject(new Error('TDLib send confirmation timeout'));
      }, 15_000);
      this.waiters.set(tempId, {
        resolve: value => { clearTimeout(timeout); this.waiters.delete(tempId); resolve(value); },
        reject: err => { clearTimeout(timeout); this.waiters.delete(tempId); reject(err); }
      });
      // Re-check update racing the listener registration.
      const success = this.successful.get(tempId);
      if (success) this.waiters.get(tempId)?.resolve(success);
      else if (this.failed.has(tempId)) this.waiters.get(tempId)?.reject(new TdlibDefiniteSendError());
    });
    return { providerMessageId: providerId };
  }

  /** Re-read recent messages after crash: TDLib updates are not a transactional DB cursor. */
  async reconcile(chatId: string, limit = 100): Promise<IncomingText[]> {
    if (!await this.isPrivate(chatId)) return [];
    const result = await this.client.invoke({
      _: 'getChatHistory', chat_id: numericChatId(chatId), from_message_id: 0, offset: 0,
      limit, only_local: false
    });
    if (!Array.isArray(result?.messages)) return [];
    return result.messages.map((message: ObjectValue) =>
      parseTdlibIncoming({ _: 'updateNewMessage', message }))
      .filter((message: IncomingText | null): message is IncomingText =>
        Boolean(message && message.chatId === chatId && message.senderId === chatId));
  }

  async close(): Promise<void> {
    this.client.off?.('update', this.onUpdate);
    this.replies.clear();
    await this.client.close();
  }
}

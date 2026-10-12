import type { IncomingText, TextSendIntent, TextSendReceipt, TestTextPolicy } from './contracts.ts';
import { TRANSPORT_CAPABILITIES, authorizeWhatsAppTestText } from './contracts.ts';

/** Small shape used by the Baileys driver. The adapter itself does not import/connect WhatsApp. */
export interface WhatsAppSocketLike {
  user?: { id?: string } | null;
  ev: {
    on(event: 'messages.upsert' | 'messages.update', listener: (update: any) => void): unknown;
    off?(event: 'messages.upsert' | 'messages.update', listener: (update: any) => void): unknown;
  };
  sendMessage(jid: string, content: { text: string }): Promise<{ key?: {
    id?: string | null; remoteJid?: string | null; fromMe?: boolean | null
  } } | undefined>;
}

/** Device JIDs are different from private recipient JIDs; compare normalized identities. */
export function accountJid(jid: unknown): string | null {
  if (typeof jid !== 'string') return null;
  const match = /^([1-9][0-9]{6,14})(?::[0-9]{1,4})?@s\.whatsapp\.net$/.exec(jid);
  return match ? match[1] + '@s.whatsapp.net' : null;
}
const MESSAGE_ID = /^[A-Za-z0-9_-]{8,128}$/;

function whatsappBody(message: any): { text: string; replyId: string } | null {
  // Reply-to is required for binding evidence to an outstanding WorkflowRun.
  const content = message?.message?.ephemeralMessage?.message ?? message?.message;
  if (!content || content.viewOnceMessage || content.imageMessage ||
      content.videoMessage || content.documentMessage || content.protocolMessage) return null;
  const extended = content.extendedTextMessage;
  if (typeof extended?.text !== 'string' || !extended.text.trim() ||
      extended.text.length > 2000 ||
      typeof extended.contextInfo?.stanzaId !== 'string' ||
      !MESSAGE_ID.test(extended.contextInfo.stanzaId)) return null;
  return { text: extended.text.trim(), replyId: extended.contextInfo.stanzaId };
}

export function parseWhatsAppIncoming(message: any): IncomingText | null {
  const key = message?.key;
  const chatId = key?.remoteJid;
  if (!chatId || !accountJid(chatId) || accountJid(chatId) !== chatId ||
      key.fromMe !== false || key.participant ||
      typeof key.id !== 'string' || !MESSAGE_ID.test(key.id)) return null;
  const body = whatsappBody(message);
  if (!body) return null;
  return { updateId: 0, chatId, senderId: chatId, chatType: 'private',
    providerMessageId: key.id, replyToProviderId: body.replyId, body: body.text };
}

type Pending = { resolve: () => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> };

/**
 * P2.3 opt-in adapter. A Baileys sendMessage result only means enqueued;
 * success requires a matching outgoing SERVER_ACK (status >= 2).
 * No retries on uncertain outcomes, no group/list/status/newsletter/media support.
 */
export class WhatsAppUserTestAdapter {
  readonly capabilities = TRANSPORT_CAPABILITIES.find(c => c.channel === 'whatsapp_user_test')!;
  private readonly client: WhatsAppSocketLike;
  private readonly expectedAgentJid: string;
  private readonly policy: TestTextPolicy;
  private readonly ackTimeoutMs: number;
  private readonly confirmed = new Set<string>();
  private inFlight = false;
  private readonly waiters = new Map<string, Pending>();
  private readonly replies = new Set<(message: IncomingText) => Promise<unknown>>();
  private readonly onMessage: (event: any) => void;
  private readonly onAck: (event: any) => void;

  constructor(client: WhatsAppSocketLike, expectedAgentJid: string,
    policy: TestTextPolicy, ackTimeoutMs = 15_000) {
    if (!policy.enabled || accountJid(expectedAgentJid) !== expectedAgentJid ||
        policy.allowedChatIds.has(expectedAgentJid) ||
        !Number.isInteger(ackTimeoutMs) || ackTimeoutMs < 1) {
      throw new Error('WhatsApp opt-in policy and separate agent identity are required');
    }
    this.client = client;
    this.policy = policy;
    this.expectedAgentJid = expectedAgentJid;
    this.ackTimeoutMs = ackTimeoutMs;
    this.onMessage = event => {
      if (event?.type !== 'notify' || !Array.isArray(event.messages)) return;
      for (const item of event.messages) {
        const parsed = parseWhatsAppIncoming(item);
        if (!parsed || !this.policy.allowedChatIds.has(parsed.chatId)) continue;
        for (const fn of this.replies) {
          void Promise.resolve().then(() => fn(parsed)).catch(() => {
            // Durable inbound state is reconciled separately; never log payloads.
          });
        }
      }
    };
    this.onAck = event => {
      if (!this.inFlight || !Array.isArray(event)) return;
      for (const item of event) {
        const key = item?.key;
        const jid = key?.remoteJid;
        const id = key?.id;
        if (typeof jid !== 'string' || !this.policy.allowedChatIds.has(jid) ||
            key?.fromMe !== true || key?.participant ||
            typeof id !== 'string' || !MESSAGE_ID.test(id) ||
            typeof item.update?.status !== 'number' || item.update.status < 2) continue;
        const correlation = jid + '/' + id;
        this.confirmed.add(correlation);
        const pending = this.waiters.get(correlation);
        if (pending) pending.resolve();
      }
    };
    client.ev.on('messages.upsert', this.onMessage);
    client.ev.on('messages.update', this.onAck);
  }

  async health(): Promise<boolean> {
    if (accountJid(this.client.user?.id) !== this.expectedAgentJid) {
      throw new Error('WhatsApp session identity mismatch; refusing outbound');
    }
    return true;
  }

  subscribe(handler: (incoming: IncomingText) => Promise<unknown>): () => void {
    this.replies.add(handler);
    return () => { this.replies.delete(handler); };
  }

  async send(intent: TextSendIntent): Promise<TextSendReceipt> {
    const jid = authorizeWhatsAppTestText(this.policy, intent.chatId);
    await this.health();
    if (typeof intent.body !== 'string' || intent.body.length > 1024 || !intent.body.trim()) {
      throw new Error('Invalid test message text');
    }
    if (this.inFlight) throw new Error('Concurrent WhatsApp sends not allowed; outcome unknown');
    this.inFlight = true;
    this.confirmed.clear();
    try {
    const result = await this.client.sendMessage(jid, { text: intent.body });
    const key = result?.key;
    if (!key || typeof key.id !== 'string' || !MESSAGE_ID.test(key.id) ||
        key.remoteJid !== jid || key.fromMe !== true) {
      throw new Error('WhatsApp send ID missing or ambiguous; outcome unknown');
    }
    const correlation = jid + '/' + key.id;
    if (!this.confirmed.has(correlation)) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.waiters.delete(correlation);
          reject(new Error('WhatsApp server acknowledgment timeout; outcome unknown'));
        }, this.ackTimeoutMs);
        this.waiters.set(correlation, {
          timeout,
          resolve: () => { clearTimeout(timeout); this.waiters.delete(correlation); resolve(); },
          reject: err => { clearTimeout(timeout); this.waiters.delete(correlation); reject(err); }
        });
        if (this.confirmed.has(correlation)) this.waiters.get(correlation)?.resolve();
      });
    }
    this.confirmed.delete(correlation);
    return { providerMessageId: key.id };
    } finally {
      this.inFlight = false;
      this.confirmed.clear();
    }
  }

  async close(): Promise<void> {
    this.client.ev.off?.('messages.upsert', this.onMessage);
    this.client.ev.off?.('messages.update', this.onAck);
    for (const [key, waiter] of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('WhatsApp adapter closed; outcome unknown'));
      this.waiters.delete(key);
    }
    this.replies.clear();
    this.confirmed.clear();
  }
}

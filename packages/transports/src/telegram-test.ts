import {
  TRANSPORT_CAPABILITIES, type TextTransportAdapter,
  type TextSendIntent, type TextSendReceipt, type TransportUpdate
} from './contracts.ts';

/** Telegram Bot API is used here ONLY with opted-in private test chats.
 * It CANNOT cold-message new users or impersonate a Telegram USER client. */
export class AgentTelegramTestAdapter implements TextTransportAdapter {
  readonly capabilities = TRANSPORT_CAPABILITIES[0];
  private readonly token: string;
  private readonly http: typeof fetch;
  constructor(token: string, http: typeof fetch = fetch) {
    if (!token || !/^[0-9]+:[A-Za-z0-9_-]{8,}$/.test(token)) {
      throw new Error('AGENT_TELEGRAM_BOT_TOKEN must be a valid BotFather token');
    }
    this.token = token;
    this.http = http;
  }
  private async call<T>(method: 'sendMessage' | 'getUpdates' | 'getMe', payload: unknown): Promise<T> {
    const response = await this.http('https://api.telegram.org/bot' + this.token + '/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(method === 'getUpdates' ? 20_000 : 10_000),
      body: JSON.stringify(payload)
    });
    // Telegram 4xx is a definite refusal. 5xx/transport errors can be ambiguous
    // after the provider accepted the send; callers must not blindly retry.
    if (!response.ok && response.status >= 400 && response.status < 500) {
      throw new TelegramTestRejected(response.status);
    }
    if (!response.ok) throw new Error('Telegram uncertain transport result');
    const json = await response.json() as { ok?: boolean; result?: T; error_code?: number };
    if (!json?.ok || json.result === undefined) {
      if (json?.error_code && json.error_code >= 400 && json.error_code < 500) {
        throw new TelegramTestRejected(json.error_code);
      }
      throw new Error('Telegram uncertain API result');
    }
    return json.result;
  }
  async health(): Promise<boolean> {
    const result = await this.call<{ id: number; is_bot: boolean }>('getMe', {});
    return Boolean(result?.is_bot && Number.isSafeInteger(result.id));
  }
  async send(intent: TextSendIntent): Promise<TextSendReceipt> {
    if (intent.body.length > 1024) throw new Error('Test text too long');
    const result = await this.call<{message_id: number}>('sendMessage', {
      chat_id: intent.chatId, text: intent.body, disable_web_page_preview: true
    });
    if (!Number.isSafeInteger(result?.message_id)) throw new Error('Telegram missing message receipt');
    return { providerMessageId: String(result.message_id) };
  }
  async receive(afterUpdateId: number): Promise<TransportUpdate[]> {
    const payload = await this.call<Array<{
      update_id: number;
      message?: {
        message_id: number;
        text?: string;
        from?: { id: number; is_bot?: boolean };
        chat: { id: number; type: string };
        reply_to_message?: { message_id: number }
      }
    }>>('getUpdates', { offset: afterUpdateId, timeout: 8, limit: 25, allowed_updates: ['message'] });
    if (!Array.isArray(payload)) throw new Error('Telegram invalid updates batch');
    return payload.filter(u => Number.isSafeInteger(u.update_id) && u.update_id >= afterUpdateId)
      .map(u => {
        const m = u.message;
        if (!m || typeof m.text !== 'string' || !Number.isSafeInteger(m.message_id) ||
          !m.from || !Number.isSafeInteger(m.from.id) || !Number.isSafeInteger(m.chat.id)) {
          return { updateId: u.update_id };
        }
        return {
          updateId: u.update_id,
          incoming: {
            updateId: u.update_id, providerMessageId: String(m.message_id),
            chatId: String(m.chat.id), senderId: String(m.from.id),
            chatType: m.chat.type, body: m.text,
            replyToProviderId: Number.isSafeInteger(m.reply_to_message?.message_id)
              ? String(m.reply_to_message?.message_id) : undefined
          }
        };
      });
  }
}
export class TelegramTestRejected extends Error {
  readonly definite = true;
  readonly status: number;
  constructor(status: number) {
    super('Telegram request rejected');
    this.status = status;
  }
}

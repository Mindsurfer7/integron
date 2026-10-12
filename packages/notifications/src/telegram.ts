import type { PrismaClient } from '@prisma/client';
import { DemoError, type OwnerChoice } from '../../core/src/demo.ts';
import { PrismaDemoTaskService } from '../../storage/src/prisma.ts';

const CHOICES: readonly OwnerChoice[] = ['cheapest', 'fastest', 'defer'];
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ANSWER = new RegExp('^q:(' + UUID + '):(cheapest|fastest|defer)$');
const COMMAND = new RegExp('^/answer\\s+(' + UUID + ')\\s+(cheapest|fastest|defer)(?:\\s|$)', 'i');
const STOP = new RegExp('^/stop\\s+(' + UUID + ')(?:\\s|$)', 'i');

export interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { chat: { id: number }; message_id: number };
  };
  message?: {
    message_id: number;
    from?: { id: number };
    chat: { id: number };
    text?: string;
    reply_to_message?: { message_id: number };
  };
}
export class TelegramApiError extends Error {
  readonly definite = true;
  constructor(method: string, code: number) {
    super('Telegram rejected ' + method + ' with status ' + code);
  }
}

/** Only the owner notification channel. Never used for outgoing clinic messages. */
export class TelegramBotClient {
  readonly ownerUserId: string;
  readonly ownerChatId: string;
  private readonly token: string;
  private readonly transport: typeof fetch;
  constructor(config: { token: string; ownerUserId: string; ownerChatId: string }, transport: typeof fetch = fetch) {
    if (!config.token || !/^[0-9]+$/.test(config.ownerUserId) || !/^-?[0-9]+$/.test(config.ownerChatId)) {
      throw new Error('TELEGRAM_BOT_TOKEN, OWNER_TELEGRAM_USER_ID and OWNER_TELEGRAM_CHAT_ID are required');
    }
    this.token = config.token;
    this.ownerUserId = config.ownerUserId;
    this.ownerChatId = config.ownerChatId;
    this.transport = transport;
  }
  private async call<T>(method: string, payload: object): Promise<T> {
    const response = await this.transport('https://api.telegram.org/bot' + this.token + '/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 20_000 : 10_000)
    });
    if (!response.ok) throw new TelegramApiError(method, response.status);
    const json = await response.json() as { ok?: boolean; result?: T };
    if (!json.ok || json.result === undefined) throw new TelegramApiError(method, 502);
    return json.result;
  }
  async sendQuestion(id: string, taskId: string): Promise<string> {
    const result = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: this.ownerChatId,
      text: '🤖 Integron · тестовая задача #' + taskId.slice(0, 8) +
        '\n\nКак выбрать предложение из трёх вымышленных организаций?\nВопрос: ' + id,
      reply_markup: { inline_keyboard: [
        [{ text: '💸 Дешевле', callback_data: 'q:' + id + ':cheapest' }],
        [{ text: '⚡ Быстрее', callback_data: 'q:' + id + ':fastest' }],
        [{ text: '⏸ Отложить', callback_data: 'q:' + id + ':defer' }]
      ] }
    });
    return String(result.message_id);
  }
  async sendText(text: string): Promise<void> {
    await this.call('sendMessage', { chat_id: this.ownerChatId, text });
  }
  async acknowledge(callbackId: string, text: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, text, show_alert: false });
  }
  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>('getUpdates', {
      offset, timeout: 8, limit: 25, allowed_updates: ['message', 'callback_query']
    });
  }
}

/** A stuck send becomes UNKNOWN after restart: it is never retried blindly. */
export async function flushOwnerOutbox(prisma: PrismaClient, bot: TelegramBotClient, limit = 10): Promise<number> {
  await prisma.ownerNotification.updateMany({
    where: { state: 'sending', leasedUntil: { lt: new Date() } },
    data: { state: 'unknown', lastError: 'Delivery result unknown after interrupted attempt' }
  });
  const candidates = await prisma.ownerNotification.findMany({
    where: { state: 'queued' },
    include: { clarification: true },
    orderBy: { createdAt: 'asc' },
    take: limit
  });
  let delivered = 0;
  for (const item of candidates) {
    if (item.clarification.state !== 'pending' || item.clarification.expiresAt <= new Date()) {
      await prisma.ownerNotification.updateMany({ where: { id: item.id, state: 'queued' }, data: { state: 'cancelled' } });
      continue;
    }
    const claimed = await prisma.ownerNotification.updateMany({
      where: { id: item.id, state: 'queued' },
      data: { state: 'sending', attempts: { increment: 1 }, leasedUntil: new Date(Date.now() + 35_000) }
    });
    if (claimed.count !== 1) continue;
    try {
      // Recheck state after acquiring the claim; owner may have answered via UI.
      const question = await prisma.ownerClarification.findUnique({ where: { id: item.clarificationId } });
      if (!question || question.state !== 'pending' || question.expiresAt <= new Date()) {
        await prisma.ownerNotification.updateMany({
          where: { id: item.id, state: 'sending' }, data: { state: 'cancelled', leasedUntil: null }
        });
        continue;
      }
      const messageId = await bot.sendQuestion(question.id, question.taskId);
      await prisma.ownerNotification.updateMany({
        where: { id: item.id, state: 'sending' },
        data: { state: 'sent', messageId, leasedUntil: null }
      });
      delivered++;
    } catch (error) {
      // A transport failure could occur *after* Telegram accepted the message.
      const definite = error instanceof TelegramApiError;
      await prisma.ownerNotification.updateMany({
        where: { id: item.id, state: 'sending' },
        data: { state: definite ? 'failed' : 'unknown', leasedUntil: null,
          lastError: definite ? 'Telegram API rejected request' : 'Telegram send result unknown' }
      });
    }
  }
  return delivered;
}

function isOwner(bot: TelegramBotClient, userId: number | undefined, chatId: number | undefined): boolean {
  return userId !== undefined && chatId !== undefined &&
    String(userId) === bot.ownerUserId && String(chatId) === bot.ownerChatId;
}

export async function handleOwnerUpdate(
  prisma: PrismaClient, bot: TelegramBotClient, update: TelegramUpdate
): Promise<void> {
  const workflow = new PrismaDemoTaskService(prisma);
  const callback = update.callback_query;
  if (callback) {
    if (!isOwner(bot, callback.from.id, callback.message?.chat.id)) return;
    const match = ANSWER.exec(callback.data ?? '');
    if (!match) {
      await bot.acknowledge(callback.id, 'Неизвестная команда');
      return;
    }
    let feedback = 'Ответ принят';
    try {
      await workflow.answerQuestion(match[1], match[2] as OwnerChoice);
    } catch (error) {
      if (!(error instanceof DemoError)) throw error;
      feedback = error.code === 'QUESTION_CLOSED' ? 'Вопрос уже закрыт' : 'Не удалось принять ответ';
    }
    await bot.acknowledge(callback.id, feedback);
    return;
  }
  const message = update.message;
  if (!message || !isOwner(bot, message.from?.id, message.chat.id)) return;
  const text = message.text?.trim() ?? '';
  if (/^\/start(?:\s|$)/.test(text) || /^\/help(?:\s|$)/.test(text)) {
    await bot.sendText('Integron: /status — активные вопросы; /answer <id> cheapest|fastest|defer; /stop <taskId>. Только тестовые задачи.');
    return;
  }
  if (/^\/status(?:\s|$)/.test(text)) {
    const active = await prisma.ownerClarification.findMany({
      where: { state: 'pending', expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'asc' }, take: 5
    });
    await bot.sendText(active.length
      ? 'Ожидают ответа:\n' + active.map(q => q.id + ' (задача ' + q.taskId.slice(0, 8) + ')').join('\n')
      : 'Нет ожидающих вопросов.');
    return;
  }
  const stop = STOP.exec(text);
  if (stop) {
    try {
      await workflow.stop(stop[1]);
      await bot.sendText('Задача остановлена: ' + stop[1].slice(0, 8));
    } catch (error) {
      if (!(error instanceof DemoError)) throw error;
      await bot.sendText('Не удалось остановить задачу: ' + error.code);
    }
    return;
  }
  let answer = COMMAND.exec(text);
  if (!answer && message.reply_to_message?.message_id !== undefined &&
      CHOICES.includes(text.toLowerCase() as OwnerChoice)) {
    const notification = await prisma.ownerNotification.findFirst({
      where: { messageId: String(message.reply_to_message.message_id), state: 'sent' }
    });
    if (notification) answer = ['', notification.clarificationId, text.toLowerCase()] as RegExpExecArray;
  }
  if (answer) {
    try {
      await workflow.answerQuestion(answer[1], answer[2].toLowerCase() as OwnerChoice);
      await bot.sendText('Ответ принят: ' + answer[2].toLowerCase());
    } catch (error) {
      if (!(error instanceof DemoError)) throw error;
      await bot.sendText('Не удалось принять ответ: ' + error.code);
    }
  }
}

/** Poll sequentially, storing the offset only after each processed update. Run one poller. */
export async function pollOwnerUpdates(prisma: PrismaClient, bot: TelegramBotClient): Promise<number> {
  const row = await prisma.telegramPollingCursor.findUnique({ where: { id: 1 } });
  const offset = Number(row?.lastUpdateId ?? 0n) + 1;
  const updates = await bot.getUpdates(offset);
  let processed = 0;
  for (const update of updates) {
    if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) continue;
    await handleOwnerUpdate(prisma, bot, update);
    await prisma.telegramPollingCursor.upsert({
      where: { id: 1 },
      create: { id: 1, lastUpdateId: BigInt(update.update_id) },
      update: { lastUpdateId: BigInt(update.update_id) }
    });
    processed++;
  }
  return processed;
}

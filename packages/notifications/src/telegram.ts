import type { PrismaClient } from '@prisma/client';
import { DemoError, type OwnerChoice } from '../../core/src/demo.ts';
import { PrismaDemoTaskService } from '../../storage/src/prisma.ts';
import { DurableOrchestrator } from '../../storage/src/orchestrator.ts';
import { answerWorkflowOwnerQuestion, type OwnerIdentity } from '../../storage/src/owner-questions.ts';
import { decideWorkflowApproval } from '../../storage/src/approvals.ts';

const CHOICES: readonly OwnerChoice[] = ['cheapest', 'fastest', 'defer'];
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ANSWER = new RegExp('^q:(' + UUID + '):(cheapest|fastest|defer)$');
const COMMAND = new RegExp('^/answer\\s+(' + UUID + ')\\s+(cheapest|fastest|defer)(?:\\s|$)', 'i');
const STOP = new RegExp('^/stop\\s+(' + UUID + ')\\s*$', 'i');
const PAUSE = new RegExp('^/pause\\s+(' + UUID + ')\\s*$', 'i');
const RESUME = new RegExp('^/resume\\s+(' + UUID + ')\\s*$', 'i');
const OWNER_REPLY = new RegExp('^/reply\\s+(' + UUID + ')\\s+([\\s\\S]+)$', 'i');
const APPROVE_COMMAND = new RegExp('^/approve\\s+(' + UUID + ')\\s*$', 'i');
const DENY_COMMAND = new RegExp('^/deny\\s+(' + UUID + ')\\s*$', 'i');
const APPROVAL_CALLBACK = new RegExp('^ap:(' + UUID + '):(yes|no)$', 'i');

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
  async sendApproval(approval: {
    id: string; workflowId: string; actionType: string; recipientRef: string;
    summary: string; amountMinor: number | null; currency: string | null;
    expiresAt: Date;
  }): Promise<string> {
    // Only synthetic mock fixture approvals are sent by this iteration.
    const amount = approval.amountMinor === null ? 'сумма не требуется' :
      approval.amountMinor + ' минорных единиц ' + approval.currency;
    const result = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: this.ownerChatId,
      text: '🤖 Integron · ТЕСТОВОЕ согласование (без реального действия)' +
        '\nЗадача #' + approval.workflowId.slice(0, 8) +
        '\nДействие: ' + approval.actionType + ' · адресат: ' + approval.recipientRef +
        '\nОписание: ' + approval.summary + '\nСумма: ' + amount +
        '\nДействует до: ' + approval.expiresAt.toISOString() +
        '\nApproval: ' + approval.id +
        '\nПодтверждение разрешает только однократную офлайн-симуляцию.',
      reply_markup: { inline_keyboard: [
        [{ text: '✅ Разрешить демо', callback_data: 'ap:' + approval.id + ':yes' }],
        [{ text: '⛔ Отклонить', callback_data: 'ap:' + approval.id + ':no' }]
      ] }
    });
    return String(result.message_id);
  }
  async sendWorkflowQuestion(questionId: string, workflowId: string, prompt: string): Promise<string> {
    const result = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: this.ownerChatId,
      text: '🤖 Integron · уточнение по поручению #' + workflowId.slice(0, 8) +
        '\n\n' + prompt + '\n\nВопрос: ' + questionId +
        '\nОтветь reply на это сообщение или /reply ' + questionId + ' <текст>.'
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

/**
 * Separate durable outbox for workflow free-text owner review.
 * No provider send is retried after a potentially accepted network request.
 */
export async function flushWorkflowOwnerOutbox(
  prisma: PrismaClient, bot: TelegramBotClient, limit = 10
): Promise<number> {
  await prisma.workflowOwnerNotification.updateMany({
    where: { state: 'sending', leasedUntil: { lt: new Date() } },
    data: { state: 'unknown', leasedUntil: null,
      lastError: 'Owner delivery outcome unknown after interrupted attempt' }
  });
  const candidates = await prisma.workflowOwnerNotification.findMany({
    where: { state: 'queued' },
    include: { question: { include: { workflow: {
      select: { state: true, step: true }
    } } } },
    orderBy: { createdAt: 'asc' }, take: limit
  });
  let sent = 0;
  for (const item of candidates) {
    const q = item.question;
    if (q.workflow.state === 'paused') continue; // preserve until resume
    if (q.state !== 'pending' || q.expiresAt <= new Date() ||
        q.ownerUserId !== bot.ownerUserId || q.ownerChatId !== bot.ownerChatId ||
        q.workflow.state !== 'waiting_owner' || q.workflow.step !== 'await_conflict_review') {
      await prisma.workflowOwnerNotification.updateMany({
        where: { id: item.id, state: 'queued' }, data: { state: 'cancelled' }
      });
      continue;
    }
    const claimed = await prisma.workflowOwnerNotification.updateMany({
      where: { id: item.id, state: 'queued' },
      data: { state: 'sending', attempts: { increment: 1 },
        leasedUntil: new Date(Date.now() + 35_000) }
    });
    if (!claimed.count) continue;
    try {
      const current = await prisma.workflowOwnerQuestion.findUnique({
        where: { id: q.id }, include: { workflow: {
          select: { state: true, step: true }
        } }
      });
      if (current?.workflow.state === 'paused') {
        await prisma.workflowOwnerNotification.updateMany({
          where: { id: item.id, state: 'sending' },
          data: { state: 'queued', leasedUntil: null }
        });
        continue;
      }
      if (!current || current.state !== 'pending' || current.expiresAt <= new Date() ||
          current.workflow.state !== 'waiting_owner' ||
          current.workflow.step !== 'await_conflict_review' ||
          current.ownerUserId !== bot.ownerUserId ||
          current.ownerChatId !== bot.ownerChatId) {
        await prisma.workflowOwnerNotification.updateMany({
          where: { id: item.id, state: 'sending' },
          data: { state: 'cancelled', leasedUntil: null }
        });
        continue;
      }
      const messageId = await bot.sendWorkflowQuestion(current.id, current.workflowId, current.prompt);
      await prisma.workflowOwnerNotification.updateMany({
        where: { id: item.id, state: 'sending' },
        data: { state: 'sent', messageId, leasedUntil: null }
      });
      sent++;
    } catch (error) {
      const definite = error instanceof TelegramApiError;
      await prisma.workflowOwnerNotification.updateMany({
        where: { id: item.id, state: 'sending' },
        data: { state: definite ? 'failed' : 'unknown', leasedUntil: null,
          lastError: definite ? 'Telegram rejected owner question' :
            'Owner question delivery result unknown' }
      });
    }
  }
  return sent;
}

/** Approval notifications are separate from free-text questions and demo choices.
 * Uncertain Telegram sends become UNKNOWN, never automatically retried.
 */
export async function flushWorkflowApprovalOutbox(
  prisma: PrismaClient, bot: TelegramBotClient, limit = 10
): Promise<number> {
  await prisma.workflowApprovalNotification.updateMany({
    where: { state: 'sending', leasedUntil: { lt: new Date() } },
    data: { state: 'unknown', leasedUntil: null,
      lastError: 'Interrupted approval notice: delivery outcome unknown' }
  });
  const items = await prisma.workflowApprovalNotification.findMany({
    where: { state: 'queued' },
    include: { approval: { include: {
      workflow: { select: { state: true, transport: true } }
    } } },
    orderBy: { createdAt: 'asc' }, take: limit
  });
  let sent = 0;
  for (const item of items) {
    const a = item.approval;
    if (a.workflow.state === 'paused') continue;
    if (a.state !== 'pending' || a.expiresAt <= new Date() ||
        a.mode !== 'simulation_only' || a.workflow.transport !== 'mock' ||
        !['queued', 'running', 'waiting_owner', 'waiting_external'].includes(a.workflow.state) ||
        a.ownerUserId !== bot.ownerUserId || a.ownerChatId !== bot.ownerChatId) {
      await prisma.workflowApprovalNotification.updateMany({
        where: { id: item.id, state: 'queued' }, data: { state: 'cancelled' }
      });
      continue;
    }
    const claim = await prisma.workflowApprovalNotification.updateMany({
      where: { id: item.id, state: 'queued' },
      data: { state: 'sending', attempts: { increment: 1 },
        leasedUntil: new Date(Date.now() + 35_000) }
    });
    if (!claim.count) continue;
    try {
      const current = await prisma.workflowApproval.findUnique({
        where: { id: a.id }, include: {
          workflow: { select: { state: true, transport: true } }
        }
      });
      if (current?.workflow.state === 'paused') {
        await prisma.workflowApprovalNotification.updateMany({
          where: { id: item.id, state: 'sending' },
          data: { state: 'queued', attempts: { decrement: 1 }, leasedUntil: null }
        });
        continue;
      }
      if (!current || current.state !== 'pending' || current.expiresAt <= new Date() ||
          current.mode !== 'simulation_only' || current.workflow.transport !== 'mock' ||
          !['queued', 'running', 'waiting_owner', 'waiting_external'].includes(current.workflow.state) ||
          current.ownerUserId !== bot.ownerUserId || current.ownerChatId !== bot.ownerChatId) {
        await prisma.workflowApprovalNotification.updateMany({
          where: { id: item.id, state: 'sending' },
          data: { state: 'cancelled', leasedUntil: null }
        });
        continue;
      }
      const messageId = await bot.sendApproval(current);
      await prisma.workflowApprovalNotification.updateMany({
        where: { id: item.id, state: 'sending' },
        data: { state: 'sent', messageId, leasedUntil: null }
      });
      sent++;
    } catch (error) {
      const definite = error instanceof TelegramApiError;
      await prisma.workflowApprovalNotification.updateMany({
        where: { id: item.id, state: 'sending' },
        data: { state: definite ? 'failed' : 'unknown', leasedUntil: null,
          lastError: definite ? 'Telegram rejected approval notice' :
            'Approval notice delivery outcome unknown' }
      });
    }
  }
  return sent;
}

function isOwner(bot: TelegramBotClient, userId: number | undefined, chatId: number | undefined): boolean {
  return userId !== undefined && chatId !== undefined &&
    String(userId) === bot.ownerUserId && String(chatId) === bot.ownerChatId;
}

export async function handleOwnerUpdate(
  prisma: PrismaClient, bot: TelegramBotClient, update: TelegramUpdate
): Promise<void> {
  const workflow = new PrismaDemoTaskService(prisma);
  const orchestrator = new DurableOrchestrator(prisma);
  const callback = update.callback_query;
  if (callback) {
    if (!isOwner(bot, callback.from.id, callback.message?.chat.id)) return;
    const approvalMatch = APPROVAL_CALLBACK.exec(callback.data ?? '');
    if (approvalMatch) {
      // A forwarded/old button is not enough: it must belong to the stored
      // notification with the same ID, original message and verified owner.
      const notice = await prisma.workflowApprovalNotification.findUnique({
        where: { approvalId: approvalMatch[1] }, include: { approval: true }
      });
      if (!notice || notice.state !== 'sent' ||
          notice.messageId !== String(callback.message?.message_id) ||
          notice.approval.ownerUserId !== bot.ownerUserId ||
          notice.approval.ownerChatId !== bot.ownerChatId) {
        await bot.acknowledge(callback.id, 'Неизвестное или неподтверждённое уведомление');
        return;
      }
      try {
        await decideWorkflowApproval(prisma, approvalMatch[1],
          approvalMatch[2] === 'yes' ? 'approve' : 'deny',
          { userId: bot.ownerUserId, chatId: bot.ownerChatId });
        await bot.acknowledge(callback.id, 'Решение сохранено (только демо)');
      } catch (error) {
        if (!(error instanceof DemoError)) throw error;
        await bot.acknowledge(callback.id, 'Не удалось: ' + error.code);
      }
      return;
    }
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
    await bot.sendText('Integron: /status; /answer <questionId> cheapest|fastest|defer; /reply <questionId> <текст>; /approve <approvalId>; /deny <approvalId>; /pause <workflowId>; /resume <workflowId>; /stop <workflowId>. Все подтверждения только для симуляции.');
    return;
  }
  if (/^\/status(?:\s|$)/.test(text)) {
    const active = await prisma.ownerClarification.findMany({
      where: { state: 'pending', expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'asc' }, take: 5
    });
    const runs = await prisma.workflowRun.findMany({
      where: { state: { in: ['queued', 'running', 'waiting_owner', 'waiting_external', 'paused'] } },
      select: { id: true, state: true, step: true },
      orderBy: { createdAt: 'desc' }, take: 5
    });
    const ownerQuestions = await prisma.workflowOwnerQuestion.findMany({
      where: { state: 'pending', expiresAt: { gt: new Date() },
        ownerUserId: bot.ownerUserId, ownerChatId: bot.ownerChatId },
      orderBy: { createdAt: 'asc' }, take: 5
    });
    const pendingApprovals = await prisma.workflowApproval.findMany({
      where: { state: 'pending', expiresAt: { gt: new Date() },
        ownerUserId: bot.ownerUserId, ownerChatId: bot.ownerChatId },
      orderBy: { createdAt: 'asc' }, take: 5
    });
    await bot.sendText([
      pendingApprovals.length ? 'Тестовые согласования:\n' +
        pendingApprovals.map(a => a.id + ' · ' + a.actionType + ' · ' + a.recipientRef).join('\n')
        : 'Нет ожидающих согласований.',
      ownerQuestions.length ? 'Свободные вопросы:\n' +
        ownerQuestions.map(q => q.id + ' (поручение ' + q.workflowId.slice(0, 8) + ')').join('\n')
        : 'Нет новых свободных вопросов.',
      active.length ? 'Ожидают ответа:\n' +
        active.map(q => q.id + ' (задача ' + q.taskId.slice(0, 8) + ')').join('\n')
        : 'Нет ожидающих вопросов.',
      runs.length ? 'Активные поручения:\n' +
        runs.map(r => r.id + ' · ' + r.state + '/' + r.step).join('\n')
        : 'Нет активных поручений.'
    ].join('\n\n'));
    return;
  }
  const pause = PAUSE.exec(text);
  const resume = RESUME.exec(text);
  if (pause || resume) {
    try {
      const id = (pause ?? resume)![1];
      const run = pause ? await orchestrator.pause(id) : await orchestrator.resume(id);
      await bot.sendText('Поручение ' + id.slice(0, 8) + ': ' + run.state);
    } catch (error) {
      if (!(error instanceof DemoError)) throw error;
      await bot.sendText('Не удалось изменить поручение: ' + error.code);
    }
    return;
  }
  const stop = STOP.exec(text);
  if (stop) {
    try {
      const run = await prisma.workflowRun.findUnique({ where: { id: stop[1] }, select: { id: true } });
      // A workflow's mock task shares its UUID; stopping only the demo task
      // would leave a workflow or external outbox active.
      if (run) await orchestrator.stop(stop[1]);
      else await workflow.stop(stop[1]);
      await bot.sendText('Задача остановлена: ' + stop[1].slice(0, 8));
    } catch (error) {
      if (!(error instanceof DemoError)) throw error;
      await bot.sendText('Не удалось остановить задачу: ' + error.code);
    }
    return;
  }
  // Only a verified owner and an exact question UUID or reply-to message may
  // resolve free-text questions. Never infer "last active question".
  const ownerIdentity: OwnerIdentity = { userId: bot.ownerUserId, chatId: bot.ownerChatId };
  const approve = APPROVE_COMMAND.exec(text);
  const deny = DENY_COMMAND.exec(text);
  if (approve || deny) {
    try {
      const id = (approve ?? deny)![1];
      await decideWorkflowApproval(prisma, id, approve ? 'approve' : 'deny',
        ownerIdentity);
      await bot.sendText('Решение сохранено для ' + id.slice(0, 8) +
        ' (симуляция, без реального действия)');
    } catch (error) {
      if (!(error instanceof DemoError)) throw error;
      await bot.sendText('Не удалось сохранить решение: ' + error.code);
    }
    return;
  }
  const freeText = OWNER_REPLY.exec(text);
  if (freeText) {
    try {
      await answerWorkflowOwnerQuestion(prisma, freeText[1], freeText[2], 'telegram', ownerIdentity);
      await bot.sendText('Ответ сохранён для вопроса ' + freeText[1].slice(0, 8));
    } catch (error) {
      if (!(error instanceof DemoError)) throw error;
      await bot.sendText('Не удалось принять ответ: ' + error.code);
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
    return;
  }
  if (message.reply_to_message?.message_id !== undefined && text &&
      !text.startsWith('/')) {
    const notification = await prisma.workflowOwnerNotification.findFirst({
      where: { messageId: String(message.reply_to_message.message_id), state: 'sent',
        question: { ownerUserId: bot.ownerUserId, ownerChatId: bot.ownerChatId } },
      select: { questionId: true }
    });
    if (!notification) return;
    try {
      await answerWorkflowOwnerQuestion(prisma, notification.questionId,
        text, 'telegram', ownerIdentity);
      await bot.sendText('Ответ сохранён для вопроса ' + notification.questionId.slice(0, 8));
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

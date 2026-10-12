import type { PrismaClient } from '@prisma/client';
import { DemoError } from '../../core/src/demo.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface OwnerIdentity {
  userId: string;
  chatId: string;
}
export function readOwnerIdentity(env: Record<string, string | undefined>): OwnerIdentity | undefined {
  const userId = env.OWNER_TELEGRAM_USER_ID;
  const chatId = env.OWNER_TELEGRAM_CHAT_ID;
  if (!userId && !chatId) return undefined; // local web inbox still available
  if (!userId || !chatId || !/^[0-9]+$/.test(userId) ||
      !/^-?[0-9]+$/.test(chatId)) {
    throw new Error('Invalid OWNER_TELEGRAM_USER_ID / OWNER_TELEGRAM_CHAT_ID pairing');
  }
  return { userId, chatId };
}

export function validateOwnerText(value: unknown): string {
  if (typeof value !== 'string') throw new DemoError(400, 'INVALID_OWNER_TEXT', 'Нужен текстовый ответ');
  const answer = value.replace(/\r\n/g, '\n').trim();
  if (answer.length < 2 || answer.length > 500 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(answer)) {
    throw new DemoError(400, 'INVALID_OWNER_TEXT', 'Ответ: от 2 до 500 символов, без управляющих символов');
  }
  return answer;
}

/**
 * Safe textual feedback, not an approval or outbound instruction.
 * Only a verified bot owner or the loopback-only web inbox may answer.
 * The workflow itself later consumes the answer on its own lease.
 */
export async function answerWorkflowOwnerQuestion(
  db: PrismaClient,
  questionId: string,
  text: unknown,
  via: 'telegram' | 'local_web',
  identity?: OwnerIdentity,
  expectedWorkflowId?: string
) {
  if (!UUID.test(questionId)) throw new DemoError(404, 'QUESTION_NOT_FOUND', 'Вопрос не найден');
  const answer = validateOwnerText(text);
  if (via === 'telegram' && !identity) {
    throw new DemoError(403, 'INVALID_OWNER', 'Владелец не подтверждён');
  }
  const now = new Date();
  return db.$transaction(async tx => {
    const q = await tx.workflowOwnerQuestion.findUnique({ where: { id: questionId } });
    if (!q || (expectedWorkflowId && q.workflowId !== expectedWorkflowId)) {
      throw new DemoError(404, 'QUESTION_NOT_FOUND', 'Вопрос не найден для этого поручения');
    }
    if (via === 'telegram' && (q.ownerUserId !== identity!.userId ||
      q.ownerChatId !== identity!.chatId)) {
      throw new DemoError(403, 'INVALID_OWNER', 'Вопрос адресован другому владельцу');
    }
    if (q.state === 'answered' && q.answer === answer) return q; // replay safe
    if (q.state !== 'pending' || q.expiresAt <= now) {
      throw new DemoError(409, 'QUESTION_CLOSED', 'Вопрос закрыт или срок ответа истёк');
    }
    const workflow = await tx.workflowRun.findUnique({
      where: { id: q.workflowId }, select: { state: true, step: true, pausedFrom: true }
    });
    if (!workflow || workflow.step !== 'await_conflict_review' ||
      !(workflow.state === 'waiting_owner' ||
        (workflow.state === 'paused' && workflow.pausedFrom === 'waiting_owner'))) {
      throw new DemoError(409, 'QUESTION_CLOSED', 'Поручение больше не ждёт этот ответ');
    }
    const claimed = await tx.workflowOwnerQuestion.updateMany({
      where: { id: q.id, state: 'pending', expiresAt: { gt: now } },
      data: { state: 'answered', answer, answeredVia: via, answeredAt: now }
    });
    if (!claimed.count) {
      const latest = await tx.workflowOwnerQuestion.findUniqueOrThrow({ where: { id: q.id } });
      if (latest.state === 'answered' && latest.answer === answer) return latest;
      throw new DemoError(409, 'QUESTION_CLOSED', 'Вопрос уже обработан');
    }
    await tx.workflowOwnerNotification.updateMany({
      where: { questionId: q.id, state: 'queued' }, data: { state: 'cancelled' }
    });
    await tx.workflowRun.updateMany({
      where: { id: q.workflowId, state: 'waiting_owner', step: 'await_conflict_review' },
      data: { availableAt: now }
    });
    await tx.workflowEvent.create({
      data: { workflowId: q.workflowId, kind: 'owner_text_answered',
        metadata: { questionId: q.id, via } } // Do not put answer text in event metadata.
    });
    return tx.workflowOwnerQuestion.findUniqueOrThrow({ where: { id: q.id } });
  });
}

export async function expireWorkflowOwnerQuestions(db: PrismaClient, limit = 50): Promise<number> {
  const expired = await db.workflowOwnerQuestion.findMany({
    where: { state: 'pending', expiresAt: { lte: new Date() } },
    orderBy: { expiresAt: 'asc' }, take: limit, select: { id: true, workflowId: true }
  });
  let count = 0;
  for (const question of expired) {
    await db.$transaction(async tx => {
      const claimed = await tx.workflowOwnerQuestion.updateMany({
        where: { id: question.id, state: 'pending', expiresAt: { lte: new Date() } },
        data: { state: 'expired' }
      });
      if (!claimed.count) return;
      await tx.workflowOwnerNotification.updateMany({
        where: { questionId: question.id, state: 'queued' },
        data: { state: 'cancelled' }
      });
      await tx.workflowRun.updateMany({
        where: { id: question.workflowId, state: 'waiting_owner', step: 'await_conflict_review' },
        data: { availableAt: new Date() }
      });
      await tx.workflowEvent.create({
        data: { workflowId: question.workflowId, kind: 'owner_question_expired',
          metadata: { questionId: question.id } }
      });
      count++;
    });
  }
  return count;
}

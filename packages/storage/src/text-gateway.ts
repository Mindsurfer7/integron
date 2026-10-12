import type { PrismaClient } from '@prisma/client';
import { authorizeTestText, authorizeWhatsAppTestText, type TestTextPolicy, type TextTransportAdapter, type IncomingText } from '../../transports/src/contracts.ts';
import { TelegramTestRejected } from '../../transports/src/telegram-test.ts';

const CHANNEL = 'telegram_bot_test';
export const WHATSAPP_ROUTE = { channel: 'whatsapp_user_test', transport: 'whatsapp_user_test' } as const;
export const TDLIB_ROUTE = { channel: 'telegram_user_test', transport: 'telegram_user_test' } as const;
const BOT_ROUTE = { channel: CHANNEL, transport: 'telegram_test' } as const;
type Route = { channel: string; transport: string };

/** A single sender for opted-in tests. Atomic claims prevent competing sends;
 * an interrupted send is UNKNOWN and never automatically retried. */
export async function flushTestTextOutbox(
  db: PrismaClient, transport: Pick<TextTransportAdapter, 'send'>, policy: TestTextPolicy,
  limit = 2, route: Route = BOT_ROUTE
): Promise<number> {
  if (!policy.enabled) return 0;
  await db.textDelivery.updateMany({
    where: { channel: route.channel, state: 'sending', leasedUntil: { lt: new Date() } },
    data: { state: 'unknown', leasedUntil: null, lastError: 'Interrupted send; delivery outcome unknown' }
  });
  const queued = await db.textDelivery.findMany({
    where: { channel: route.channel, state: 'queued' }, orderBy: { createdAt: 'asc' }, take: limit, include: { workflow: true }
  });
  let sent = 0;
  for (const row of queued) {
    const valid = policy.allowedChatIds.has(row.chatId) &&
      row.channel === route.channel && row.workflow.transport === route.transport &&
      row.workflow.targetChatId === row.chatId &&
      row.workflow.state === 'waiting_external' && row.workflow.step === 'await_external' &&
      row.expiresAt > new Date();
    if (!valid) {
      await db.textDelivery.updateMany({
        where: { id: row.id, state: 'queued' }, data: { state: 'cancelled' }
      });
      continue;
    }
    // Per-test-chat pacing: never send another inquiry to this recipient
    // within a minute. Only 1-2 explicitly allowlisted private chats exist.
    const recent = await db.textDelivery.findFirst({
      where: { id: { not: row.id }, channel: route.channel, chatId: row.chatId,
        state: { in: ['sending', 'sent', 'unknown', 'failed'] },
        updatedAt: { gte: new Date(Date.now() - 60_000) } }
    });
    if (recent) continue;
    const locked = await db.textDelivery.updateMany({
      where: { id: row.id, state: 'queued' },
      data: { state: 'sending', attempts: { increment: 1 },
        leasedUntil: new Date(Date.now() + 35_000) }
    });
    if (!locked.count) continue;
    try {
      // Re-check stop and allowlist after claim; stop racing actual network I/O
      // cannot revoke an already-dispatched Telegram request.
      if (route.channel === WHATSAPP_ROUTE.channel) authorizeWhatsAppTestText(policy, row.chatId);
      else authorizeTestText(policy, row.chatId);
      const state = await db.workflowRun.findUnique({ where: { id: row.workflowId } });
      if (state?.state !== 'waiting_external' || state?.step !== 'await_external') {
        await db.textDelivery.updateMany({
          where: { id: row.id, state: 'sending' }, data: { state: 'cancelled', leasedUntil: null }
        });
        continue;
      }
      const receipt = await transport.send({ workflowId: row.workflowId, chatId: row.chatId, body: row.body });
      await db.$transaction(async tx => {
        const saved = await tx.textDelivery.updateMany({
          where: { id: row.id, state: 'sending' },
          data: { state: 'sent', providerId: receipt.providerMessageId, leasedUntil: null }
        });
        if (saved.count) {
          await tx.textMessage.create({
            data: { workflowId: row.workflowId, channel: route.channel, chatId: row.chatId,
              direction: 'out', providerMessageId: receipt.providerMessageId, body: row.body }
          });
          await tx.workflowEvent.create({ data: { workflowId: row.workflowId, kind: 'text_sent' } });
        }
      });
      sent++;
    } catch (e) {
      await db.textDelivery.updateMany({
        where: { id: row.id, state: 'sending' },
        data: { state: (e instanceof TelegramTestRejected || isDefinite(e)) ? 'failed' : 'unknown',
          leasedUntil: null, lastError: (e instanceof TelegramTestRejected || isDefinite(e)) ? 'Provider rejected send' : 'Send result unknown' }
      });
    }
  }
  return sent;
}

/** Fail-closed correlation: private chat, same sender ID, exact reply-to bot
 * message ID, same workflow, active nonexpired deadline, and allowlisted chat.
 * Neither free text nor forward may create additional outbound actions. */
export async function handleTestText(
  db: PrismaClient, policy: TestTextPolicy, incoming: IncomingText, route: Route = BOT_ROUTE
): Promise<boolean> {
  if (!policy.enabled || incoming.chatType !== 'private' ||
      incoming.senderId !== incoming.chatId ||
      !policy.allowedChatIds.has(incoming.chatId) ||
      !incoming.replyToProviderId || !incoming.body.trim() ||
      incoming.body.length > 2000) return false;
  const delivery = await db.textDelivery.findFirst({
    where: { channel: route.channel, chatId: incoming.chatId,
      providerId: incoming.replyToProviderId, state: 'sent' }
  });
  if (!delivery || delivery.expiresAt <= new Date()) return false;
  return db.$transaction(async tx => {
    const changed = await tx.workflowRun.updateMany({
      where: { id: delivery.workflowId, transport: route.transport,
        targetChatId: incoming.chatId, state: 'waiting_external', step: 'await_external' },
      data: { state: 'running', step: 'process_external', availableAt: new Date() }
    });
    if (!changed.count) return false;
    await tx.textMessage.create({
      data: { workflowId: delivery.workflowId, channel: route.channel, chatId: incoming.chatId,
        direction: 'in', providerMessageId: incoming.providerMessageId,
        replyToProviderId: incoming.replyToProviderId, body: incoming.body.trim() }
    });
    await tx.workflowEvent.create({ data: { workflowId: delivery.workflowId, kind: 'text_reply_received' } });
    return true;
  });
}

/** Single getUpdates poller per agent bot. DB offset moves only after the event
 * is handled; if the process crashes before offset commit, replay is harmless. */
export async function pollTestText(
  db: PrismaClient, transport: TextTransportAdapter, policy: TestTextPolicy
): Promise<number> {
  if (!policy.enabled) return 0;
  const cursor = await db.agentTelegramCursor.findUnique({ where: { id: 1 } });
  const next = Number(cursor?.lastUpdateId ?? 0n) + 1;
  const updates = await transport.receive(next);
  let processed = 0;
  for (const update of updates) {
    if (!Number.isSafeInteger(update.updateId) || update.updateId < next) continue;
    if (update.incoming) await handleTestText(db, policy, update.incoming);
    await db.agentTelegramCursor.upsert({
      where: { id: 1 },
      create: { id: 1, lastUpdateId: BigInt(update.updateId) },
      update: { lastUpdateId: BigInt(update.updateId) }
    });
    processed++;
  }
  return processed;
}


function isDefinite(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'definite' in error && error.definite === true);
}

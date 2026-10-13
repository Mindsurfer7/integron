import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { DemoError } from '../../core/src/demo.ts';
import type { OwnerIdentity } from './owner-questions.ts';

export type ApprovalAction = 'booking' | 'payment' | 'data_disclosure';
export interface ApprovalIntent {
  actionType: ApprovalAction;
  recipientRef: string;
  summary: string;
  amountMinor?: number | null;
  currency?: string | null;
}
export type OwnerApprovalDecision = 'approve' | 'deny';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIVE = ['queued', 'running', 'waiting_owner', 'waiting_external'];
const TERMINAL = ['completed', 'failed', 'cancelled'];

/**
 * An approval is bound to ONE specific intent. No model or owner answer can
 * mutate the bound action fields, and consuming only records a mock simulation.
 * This is deliberately NOT a paid-action authorization or live dispatch gate.
 */
export function normalizeApprovalIntent(raw: ApprovalIntent): Required<ApprovalIntent> {
  if (!raw || !['booking', 'payment', 'data_disclosure'].includes(raw.actionType) ||
      typeof raw.recipientRef !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{3,90}$/.test(raw.recipientRef) ||
      typeof raw.summary !== 'string' || raw.summary.trim().length < 8 ||
      raw.summary.trim().length > 180 || /[\u0000-\u001f\u007f]/.test(raw.summary)) {
    throw new DemoError(400, 'INVALID_APPROVAL_INTENT', 'Некорректные параметры подтверждения');
  }
  const amount = raw.amountMinor ?? null;
  const currency = raw.currency ?? null;
  if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0 || amount > 100_000_000)) {
    throw new DemoError(400, 'INVALID_APPROVAL_AMOUNT', 'Некорректная сумма');
  }
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
    throw new DemoError(400, 'INVALID_APPROVAL_CURRENCY', 'Некорректная валюта');
  }
  if (raw.actionType === 'payment' && (amount === null || amount === 0 || currency === null)) {
    throw new DemoError(400, 'INVALID_APPROVAL_AMOUNT', 'Для платежа нужны сумма и валюта');
  }
  if (raw.actionType !== 'payment' && (amount !== null || currency !== null)) {
    throw new DemoError(400, 'INVALID_APPROVAL_AMOUNT', 'Сумма применима только к платежам');
  }
  return { actionType: raw.actionType, recipientRef: raw.recipientRef,
    summary: raw.summary.trim(), amountMinor: amount, currency };
}

export function approvalIntentDigest(raw: ApprovalIntent): string {
  const intent = normalizeApprovalIntent(raw);
  return createHash('sha256').update(JSON.stringify({
    mode: 'simulation_only', actionType: intent.actionType,
    recipientRef: intent.recipientRef, summary: intent.summary,
    amountMinor: intent.amountMinor, currency: intent.currency
  })).digest('hex');
}

function validateOwner(owner: OwnerIdentity | undefined): OwnerIdentity {
  if (!owner || !/^[0-9]+$/.test(owner.userId) ||
      !/^-?[0-9]+$/.test(owner.chatId)) {
    throw new DemoError(403, 'OWNER_IDENTITY_REQUIRED', 'Требуется проверенный владелец Telegram');
  }
  return owner;
}

/**
 * Internal P1 API: create only for an existing synthetic fixture target in a
 * mock workflow. The public loopback endpoint uses a fixed synthetic intent.
 * An identical request key is idempotent; a changed intent under the same key
 * is never silently granted.
 */
export async function requestMockApproval(
  db: PrismaClient,
  workflowId: string,
  requestKey: string,
  rawIntent: ApprovalIntent,
  ownerIdentity: OwnerIdentity | undefined,
  ttlSeconds = 600
) {
  const owner = validateOwner(ownerIdentity);
  if (!UUID.test(workflowId) || !/^[a-zA-Z0-9_.:-]{3,90}$/.test(requestKey) ||
      !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 900) {
    throw new DemoError(400, 'INVALID_APPROVAL_REQUEST', 'Некорректный запрос разрешения');
  }
  const intent = normalizeApprovalIntent(rawIntent);
  const digest = approvalIntentDigest(intent);
  try {
    return await db.$transaction(async tx => {
      // Serialize request with stop/completion on the parent workflow row.
      const active = await tx.workflowRun.updateMany({
        where: { id: workflowId, transport: 'mock', state: { in: ACTIVE } },
        data: { updatedAt: new Date() }
      });
      if (active.count !== 1) {
        throw new DemoError(409, 'APPROVAL_UNAVAILABLE', 'Только активный mock workflow');
      }
      const existing = await tx.workflowApproval.findUnique({
        where: { workflowId_requestKey: { workflowId, requestKey } }
      });
      if (existing) {
        if (existing.intentDigest !== digest || existing.ownerUserId !== owner.userId ||
            existing.ownerChatId !== owner.chatId) {
          throw new DemoError(409, 'APPROVAL_INTENT_CONFLICT',
            'Повторный ключ не соответствует исходному запросу');
        }
        return existing;
      }
      const target = await tx.workflowTarget.findUnique({
        where: { workflowId_sourceKey: { workflowId, sourceKey: intent.recipientRef } }
      });
      if (!target || target.origin !== 'mock_fixture' || target.recipientId !== null) {
        throw new DemoError(403, 'APPROVAL_TARGET_FORBIDDEN',
          'Разрешения можно тестировать только для вымышленных организаций');
      }
      const approval = await tx.workflowApproval.create({
        data: { workflowId, requestKey, actionType: intent.actionType,
          recipientRef: intent.recipientRef, summary: intent.summary,
          amountMinor: intent.amountMinor, currency: intent.currency,
          intentDigest: digest, ownerUserId: owner.userId,
          ownerChatId: owner.chatId,
          expiresAt: new Date(Date.now() + ttlSeconds * 1000) }
      });
      await tx.workflowApprovalNotification.create({ data: { approvalId: approval.id } });
      await tx.workflowEvent.create({ data: { workflowId,
        kind: 'approval_requested', metadata: { approvalId: approval.id,
          actionType: approval.actionType, mode: 'simulation_only' } } });
      return approval;
    });
  } catch (error) {
    // Races with another creator may produce a unique constraint violation.
    // Retry only an identical request, never a changed intent/owner.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await db.workflowApproval.findUnique({
        where: { workflowId_requestKey: { workflowId, requestKey } }
      });
      if (existing && existing.intentDigest === digest &&
          existing.ownerUserId === owner.userId && existing.ownerChatId === owner.chatId) {
        return existing;
      }
      throw new DemoError(409, 'APPROVAL_INTENT_CONFLICT', 'Ключ уже занят другим действием');
    }
    throw error;
  }
}

export async function decideWorkflowApproval(
  db: PrismaClient, approvalId: string,
  decision: OwnerApprovalDecision,
  ownerIdentity: OwnerIdentity,
  via: 'telegram' = 'telegram'
) {
  const owner = validateOwner(ownerIdentity);
  if (!UUID.test(approvalId) || !['approve', 'deny'].includes(decision)) {
    throw new DemoError(400, 'INVALID_APPROVAL_DECISION', 'Некорректное решение');
  }
  const targetState = decision === 'approve' ? 'approved' : 'denied';
  return db.$transaction(async tx => {
    const approval = await tx.workflowApproval.findUnique({
      where: { id: approvalId }, include: { workflow: {
        select: { state: true, transport: true }
      } }
    });
    if (!approval) throw new DemoError(404, 'APPROVAL_NOT_FOUND', 'Разрешение не найдено');
    if (approval.ownerUserId !== owner.userId || approval.ownerChatId !== owner.chatId) {
      throw new DemoError(403, 'INVALID_OWNER', 'Разрешение адресовано другому владельцу');
    }
    // Replays are harmless only if the same explicit decision was stored.
    if (approval.state === targetState && approval.decidedAt) return approval;
    if (approval.state !== 'pending' || approval.expiresAt <= new Date() ||
        TERMINAL.includes(approval.workflow.state) ||
        approval.workflow.transport !== 'mock') {
      throw new DemoError(409, 'APPROVAL_CLOSED', 'Разрешение завершено или просрочено');
    }
    const changed = await tx.workflowApproval.updateMany({
      where: { id: approval.id, state: 'pending', expiresAt: { gt: new Date() } },
      data: { state: targetState, decisionVia: via, decidedAt: new Date() }
    });
    if (!changed.count) {
      const latest = await tx.workflowApproval.findUniqueOrThrow({ where: { id: approvalId } });
      if (latest.state === targetState && latest.decidedAt) return latest;
      throw new DemoError(409, 'APPROVAL_CLOSED', 'Разрешение уже обработано');
    }
    await tx.workflowApprovalNotification.updateMany({
      where: { approvalId, state: 'queued' }, data: { state: 'cancelled' }
    });
    await tx.workflowEvent.create({ data: { workflowId: approval.workflowId,
      kind: targetState === 'approved' ? 'approval_granted' : 'approval_denied',
      metadata: { approvalId, mode: 'simulation_only', via } } });
    return tx.workflowApproval.findUniqueOrThrow({ where: { id: approvalId } });
  });
}

/**
 * One-time mock consumption: verifies ALL action fields and the original
 * workflow. This method is intentionally incapable of calling a real provider.
 * A future live executor must have its OWN policy/budget/consent gate.
 */
export async function consumeMockApproval(
  db: PrismaClient, workflowId: string, approvalId: string, rawIntent: ApprovalIntent
) {
  if (!UUID.test(workflowId) || !UUID.test(approvalId)) {
    throw new DemoError(404, 'APPROVAL_NOT_FOUND', 'Разрешение не найдено');
  }
  const digest = approvalIntentDigest(rawIntent);
  return db.$transaction(async tx => {
    const locked = await tx.workflowRun.updateMany({
      where: { id: workflowId, transport: 'mock', state: { in: ACTIVE } },
      data: { updatedAt: new Date() }
    });
    if (!locked.count) throw new DemoError(409, 'APPROVAL_UNAVAILABLE', 'Поручение недоступно');
    const row = await tx.workflowApproval.findUnique({ where: { id: approvalId } });
    if (!row || row.workflowId !== workflowId) {
      throw new DemoError(404, 'APPROVAL_NOT_FOUND', 'Разрешение не найдено');
    }
    if (row.mode !== 'simulation_only' || row.intentDigest !== digest) {
      throw new DemoError(409, 'APPROVAL_INTENT_MISMATCH',
        'Это разрешение выдано на другое действие или сумму');
    }
    if (row.state !== 'approved' || row.expiresAt <= new Date()) {
      throw new DemoError(409, 'APPROVAL_NOT_CONSUMABLE',
        'Нет актуального одноразового разрешения');
    }
    const changed = await tx.workflowApproval.updateMany({
      where: { id: approvalId, state: 'approved', intentDigest: digest,
        expiresAt: { gt: new Date() }, mode: 'simulation_only' },
      data: { state: 'consumed', consumedAt: new Date() }
    });
    if (!changed.count) {
      throw new DemoError(409, 'APPROVAL_NOT_CONSUMABLE', 'Разрешение уже использовано');
    }
    await tx.workflowEvent.create({ data: { workflowId,
      kind: 'approval_mock_consumed', metadata: { approvalId, simulated: true } } });
    return { simulated: true as const, externalActions: 0 as const,
      approval: await tx.workflowApproval.findUniqueOrThrow({ where: { id: approvalId } }) };
  });
}

/** Expiration and workflow termination always fail closed; no external effects. */
export async function expireWorkflowApprovals(db: PrismaClient, limit = 50): Promise<number> {
  const rows = await db.workflowApproval.findMany({
    where: { state: { in: ['pending', 'approved'] },
      OR: [{ expiresAt: { lte: new Date() } },
        { workflow: { state: { in: TERMINAL } } }] },
    select: { id: true, workflowId: true, expiresAt: true, state: true },
    orderBy: { createdAt: 'asc' }, take: limit
  });
  let count = 0;
  for (const row of rows) {
    await db.$transaction(async tx => {
      const terminal = await tx.workflowRun.findUnique({ where: { id: row.workflowId },
        select: { state: true } });
      const expiry = row.expiresAt <= new Date();
      if (!expiry && !terminal) return;
      if (!expiry && terminal && !TERMINAL.includes(terminal.state)) return;
      const changed = await tx.workflowApproval.updateMany({
        where: { id: row.id, state: { in: ['pending', 'approved'] },
          ...(expiry ? { expiresAt: { lte: new Date() } } : {}) },
        data: { state: expiry ? 'expired' : 'cancelled' }
      });
      if (!changed.count) return;
      await tx.workflowApprovalNotification.updateMany({
        where: { approvalId: row.id, state: 'queued' }, data: { state: 'cancelled' }
      });
      await tx.workflowEvent.create({ data: { workflowId: row.workflowId,
        kind: expiry ? 'approval_expired' : 'approval_cancelled',
        metadata: { approvalId: row.id } } });
      count++;
    });
  }
  return count;
}

import { Prisma, type PrismaClient } from '@prisma/client';
import { DemoError } from '../../core/src/demo.ts';
import type { CostCategory } from './budget.ts';

type SpendCategory = CostCategory;
export type SpendIntent = {
  workflowId: string; eventKey: string; category: SpendCategory; maxAmountCents: number;
};
function valid(intent: SpendIntent) {
  if (!/^[0-9a-f-]{36}$/.test(intent.workflowId) ||
      !/^[a-zA-Z0-9_.:/-]{4,120}$/.test(intent.eventKey) ||
      !['llm', 'telephony', 'transport'].includes(intent.category) ||
      !Number.isSafeInteger(intent.maxAmountCents) ||
      intent.maxAmountCents < 1 || intent.maxAmountCents > 10_000_000) {
    throw new DemoError(400, 'INVALID_SPEND_INTENT', 'Некорректный резерв расходов');
  }
}
/** Atomic preflight; UNKNOWN provider outcome must remain reserved. */
export async function reserveWorkflowSpend(db: PrismaClient, intent: SpendIntent) {
  valid(intent);
  try {
    return await db.$transaction(async tx => {
      if (!(await tx.workflowRun.findUnique({ where: { id: intent.workflowId }, select: { id: true } }))) {
        throw new DemoError(404, 'WORKFLOW_NOT_FOUND', 'Поручение не найдено');
      }
      const entry = await tx.workflowCostReservation.create({ data: intent });
      const count = await tx.$executeRaw`
        UPDATE "WorkflowRun" SET "reservedCents" = "reservedCents" + ${intent.maxAmountCents}
        WHERE "id" = ${intent.workflowId}::uuid
          AND "state" NOT IN ('paused', 'cancelled', 'completed', 'failed')
          AND "spentCents" + "reservedCents" + ${intent.maxAmountCents} <= "maxCostCents"
      `;
      if (count !== 1) throw new DemoError(409, 'BUDGET_EXCEEDED',
        'Недостаточно бюджета или поручение остановлено');
      await tx.workflowEvent.create({ data: { workflowId: intent.workflowId,
        kind: 'cost_reserved', metadata: { category: intent.category,
          maxAmountCents: intent.maxAmountCents } } });
      return entry;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await db.workflowCostReservation.findUnique({
        where: { workflowId_eventKey: { workflowId: intent.workflowId, eventKey: intent.eventKey } }
      });
      if (existing) {
        if (existing.maxAmountCents !== intent.maxAmountCents || existing.category !== intent.category) {
          throw new DemoError(409, 'COST_RESERVATION_CONFLICT', 'Другой резерв с таким ключом');
        }
        return existing;
      }
    }
    throw error;
  }
}
/** Settle only after the provider supplies a confirmed amount, including zero. */
export async function settleWorkflowSpend(db: PrismaClient, workflowId: string, eventKey: string,
  actualAmountCents: number) {
  if (!Number.isSafeInteger(actualAmountCents) || actualAmountCents < 0) {
    throw new DemoError(400, 'INVALID_SETTLEMENT', 'Неверная сумма');
  }
  return db.$transaction(async tx => {
    const r = await tx.workflowCostReservation.findUnique({
      where: { workflowId_eventKey: { workflowId, eventKey } }
    });
    if (!r) throw new DemoError(404, 'RESERVATION_NOT_FOUND', 'Резерв не найден');
    if (r.state === 'settled' && r.actualAmountCents === actualAmountCents) return r;
    if (r.state !== 'reserved' || actualAmountCents > r.maxAmountCents) {
      throw new DemoError(409, 'INVALID_SETTLEMENT', 'Невозможное списание');
    }
    const claimed = await tx.workflowCostReservation.updateMany({
      where: { id: r.id, state: 'reserved' },
      data: { state: 'settled', actualAmountCents, settledAt: new Date() }
    });
    if (claimed.count !== 1) throw new DemoError(409, 'CONCURRENT_SETTLEMENT', 'Резерв уже изменён');
    const count = await tx.$executeRaw`
      UPDATE "WorkflowRun"
      SET "reservedCents" = "reservedCents" - ${r.maxAmountCents},
          "spentCents" = "spentCents" + ${actualAmountCents}
      WHERE "id" = ${workflowId}::uuid AND "reservedCents" >= ${r.maxAmountCents}
    `;
    if (count !== 1) throw new DemoError(409, 'BUDGET_INTEGRITY_FAILURE', 'Резерв отсутствует в бюджете');
    if (actualAmountCents > 0) {
      await tx.workflowCostEntry.create({ data: { workflowId, eventKey: 'settled:' + eventKey,
        category: r.category, amountCents: actualAmountCents } });
    }
    await tx.workflowEvent.create({ data: { workflowId, kind: 'cost_settled',
      metadata: { actualAmountCents, reservedAmountCents: r.maxAmountCents, category: r.category } } });
    return (await tx.workflowCostReservation.findUnique({ where: { id: r.id } }))!;
  });
}
/** Only definitely undispatched or provider-verified no-charge actions may release. */
export async function releaseWorkflowSpend(db: PrismaClient, workflowId: string, eventKey: string,
  reason: 'cancelled_before_dispatch' | 'provider_confirmed_no_charge') {
  if (!['cancelled_before_dispatch', 'provider_confirmed_no_charge'].includes(reason)) {
    throw new DemoError(400, 'INVALID_RELEASE_REASON', 'Нет подтверждения');
  }
  return db.$transaction(async tx => {
    const r = await tx.workflowCostReservation.findUnique({
      where: { workflowId_eventKey: { workflowId, eventKey } }
    });
    if (!r) throw new DemoError(404, 'RESERVATION_NOT_FOUND', 'Резерв не найден');
    if (r.state === 'released') return r;
    if (r.state !== 'reserved') throw new DemoError(409, 'RESERVATION_FINAL', 'Резерв закрыт');
    const claimed = await tx.workflowCostReservation.updateMany({
      where: { id: r.id, state: 'reserved' },
      data: { state: 'released', actualAmountCents: 0, settledAt: new Date() }
    });
    if (claimed.count !== 1) throw new DemoError(409, 'CONCURRENT_SETTLEMENT', 'Резерв уже изменён');
    const count = await tx.$executeRaw`
      UPDATE "WorkflowRun" SET "reservedCents" = "reservedCents" - ${r.maxAmountCents}
      WHERE "id" = ${workflowId}::uuid AND "reservedCents" >= ${r.maxAmountCents}
    `;
    if (count !== 1) throw new DemoError(409, 'BUDGET_INTEGRITY_FAILURE', 'Резерв отсутствует');
    await tx.workflowEvent.create({ data: { workflowId, kind: 'cost_released',
      metadata: { category: r.category, amountCents: r.maxAmountCents, reason } } });
    return (await tx.workflowCostReservation.findUnique({ where: { id: r.id } }))!;
  });
}

import { Prisma, type PrismaClient } from '@prisma/client';
import { DemoError } from '../../core/src/demo.ts';

export type CostCategory = 'llm' | 'telephony' | 'transport';
export interface RecordedCost {
  workflowId: string;
  eventKey: string;
  category: CostCategory;
  amountCents: number;
}

/**
 * Record the same external charge only once. One row-level conditional update
 * prevents concurrent workers from exceeding the stored workflow ceiling.
 *
 * Callers must invoke this only for a known, actually incurred metered cost.
 * No API route can add arbitrary usage; this is accounting, not payment approval.
 */
export async function recordWorkflowCost(db: PrismaClient, cost: RecordedCost) {
  if (!/^[0-9a-f-]{36}$/.test(cost.workflowId) ||
      !/^[a-zA-Z0-9_.:/-]{4,160}$/.test(cost.eventKey) ||
      !['llm', 'telephony', 'transport'].includes(cost.category) ||
      !Number.isSafeInteger(cost.amountCents) || cost.amountCents <= 0 ||
      cost.amountCents > 10_000_000) {
    throw new DemoError(400, 'INVALID_COST_EVENT', 'Некорректное событие затрат');
  }
  try {
    return await db.$transaction(async tx => {
      const run = await tx.workflowRun.findUnique({
        where: { id: cost.workflowId }, select: { id: true }
      });
      if (!run) throw new DemoError(404, 'WORKFLOW_NOT_FOUND', 'Поручение не найдено');
      // Reserve the event key transactionally: a duplicate never charges twice.
      const entry = await tx.workflowCostEntry.create({ data: cost });
      const updated = await tx.$executeRaw`
        UPDATE "WorkflowRun" SET "spentCents" = "spentCents" + ${cost.amountCents}
        WHERE "id" = ${cost.workflowId}::uuid
          AND "spentCents" + "reservedCents" + ${cost.amountCents} <= "maxCostCents"
      `;
      if (updated !== 1) {
        throw new DemoError(409, 'BUDGET_EXCEEDED',
          'Лимит расходов поручения превышен; новые платные действия запрещены');
      }
      await tx.workflowEvent.create({
        data: { workflowId: cost.workflowId, kind: 'cost_recorded',
          metadata: { category: cost.category, amountCents: cost.amountCents } }
      });
      return entry;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await db.workflowCostEntry.findUnique({
        where: { workflowId_eventKey: { workflowId: cost.workflowId, eventKey: cost.eventKey } }
      });
      if (existing) {
        if (existing.amountCents !== cost.amountCents || existing.category !== cost.category) {
          throw new DemoError(409, 'COST_EVENT_CONFLICT', 'Повторный ключ затрат с другими данными');
        }
        return existing;
      }
    }
    throw error;
  }
}

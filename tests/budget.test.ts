import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { DemoError } from '../packages/core/src/demo.ts';
import { DurableOrchestrator } from '../packages/storage/src/orchestrator.ts';
import { recordWorkflowCost } from '../packages/storage/src/budget.ts';

test('P1 metered usage is deduped, bounded and recorded with an audit event', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const db = new PrismaClient();
  await db.$connect();
  try {
    await db.workflowRun.deleteMany({});
    const workflow = new DurableOrchestrator(db);
    const first = await workflow.create('Собери стоимость сравнения');
    const item = { workflowId: first.id, eventKey: 'llm:run:001',
      category: 'llm' as const, amountCents: 200 };
    const [a, b] = await Promise.all([
      recordWorkflowCost(db, item), recordWorkflowCost(db, item)
    ]);
    assert.equal(a.id, b.id);
    assert.equal(await db.workflowCostEntry.count({ where: { workflowId: first.id } }), 1);
    assert.equal((await workflow.get(first.id)).spentCents, 200);
    await assert.rejects(
      () => recordWorkflowCost(db, { ...item, amountCents: 150 }),
      (error: unknown) => error instanceof DemoError && error.code === 'COST_EVENT_CONFLICT'
    );
    // Concurrent distinct events compete for the remaining 300 cents.
    const results = await Promise.allSettled([
      recordWorkflowCost(db, { ...item, eventKey: 'llm:run:002', amountCents: 200 }),
      recordWorkflowCost(db, { ...item, eventKey: 'llm:run:003', amountCents: 200 })
    ]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(results.filter(x => x.status === 'rejected' &&
      x.reason instanceof DemoError && x.reason.code === 'BUDGET_EXCEEDED').length, 1);
    const loaded = await workflow.get(first.id);
    assert.equal(loaded.spentCents, 400);
    assert.equal(loaded.maxCostCents, 500);
    assert.equal(loaded.costs.length, 2);
    assert.equal(loaded.events.filter(x => x.kind === 'cost_recorded').length, 2);
    assert.equal(await db.workflowCostEntry.count({ where: { workflowId: first.id } }), 2);
    await assert.rejects(
      () => recordWorkflowCost(db, { ...item, eventKey: 'llm:run:004', amountCents: -1 }),
      (error: unknown) => error instanceof DemoError && error.code === 'INVALID_COST_EVENT'
    );
    const second = await workflow.create('Вторая независимая задача');
    assert.equal((await workflow.get(second.id)).spentCents, 0);
  } finally {
    await db.workflowRun.deleteMany({});
    await db.$disconnect();
  }
});

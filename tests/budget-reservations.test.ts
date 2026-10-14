import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { DurableOrchestrator } from '../packages/storage/src/orchestrator.ts';
import { DemoError } from '../packages/core/src/demo.ts';
import { recordWorkflowCost } from '../packages/storage/src/budget.ts';
import { reserveWorkflowSpend, settleWorkflowSpend, releaseWorkflowSpend } from '../packages/storage/src/budget-reservations.ts';

test('atomic preflight reservations, settlement, releases and unknown outcomes', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const db = new PrismaClient();
  await db.$connect();
  try {
    const workflow = await new DurableOrchestrator(db).create('Узнай цену телефонного разговора');
    const base = { workflowId: workflow.id, category: 'telephony' as const,
      eventKey: 'call:001', maxAmountCents: 350 };
    const first = await reserveWorkflowSpend(db, base);
    const repeated = await reserveWorkflowSpend(db, base);
    assert.equal(first.id, repeated.id);
    assert.equal((await db.workflowRun.findUniqueOrThrow({ where: { id: workflow.id } })).reservedCents, 350);
    await assert.rejects(() => reserveWorkflowSpend(db, { ...base, maxAmountCents: 300 }),
      (e: unknown) => e instanceof DemoError && e.code === 'COST_RESERVATION_CONFLICT');
    await assert.rejects(() => reserveWorkflowSpend(db, { ...base, eventKey: 'call:002', maxAmountCents: 200 }),
      (e: unknown) => e instanceof DemoError && e.code === 'BUDGET_EXCEEDED');
    await assert.rejects(() => recordWorkflowCost(db, { workflowId: workflow.id,
      eventKey: 'llm:001', category: 'llm', amountCents: 160 }),
      (e: unknown) => e instanceof DemoError && e.code === 'BUDGET_EXCEEDED');
    await assert.rejects(() => settleWorkflowSpend(db, workflow.id, base.eventKey, 351),
      (e: unknown) => e instanceof DemoError && e.code === 'INVALID_SETTLEMENT');
    const settled = await settleWorkflowSpend(db, workflow.id, base.eventKey, 175);
    assert.equal(settled.state, 'settled');
    assert.equal((await settleWorkflowSpend(db, workflow.id, base.eventKey, 175)).id, settled.id);
    let state = await db.workflowRun.findUniqueOrThrow({ where: { id: workflow.id } });
    assert.equal(state.reservedCents, 0);
    assert.equal(state.spentCents, 175);
    assert.equal(await db.workflowCostEntry.count({ where: { workflowId: workflow.id } }), 1);
    assert.equal((await reserveWorkflowSpend(db, { ...base, eventKey: 'call:003', maxAmountCents: 300 })).state, 'reserved');
    assert.equal((await releaseWorkflowSpend(db, workflow.id, 'call:003', 'cancelled_before_dispatch')).state, 'released');
    assert.equal((await releaseWorkflowSpend(db, workflow.id, 'call:003', 'provider_confirmed_no_charge')).state, 'released');
    await assert.rejects(() => settleWorkflowSpend(db, workflow.id, 'call:003', 20),
      (e: unknown) => e instanceof DemoError && e.code === 'INVALID_SETTLEMENT');
    state = await db.workflowRun.findUniqueOrThrow({ where: { id: workflow.id } });
    assert.equal(state.spentCents, 175);
    assert.equal(state.reservedCents, 0);
    const pending = await reserveWorkflowSpend(db, { ...base, eventKey: 'call:unknown', maxAmountCents: 300 });
    assert.equal(pending.state, 'reserved'); // Unknown provider result must NOT be released.
    state = await db.workflowRun.findUniqueOrThrow({ where: { id: workflow.id } });
    assert.equal(state.reservedCents, 300);
    await assert.rejects(() => reserveWorkflowSpend(db, { ...base, eventKey: 'call:004', maxAmountCents: 30 }),
      (e: unknown) => e instanceof DemoError && e.code === 'BUDGET_EXCEEDED');
  } finally {
    await db.workflowRun.deleteMany({});
    await db.$disconnect();
  }
});

test('competing paid actions cannot oversubscribe workflow budget', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const db = new PrismaClient();
  await db.$connect();
  try {
    const workflow = await new DurableOrchestrator(db).create('Check competing budget reservations');
    const base = { workflowId: workflow.id, category: 'llm' as const, maxAmountCents: 350 };
    const results = await Promise.allSettled([
      reserveWorkflowSpend(db, { ...base, eventKey: 'reservation:001' }),
      reserveWorkflowSpend(db, { ...base, eventKey: 'reservation:002' })
    ]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(results.filter(x => x.status === 'rejected' &&
      x.reason instanceof DemoError && x.reason.code === 'BUDGET_EXCEEDED').length, 1);
    const current = await db.workflowRun.findUniqueOrThrow({ where: { id: workflow.id } });
    assert.equal(current.reservedCents, 350);
    assert.equal(current.spentCents, 0);
    assert.equal(await db.workflowCostReservation.count({ where: { workflowId: workflow.id } }), 1);
    await db.workflowRun.update({ where: { id: workflow.id }, data: { state: 'paused' } });
    await assert.rejects(() => reserveWorkflowSpend(db, { ...base, eventKey: 'reservation:003', maxAmountCents: 50 }),
      (e: unknown) => e instanceof DemoError && e.code === 'BUDGET_EXCEEDED');
  } finally {
    await db.workflowRun.deleteMany({});
    await db.$disconnect();
  }
});

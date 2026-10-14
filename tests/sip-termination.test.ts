import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { DurableOrchestrator } from '../packages/storage/src/orchestrator.ts';
import { readCloudSipPolicy, sipRoomIdentity } from '../packages/voice/src/livekit-sip.ts';
import { prepareConsentedSipCall, durableSipDispatchGuards, saveSipDispatchOutcome } from
  '../packages/storage/src/sip-calls.ts';
import { processOneSipTermination, sweepSipDeadlines } from
  '../packages/storage/src/sip-termination.ts';

const number = '+12125550123';
const policy = readCloudSipPolicy({
  RUNTIME_PROFILE: 'postgres', OUTBOUND_ENABLED: 'true', TEST_CLOUD_SIP_ENABLED: 'true',
  LIVEKIT_SIP_OUTBOUND_TRUNK_ID: 'ST_consent12345', CLOUD_SIP_ALLOWED_TEST_NUMBERS: number
});

test('stop before SIP dispatch cancels intent, releases budget and never attempts hangup', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const db = new PrismaClient();
  await db.$connect();
  try {
    const orchestrator = new DurableOrchestrator(db);
    const run = await orchestrator.create('Cancel before calling approved test number');
    const intent = { workflowId: run.id, number, actionKey: 'stop:001',
      budgetReservationKey: 'sip:stop:001', maxAmountCents: 300 };
    const prepared = await prepareConsentedSipCall(db, policy, intent);
    assert.equal(prepared.state, 'prepared');
    assert.ok(prepared.deadlineAt);
    assert.equal(prepared.roomName, sipRoomIdentity(run.id, intent.actionKey).roomName);
    assert.equal((await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).reservedCents, 300);
    await orchestrator.stop(run.id);
    const cancelled = await db.workflowSipCall.findUniqueOrThrow({ where: { id: prepared.id } });
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.stopReason, 'workflow_stopped');
    assert.equal(cancelled.terminationState, 'not_needed');
    assert.equal((await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).reservedCents, 0);
    assert.equal((await db.workflowCostReservation.findUniqueOrThrow({
      where: { workflowId_eventKey: { workflowId: run.id, eventKey: intent.budgetReservationKey } }
    })).state, 'released');
    assert.equal(await durableSipDispatchGuards(db).claimOnce(intent), false);
    let deletes = 0;
    assert.equal(await processOneSipTermination(db, policy, { async deleteRoom() { deletes++; } }), null);
    assert.equal(deletes, 0);
    await orchestrator.stop(run.id);
    assert.equal((await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).reservedCents, 0);
  } finally {
    await db.workflowRun.deleteMany({});
    await db.$disconnect();
  }
});

test('stop after claim, before provider ack creates one hangup even when ack arrives later', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const db = new PrismaClient();
  await db.$connect();
  try {
    const orchestrator = new DurableOrchestrator(db);
    const run = await orchestrator.create('Do not leave a ringing test call');
    const intent = { workflowId: run.id, number, actionKey: 'stop:002',
      budgetReservationKey: 'sip:stop:002', maxAmountCents: 250 };
    await prepareConsentedSipCall(db, policy, intent);
    assert.equal(await durableSipDispatchGuards(db).claimOnce(intent), true);
    await orchestrator.stop(run.id);
    let pending = await db.workflowSipCall.findUniqueOrThrow({
      where: { workflowId_actionKey: { workflowId: run.id, actionKey: intent.actionKey } }
    });
    assert.equal(pending.state, 'attempting');
    assert.equal(pending.stopReason, 'workflow_stopped');
    assert.equal(pending.terminationState, 'pending');
    const identity = sipRoomIdentity(run.id, intent.actionKey);
    await saveSipDispatchOutcome(db, intent, { state: 'provider_accepted', ...identity,
      providerCallId: 'fake-no-real-connection' });
    pending = await db.workflowSipCall.findUniqueOrThrow({ where: { id: pending.id } });
    assert.equal(pending.stopReason, 'workflow_stopped');
    assert.equal(pending.terminationState, 'pending');
    const rooms: string[] = [];
    const processed = await processOneSipTermination(db, policy, {
      async deleteRoom(room) { rooms.push(room); }
    });
    assert.equal(processed, pending.id);
    assert.deepEqual(rooms, [identity.roomName]);
    assert.equal(await processOneSipTermination(db, policy, {
      async deleteRoom() { throw new Error('should not repeat'); }
    }), null);
    const completed = await db.workflowSipCall.findUniqueOrThrow({ where: { id: pending.id } });
    assert.equal(completed.terminationState, 'requested');
    assert.equal((await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).reservedCents, 250);
    assert.equal(await db.workflowCostEntry.count({ where: { workflowId: run.id } }), 0);
  } finally {
    await db.workflowRun.deleteMany({});
    await db.$disconnect();
  }
});

test('deadline expiration handles prepared and unknown call, and network hangup ambiguity does not retry', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const db = new PrismaClient();
  await db.$connect();
  try {
    const orchestrator = new DurableOrchestrator(db);
    const now = new Date();
    const run = await orchestrator.create('Check deterministic SIP watchdog');
    const prepared = { workflowId: run.id, number, actionKey: 'deadline:001',
      budgetReservationKey: 'sip:deadline:001', maxAmountCents: 200 };
    const attempted = { workflowId: run.id, number, actionKey: 'deadline:002',
      budgetReservationKey: 'sip:deadline:002', maxAmountCents: 200 };
    await prepareConsentedSipCall(db, policy, prepared);
    await prepareConsentedSipCall(db, policy, attempted);
    assert.equal(await durableSipDispatchGuards(db).claimOnce(attempted), true);
    await db.workflowSipCall.updateMany({
      where: { workflowId: run.id }, data: { deadlineAt: new Date(now.getTime() - 1000) }
    });
    assert.equal(await sweepSipDeadlines(db, now), 2);
    assert.equal(await sweepSipDeadlines(db, now), 0);
    const records = await db.workflowSipCall.findMany({ where: { workflowId: run.id },
      orderBy: { actionKey: 'asc' } });
    assert.deepEqual(records.map(record => record.state), ['cancelled', 'attempting']);
    assert.deepEqual(records.map(record => record.terminationState), ['not_needed', 'pending']);
    assert.equal((await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).reservedCents, 200);
    let calls = 0;
    const failed = { async deleteRoom() { calls++; throw new Error('simulated lost ack'); } };
    assert.equal(await processOneSipTermination(db, policy, failed), records[1].id);
    assert.equal(await processOneSipTermination(db, policy, failed), null);
    assert.equal(calls, 1);
    assert.equal((await db.workflowSipCall.findUniqueOrThrow({ where: { id: records[1].id } }))
      .terminationState, 'unknown');
    assert.equal((await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).reservedCents, 200);
  } finally {
    await db.workflowRun.deleteMany({});
    await db.$disconnect();
  }
});

test('pause stops a pending call safely and does not leave resumable dial attempts', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const db = new PrismaClient();
  await db.$connect();
  try {
    const orchestrator = new DurableOrchestrator(db);
    const run = await orchestrator.create('Pause before contacting test participant');
    const intent = { workflowId: run.id, number, actionKey: 'pause:001',
      budgetReservationKey: 'sip:pause:001', maxAmountCents: 250 };
    await prepareConsentedSipCall(db, policy, intent);
    const paused = await orchestrator.pause(run.id);
    assert.equal(paused.state, 'paused');
    assert.equal((await db.workflowSipCall.findFirstOrThrow({ where: { workflowId: run.id } })).state,
      'cancelled');
    assert.equal((await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).reservedCents, 0);
    await orchestrator.resume(run.id);
    assert.equal(await durableSipDispatchGuards(db).claimOnce(intent), false);
  } finally {
    await db.workflowRun.deleteMany({});
    await db.$disconnect();
  }
});

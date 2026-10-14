import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { DurableOrchestrator } from '../packages/storage/src/orchestrator.ts';
import { readCloudSipPolicy, type SipClientLike } from '../packages/voice/src/livekit-sip.ts';
import { prepareConsentedSipCall, durableSipDispatchGuards, dispatchPreparedSipCall } from
  '../packages/storage/src/sip-calls.ts';

test('P3 SIP call intent: reserved, unique, claimed once and accepted without actual calls', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const db = new PrismaClient();
  await db.$connect();
  try {
    const run = await new DurableOrchestrator(db).create('Проверить звонок на свой номер');
    const number = '+12125550123';
    const policy = readCloudSipPolicy({ RUNTIME_PROFILE: 'postgres', OUTBOUND_ENABLED: 'true',
      TEST_CLOUD_SIP_ENABLED: 'true', LIVEKIT_SIP_OUTBOUND_TRUNK_ID: 'ST_testonly12345',
      CLOUD_SIP_ALLOWED_TEST_NUMBERS: number });
    const intent = { workflowId: run.id, number, actionKey: 'test:001',
      budgetReservationKey: 'sip:test:001', maxAmountCents: 300 };
    const first = await prepareConsentedSipCall(db, policy, intent);
    assert.equal((await prepareConsentedSipCall(db, policy, intent)).id, first.id);
    assert.equal((await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).reservedCents, 300);
    const guards = durableSipDispatchGuards(db);
    assert.equal(await guards.reservationReady(intent), true);
    let sends = 0;
    const provider: SipClientLike = { async createSipParticipant() { sends++;
      return { sipCallId: 'fake-call-id' }; } };
    const completed = await dispatchPreparedSipCall(db, policy, intent, provider);
    assert.equal(completed.state, 'provider_accepted');
    assert.equal(completed.providerCallId, 'fake-call-id');
    assert.equal(sends, 1);
    assert.equal(await guards.claimOnce(intent), false);
    await assert.rejects(() => dispatchPreparedSipCall(db, policy, intent, provider));
    assert.equal(sends, 1);
    // Acceptance is not billing settlement: reserve remains held.
    assert.equal((await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).reservedCents, 300);
    assert.equal(await db.workflowCostEntry.count({ where: { workflowId: run.id } }), 0);
  } finally {
    await db.workflowRun.deleteMany({});
    await db.$disconnect();
  }
});

test('ambiguous SIP provider response remains unknown and is never redialed', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const db = new PrismaClient();
  await db.$connect();
  try {
    const run = await new DurableOrchestrator(db).create('Проверить неизвестную отправку');
    const number = '+12125550124';
    const policy = readCloudSipPolicy({ RUNTIME_PROFILE: 'postgres', OUTBOUND_ENABLED: 'true',
      TEST_CLOUD_SIP_ENABLED: 'true', LIVEKIT_SIP_OUTBOUND_TRUNK_ID: 'ST_testonly12345',
      CLOUD_SIP_ALLOWED_TEST_NUMBERS: number });
    const intent = { workflowId: run.id, number, actionKey: 'test:002',
      budgetReservationKey: 'sip:test:002', maxAmountCents: 400 };
    await prepareConsentedSipCall(db, policy, intent);
    let calls = 0;
    const networkLost: SipClientLike = { async createSipParticipant() { calls++;
      throw new Error('simulated timeout'); } };
    const unknown = await dispatchPreparedSipCall(db, policy, intent, networkLost);
    assert.equal(unknown.state, 'unknown');
    await assert.rejects(() => dispatchPreparedSipCall(db, policy, intent, networkLost));
    assert.equal(calls, 1);
    assert.equal((await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).reservedCents, 400);
    await assert.rejects(() => prepareConsentedSipCall(db, policy, { ...intent,
      actionKey: 'test:003', budgetReservationKey: 'sip:test:003', maxAmountCents: 200 }));
  } finally {
    await db.workflowRun.deleteMany({});
    await db.$disconnect();
  }
});

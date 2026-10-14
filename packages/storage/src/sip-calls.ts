import { Prisma, type PrismaClient } from '@prisma/client';
import { DemoError } from '../../core/src/demo.ts';
import { reserveWorkflowSpend } from './budget-reservations.ts';
import { dispatchConsentedSipTestCall, type CloudSipPolicy, type SipClientLike,
  type SipDialIntent, type SipDispatchOutcome, type DialGuards } from '../../voice/src/livekit-sip.ts';

export type PreparedSipIntent = SipDialIntent & { maxAmountCents: number };
function checkPolicy(policy: CloudSipPolicy, intent: SipDialIntent) {
  if (!policy.enabled || !/^[0-9a-f-]{36}$/.test(intent.workflowId) ||
      !/^[a-zA-Z0-9_.:-]{4,80}$/.test(intent.actionKey) ||
      intent.budgetReservationKey !== 'sip:' + intent.actionKey ||
      !/^\+[1-9]\d{7,14}$/.test(intent.number) ||
      !policy.allowedNumbers.has(intent.number)) {
    throw new DemoError(403, 'SIP_DENIED', 'Недопустимый тестовый SIP вызов');
  }
}
/**
 * Prepare a budgeted, durable call before any network operation. The budget
 * reserve and call record can be created on separate transactions: a crash
 * between them leaves money reserved, but NEVER initiates a call.
 */
export async function prepareConsentedSipCall(db: PrismaClient, policy: CloudSipPolicy,
  intent: PreparedSipIntent) {
  checkPolicy(policy, intent);
  await reserveWorkflowSpend(db, { workflowId: intent.workflowId,
    eventKey: intent.budgetReservationKey, category: 'telephony',
    maxAmountCents: intent.maxAmountCents });
  try {
    return await db.workflowSipCall.create({
      data: { workflowId: intent.workflowId, actionKey: intent.actionKey,
        number: intent.number, budgetReservationKey: intent.budgetReservationKey }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await db.workflowSipCall.findUnique({
        where: { workflowId_actionKey: { workflowId: intent.workflowId, actionKey: intent.actionKey } }
      });
      if (existing && existing.number === intent.number &&
          existing.budgetReservationKey === intent.budgetReservationKey) return existing;
      throw new DemoError(409, 'SIP_INTENT_CONFLICT', 'Повторный ключ с другим адресатом');
    }
    throw error;
  }
}

export function durableSipDispatchGuards(db: PrismaClient): DialGuards {
  return {
    async reservationReady(intent) {
      const record = await db.workflowSipCall.findUnique({
        where: { workflowId_actionKey: { workflowId: intent.workflowId, actionKey: intent.actionKey } },
        include: { workflow: { select: { state: true } } }
      });
      if (!record || record.state !== 'prepared' || record.number !== intent.number ||
          record.budgetReservationKey !== intent.budgetReservationKey ||
          ['paused', 'cancelled', 'completed', 'failed'].includes(record.workflow.state)) return false;
      const reservation = await db.workflowCostReservation.findUnique({
        where: { workflowId_eventKey: { workflowId: intent.workflowId,
          eventKey: intent.budgetReservationKey } }
      });
      return !!reservation && reservation.state === 'reserved' &&
        reservation.category === 'telephony' && reservation.maxAmountCents > 0;
    },
    async claimOnce(intent) {
      // Serialized with other claims on the same record. Attempted/unknown
      // must never be claimed again, including after a worker restart.
      return (await db.workflowSipCall.updateMany({
        where: { workflowId: intent.workflowId, actionKey: intent.actionKey,
          number: intent.number, budgetReservationKey: intent.budgetReservationKey,
          state: 'prepared', workflow: { is: { state: { notIn: ['paused', 'cancelled', 'completed', 'failed'] } } } },
        data: { state: 'attempting' }
      })).count === 1;
    }
  };
}

/** Persist provider acceptance or ambiguous outcome; neither means answered. */
export async function saveSipDispatchOutcome(db: PrismaClient, intent: SipDialIntent,
  result: SipDispatchOutcome) {
  return db.$transaction(async tx => {
    const changed = await tx.workflowSipCall.updateMany({
      where: { workflowId: intent.workflowId, actionKey: intent.actionKey, state: 'attempting' },
      data: { state: result.state, roomName: result.roomName,
        participantIdentity: result.participantIdentity, providerCallId: result.providerCallId }
    });
    if (changed.count !== 1) throw new DemoError(409, 'SIP_OUTCOME_CONFLICT', 'Вызов изменён');
    await tx.workflowEvent.create({ data: { workflowId: intent.workflowId,
      kind: 'sip_dispatch_' + result.state, metadata: { actionKey: intent.actionKey } } });
    return tx.workflowSipCall.findUniqueOrThrow({
      where: { workflowId_actionKey: { workflowId: intent.workflowId, actionKey: intent.actionKey } }
    });
  });
}

/** Only a future isolated, operator-controlled test worker may invoke this. */
export async function dispatchPreparedSipCall(db: PrismaClient, policy: CloudSipPolicy,
  intent: SipDialIntent, client: SipClientLike) {
  checkPolicy(policy, intent);
  const result = await dispatchConsentedSipTestCall(policy, intent, durableSipDispatchGuards(db), client);
  return saveSipDispatchOutcome(db, intent, result);
}

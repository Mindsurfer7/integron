import { type Prisma, type PrismaClient } from '@prisma/client';
import { DemoError } from '../../core/src/demo.ts';
import { sipRoomIdentity } from '../../voice/src/livekit-sip.ts';

export type SipStopReason = 'workflow_stopped' | 'deadline_exceeded' | 'operator_stop';
type DbTx = Prisma.TransactionClient;
const dispatchStates = ['attempting', 'provider_accepted', 'unknown'] as const;

/**
 * A prepared call was never submitted to LiveKit: safely cancel and release.
 * A claimed call may already be ringing: record a durable termination request.
 * Neither changing a workflow's state nor deleting a room is billing evidence.
 */
export async function requestSipStopInTransaction(
  tx: DbTx, id: string, reason: SipStopReason, now: Date = new Date()
): Promise<boolean> {
  const call = await tx.workflowSipCall.findUnique({ where: { id } });
  if (!call || call.stopRequestedAt) return false;
  if (call.state === 'prepared') {
    const updated = await tx.workflowSipCall.updateMany({
      where: { id, state: 'prepared', stopRequestedAt: null },
      data: { state: 'cancelled', stopRequestedAt: now, stopReason: reason,
        terminationState: 'not_needed', terminationAt: now }
    });
    if (updated.count) {
      const reservation = await tx.workflowCostReservation.findUnique({
        where: { workflowId_eventKey: { workflowId: call.workflowId,
          eventKey: call.budgetReservationKey } }
      });
      if (!reservation || reservation.state !== 'reserved' || reservation.category !== 'telephony') {
        throw new DemoError(409, 'SIP_BUDGET_INTEGRITY', 'Не найден резерв для ещё не отправленного звонка');
      }
      const released = await tx.workflowCostReservation.updateMany({
        where: { id: reservation.id, state: 'reserved' },
        data: { state: 'released', actualAmountCents: 0, settledAt: now }
      });
      if (released.count !== 1) throw new DemoError(409, 'SIP_BUDGET_INTEGRITY', 'Резерв уже изменён');
      const budget = await tx.workflowRun.updateMany({
        where: { id: call.workflowId, reservedCents: { gte: reservation.maxAmountCents } },
        data: { reservedCents: { decrement: reservation.maxAmountCents } }
      });
      if (budget.count !== 1) throw new DemoError(409, 'SIP_BUDGET_INTEGRITY', 'Невозможно вернуть резерв');
      await tx.workflowEvent.create({ data: { workflowId: call.workflowId, kind: 'sip_cancelled_before_dispatch',
        metadata: { actionKey: call.actionKey, reason } } });
      return true;
    }
  }
  // Another transaction may have claimed prepared -> attempting meanwhile.
  const updated = await tx.workflowSipCall.updateMany({
    where: { id, stopRequestedAt: null, state: { in: [...dispatchStates] } },
    data: { stopRequestedAt: now, stopReason: reason, terminationState: 'pending' }
  });
  if (updated.count) {
    await tx.workflowEvent.create({ data: { workflowId: call.workflowId, kind: 'sip_stop_requested',
      metadata: { actionKey: call.actionKey, reason } } });
  }
  return updated.count === 1;
}

/** Called inside the same transaction which stops the parent workflow. */
export async function requestWorkflowSipStops(
  tx: DbTx, workflowId: string, reason: SipStopReason = 'workflow_stopped', now = new Date()
) {
  const candidates = await tx.workflowSipCall.findMany({
    where: { workflowId, stopRequestedAt: null,
      state: { in: ['prepared', ...dispatchStates] } },
    orderBy: { createdAt: 'asc' }
  });
  let changed = 0;
  for (const candidate of candidates) {
    if (await requestSipStopInTransaction(tx, candidate.id, reason, now)) changed++;
  }
  return changed;
}

/** One bounded sweep; a separate guardian process invokes it periodically. */
export async function sweepSipDeadlines(db: PrismaClient, now = new Date(), limit = 50) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_SWEEP_LIMIT');
  const due = await db.workflowSipCall.findMany({
    where: { deadlineAt: { lte: now }, stopRequestedAt: null,
      state: { in: ['prepared', ...dispatchStates] } },
    orderBy: [{ deadlineAt: 'asc' }, { createdAt: 'asc' }], take: limit,
    select: { id: true }
  });
  let changed = 0;
  for (const { id } of due) {
    changed += Number(await db.$transaction(async tx => {
      const current = await tx.workflowSipCall.findUnique({ where: { id } });
      if (!current?.deadlineAt || current.deadlineAt > now) return false;
      return requestSipStopInTransaction(tx, id, 'deadline_exceeded', now);
    }));
  }
  return changed;
}

export interface SipRoomTerminationClient {
  deleteRoom(roomName: string): Promise<void>;
}

/**
 * A successful API response indicates only that the room-delete command was
 * accepted, not a verified BYE, disconnected participant or settled invoice.
 * Every network failure is UNKNOWN and never automatically retried.
 */
export async function processOneSipTermination(db: PrismaClient, client: SipRoomTerminationClient) {
  const candidates = await db.workflowSipCall.findMany({
    where: { terminationState: 'pending', stopRequestedAt: { not: null },
      state: { in: [...dispatchStates] } },
    orderBy: [{ stopRequestedAt: 'asc' }, { createdAt: 'asc' }], take: 20
  });
  for (const candidate of candidates) {
    const expected = sipRoomIdentity(candidate.workflowId, candidate.actionKey);
    const claimed = await db.workflowSipCall.updateMany({
      where: { id: candidate.id, terminationState: 'pending', stopRequestedAt: { not: null } },
      data: { terminationState: 'attempting', terminationAt: new Date() }
    });
    if (claimed.count !== 1) continue;
    // Treat malformed/legacy identity as ambiguous; no arbitrary room deletion.
    if ((candidate.roomName && candidate.roomName !== expected.roomName) ||
        (candidate.participantIdentity && candidate.participantIdentity !== expected.participantIdentity)) {
      await db.workflowSipCall.update({
        where: { id: candidate.id }, data: { terminationState: 'unknown' }
      });
      return candidate.id;
    }
    let outcome: 'requested' | 'unknown' = 'requested';
    try {
      await client.deleteRoom(expected.roomName);
    } catch {
      outcome = 'unknown';
    }
    await db.$transaction(async tx => {
      await tx.workflowSipCall.updateMany({
        where: { id: candidate.id, terminationState: 'attempting' },
        data: { terminationState: outcome }
      });
      await tx.workflowEvent.create({ data: { workflowId: candidate.workflowId,
        kind: 'sip_termination_' + outcome,
        metadata: { actionKey: candidate.actionKey } } });
    });
    return candidate.id;
  }
  return null;
}

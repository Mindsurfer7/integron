import { createHash } from 'node:crypto';

/**
 * P3.1 experimental outbound SIP interface. No API/UI/worker calls this today.
 * The caller MUST durably reserve budget and claim a one-shot action in Postgres
 * before crossing this boundary. A network exception is UNKNOWN, not FAILED.
 */
export interface SipClientLike {
  createSipParticipant(trunkId: string, phoneNumber: string, roomName: string,
    options: { participantIdentity: string; participantName: string; waitUntilAnswered: boolean }
  ): Promise<{ participantIdentity?: string; sipCallId?: string }>;
}
export interface CloudSipPolicy {
  enabled: boolean;
  trunkId: string;
  allowedNumbers: ReadonlySet<string>;
}
export interface SipDialIntent {
  workflowId: string;
  actionKey: string;
  number: string;
  budgetReservationKey: string;
}
export interface DialGuards {
  /** Read existing reserved telephony budget, reject absent/stale/wrong task. */
  reservationReady(intent: SipDialIntent): Promise<boolean>;
  /** Compare-and-set PREPARED -> ATTEMPTING, once ever; no repeat on UNKNOWN. */
  claimOnce(intent: SipDialIntent): Promise<boolean>;
}
export type SipDispatchOutcome = {
  state: 'provider_accepted' | 'unknown';
  roomName: string;
  participantIdentity: string;
  providerCallId?: string;
};

/** Read config without ever printing or serializing credentials or numbers. */
export function readCloudSipPolicy(env: Record<string, string | undefined>): CloudSipPolicy {
  const enabled = env.TEST_CLOUD_SIP_ENABLED === 'true';
  if (!enabled) return { enabled: false, trunkId: '', allowedNumbers: new Set() };
  if (env.RUNTIME_PROFILE !== 'postgres' || env.OUTBOUND_ENABLED !== 'true') {
    throw new Error('CLOUD_SIP_REQUIRES_POSTGRES_OUTBOUND_DISABLED');
  }
  const trunkId = env.LIVEKIT_SIP_OUTBOUND_TRUNK_ID ?? '';
  if (!/^[A-Za-z0-9_-]{6,120}$/.test(trunkId)) throw new Error('INVALID_SIP_TRUNK');
  const numbers = (env.CLOUD_SIP_ALLOWED_TEST_NUMBERS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (numbers.length < 1 || numbers.length > 2 ||
      new Set(numbers).size !== numbers.length ||
      numbers.some(n => !/^\+[1-9]\d{7,14}$/.test(n))) {
    throw new Error('INVALID_SIP_ALLOWLIST');
  }
  return { enabled: true, trunkId, allowedNumbers: new Set(numbers) };
}

function suffix(workflowId: string, actionKey: string): string {
  return createHash('sha256').update(workflowId + ':' + actionKey).digest('hex').slice(0, 20);
}
/** A captured temporary network error is ambiguous: caller MUST NOT retry. */
export async function dispatchConsentedSipTestCall(
  policy: CloudSipPolicy, intent: SipDialIntent, guards: DialGuards, client: SipClientLike
): Promise<SipDispatchOutcome> {
  if (!policy.enabled) throw new Error('CLOUD_SIP_DISABLED');
  if (!/^[0-9a-f-]{36}$/.test(intent.workflowId) ||
      !/^[a-zA-Z0-9_.:-]{4,80}$/.test(intent.actionKey) ||
      intent.budgetReservationKey !== 'sip:' + intent.actionKey ||
      !/^\+[1-9]\d{7,14}$/.test(intent.number) ||
      !policy.allowedNumbers.has(intent.number)) {
    throw new Error('CLOUD_SIP_POLICY_DENIED');
  }
  if (!await guards.reservationReady(intent)) throw new Error('CLOUD_SIP_UNRESERVED');
  if (!await guards.claimOnce(intent)) throw new Error('CLOUD_SIP_ALREADY_CLAIMED');
  const id = suffix(intent.workflowId, intent.actionKey);
  const roomName = 'integron-test-' + id;
  const participantIdentity = 'integron-sip-' + id;
  try {
    const response = await client.createSipParticipant(policy.trunkId, intent.number, roomName, {
      participantIdentity, participantName: 'Integron Test', waitUntilAnswered: false
    });
    return { state: 'provider_accepted', roomName, participantIdentity,
      providerCallId: response.sipCallId };
  } catch {
    // A request may have reached LiveKit even if the response never arrived.
    // An independent provider-side lookup or owner reconciliation is mandatory.
    return { state: 'unknown', roomName, participantIdentity };
  }
}

/** Actual LiveKit Cloud SIP SDK gateway, only instantiated in an explicit worker. */
export async function liveKitSipClientFromEnvironment(env: Record<string, string | undefined>):
  Promise<SipClientLike> {
  const url = new URL(env.LIVEKIT_URL ?? '');
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.livekit.cloud') ||
      url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('INVALID_LIVEKIT_CLOUD_URL');
  }
  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    throw new Error('LIVEKIT_CREDENTIALS_REQUIRED');
  }
  const { SipClient } = await import('livekit-server-sdk');
  return new SipClient(url.toString(), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
}

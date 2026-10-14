import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCloudSipPolicy, dispatchConsentedSipTestCall, type SipClientLike } from
  '../packages/voice/src/livekit-sip.ts';

const workflowId = '11111111-1111-4111-a111-111111111111';
const number = '+12125550123';
const env = { TEST_CLOUD_SIP_ENABLED: 'true', RUNTIME_PROFILE: 'postgres',
  OUTBOUND_ENABLED: 'true', LIVEKIT_SIP_OUTBOUND_TRUNK_ID: 'ST_testonly12345',
  CLOUD_SIP_ALLOWED_TEST_NUMBERS: number };

test('SIP cloud adapter is opt-in and allows only consented numbers', async () => {
  const disabled = readCloudSipPolicy({});
  assert.equal(disabled.enabled, false);
  const policy = readCloudSipPolicy(env);
  let calls = 0;
  const client: SipClientLike = { async createSipParticipant(id, called, room, options) {
    calls++;
    assert.equal(id, 'ST_testonly12345');
    assert.equal(called, number);
    assert.match(room, /^integron-test-[0-9a-f]{20}$/);
    assert.equal(options.waitUntilAnswered, false);
    return { sipCallId: 'provider-test-id', participantIdentity: options.participantIdentity };
  }};
  const intent = { workflowId, actionKey: 'call:001', number, budgetReservationKey: 'sip:call:001' };
  let claimed = false;
  const guards = { async reservationReady() { return true; },
    async claimOnce() { if (claimed) return false; claimed = true; return true; } };
  await assert.rejects(
    dispatchConsentedSipTestCall(disabled, intent, guards, client), /CLOUD_SIP_DISABLED/);
  await assert.rejects(
    dispatchConsentedSipTestCall(policy, { ...intent, number: '+12125550999' }, guards, client),
    /CLOUD_SIP_POLICY_DENIED/);
  await assert.rejects(
    dispatchConsentedSipTestCall(policy, { ...intent, budgetReservationKey: 'wrong' }, guards, client),
    /CLOUD_SIP_POLICY_DENIED/);
  assert.equal(calls, 0);
  assert.equal((await dispatchConsentedSipTestCall(policy, intent, guards, client)).state, 'provider_accepted');
  assert.equal(calls, 1);
  await assert.rejects(dispatchConsentedSipTestCall(policy, intent, guards, client),
    /CLOUD_SIP_ALREADY_CLAIMED/);
  assert.equal(calls, 1);
});

test('SIP dispatch never retries ambiguous sends or skips budget preflight', async () => {
  const policy = readCloudSipPolicy(env);
  const intent = { workflowId, actionKey: 'call:002', number, budgetReservationKey: 'sip:call:002' };
  let requests = 0, claims = 0;
  const failedClient: SipClientLike = { async createSipParticipant() { requests++;
    throw new Error('Lost network response'); } };
  await assert.rejects(dispatchConsentedSipTestCall(policy, intent,
    { async reservationReady() { return false; }, async claimOnce() { claims++; return true; } },
    failedClient), /CLOUD_SIP_UNRESERVED/);
  assert.equal(claims, 0);
  const guards = { async reservationReady() { return true; },
    async claimOnce() { claims++; return claims === 1; } };
  const result = await dispatchConsentedSipTestCall(policy, intent, guards, failedClient);
  assert.equal(result.state, 'unknown');
  assert.equal(requests, 1);
  await assert.rejects(dispatchConsentedSipTestCall(policy, intent, guards, failedClient),
    /CLOUD_SIP_ALREADY_CLAIMED/);
  assert.equal(requests, 1);
});

test('SIP preflight fails closed on unsafe runtime and non-E164 allowlist', () => {
  assert.throws(() => readCloudSipPolicy({ ...env, RUNTIME_PROFILE: 'demo' }), /REQUIRES_POSTGRES/);
  assert.throws(() => readCloudSipPolicy({ ...env, OUTBOUND_ENABLED: 'false' }), /REQUIRES_POSTGRES/);
  assert.throws(() => readCloudSipPolicy({ ...env, CLOUD_SIP_ALLOWED_TEST_NUMBERS: '123' }), /INVALID_SIP_ALLOWLIST/);
  assert.throws(() => readCloudSipPolicy({ ...env, CLOUD_SIP_ALLOWED_TEST_NUMBERS: number + ',' + number }), /INVALID_SIP_ALLOWLIST/);
});

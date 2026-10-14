# P3.1 — LiveKit Cloud SIP gateway slice (2026-10-14)

Status: adapter and offline test contract only. No actual PSTN calls, AI audio, active LiveKit rooms or provider accounts have been tested. No API route, job worker, or public dial action is added.

## Cloud architecture
- Use LiveKit Cloud SIP outbound trunk linked to an owned PSTN number from a regulated carrier.
- Create SIP participant with SipClient.createSipParticipant in a room; later attach LiveKit Agents (STT/LLM/TTS or realtime AI).
- Keep owner notifications in Telegram Bot API, separate from SIP agent identity.
- Require provider-approved caller ID, consent, country compliance and billing. Recording stays off.

Official docs: https://docs.livekit.io/telephony/making-calls/outbound-calls/ and https://docs.livekit.io/reference/server-sdk-js/classes/SipClient.html

## Implemented
- `packages/voice/src/livekit-sip.ts`: test-only LiveKit SIP adapter; deterministic room/identity from workflow and action key; 1–2 E.164 consenting test numbers.
- Caller must inject durable reservation verification and one-shot claim from storage before dialing. Network failures are `unknown`, **never retried**.
- Optional LiveKit SDK initializer checks a valid HTTPS *.livekit.cloud host, API key and secret. No automatic SDK connection in API/worker.
- Offline tests cover deny-by-default flags, allowlist, absent reservation, one-shot dispatch and ambiguous responses.

## Future isolated test worker config (not yet a working dial command)
    RUNTIME_PROFILE=postgres
    OUTBOUND_ENABLED=true
    TEST_CLOUD_SIP_ENABLED=true
    CLOUD_SIP_ALLOWED_TEST_NUMBERS=+1xxxxxxxxxx
    LIVEKIT_SIP_OUTBOUND_TRUNK_ID=<stored outbound trunk ID>
    LIVEKIT_URL=https://<project>.livekit.cloud
    LIVEKIT_API_KEY=<secret>
    LIVEKIT_API_SECRET=<secret>

These flags do NOT make a phone call alone. The Fastify API still forbids OUTBOUND_ENABLED=true, and remains loopback-only. Do not paste secrets or real phone numbers into source control.

## Blocking acceptance
- [ ] Durable WorkflowCall/outbox + database-backed exactly-once claim using P1 WorkflowCostReservation.
- [ ] LiveKit voice agent, realtime audio, barge-in, caller disclosures, time-bound Telegram owner HITL.
- [ ] SIP trunk and account setup, signed callbacks, call state, provider metering, hard timeout/hangup that survives worker restarts.
- [ ] Country/consent policy, verified owner-controlled test number, Mac/Linux two-way audio E2E, no-answer/stop/unknown handling.

Capability remains experimental/unavailable to ordinary tasks; CI never starts a call.

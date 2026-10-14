# P3.1 — Durable cloud SIP call intentions (2026-10-14)

PostgreSQL now holds `WorkflowSipCall` for each manual/explicitly consented test action. The ordinary API/UI does NOT permit dialing and there is no automatic worker dispatch.

## Lifecycle
- `prepareConsentedSipCall` validates preconfigured test E.164 number and action key, reserves a bounded amount through P1, then creates a durable `prepared` call row. A crash between reserve and row create holds budget without dialing.
- `durableSipDispatchGuards` confirms the associated telephony reservation is still reserved and workflow is active; a compare-and-set claims `prepared -> attempting` exactly once.
- `dispatchPreparedSipCall` invokes the LiveKit adapter (only if an external trusted worker explicitly calls it) and persists `provider_accepted` or `unknown`. Neither implies answered, completed, released budget or zero cost.
- A crash after claim leaves `attempting` and prevents any blind retry. Manual provider reconciliation is required.
- Unknown result is never automatically re-dialed. Actual billing settlement and operator-triggered cancellation are separate future phases.

## Verification
- Offline mock SIP response tests, no provider account or real telephone activity.
- PostgreSQL integration: duplicate action, durable reserve, one-time claim, success and unknown network response, held charge, overspend refusal.

## Still blocking real voice MVP
- A dedicated isolated operator-controlled voice worker with strict dispatch controls and provider credential provisioning.
- Provider-side call state reconciliation, signed callbacks, full hangup/timeouts across worker crashes, metered invoice settlement.
- Real LiveKit Agents voice session + microphone/speech bridge, Telegram owner HITL while connected.
- Consent/local laws, test-number E2E, no-answer and failed-call confirmation.

Do not set live outbound flags in the regular API: the HTTP service remains loopback and forbids OUTBOUND_ENABLED=true.

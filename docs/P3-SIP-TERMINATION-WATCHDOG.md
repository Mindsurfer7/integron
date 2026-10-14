# P3.1 — SIP termination watchdog / stop propagation (2026-10-15)

## Scope

Implements the safety lifecycle for **consented test-only** LiveKit Cloud calls. No regular user can dial from the API or UI, and no voice agent or actual phone E2E was run.

- New `WorkflowSipCall` fields: bounded `deadlineAt` (default 180s after preparation; configurable 15–300s), `stopRequestedAt`, `stopReason`, `terminationState`, `terminationAt`.
- Stable room name and SIP participant identity are persisted **before** provider dispatch so they can be reconstructed after a worker crash.
- Parent workflow `stop` and `pause` propagate SIP cancellation **within the same PostgreSQL transaction** as the parent state transition.
- If an action is still `prepared`, it is cancelled without contacting LiveKit and its unused telephony reservation is released atomically. A subsequent resume does **not** revive it.
- If a call was claimed (`attempting`, `provider_accepted` or `unknown`), it gets a durable, one-shot termination request instead. The budget is **not** released.
- `sweepSipDeadlines` detects overdue calls, cancels unstarted ones and queues termination for possibly live calls.
- `processOneSipTermination` atomically claims a pending stop; for a preauthorized test number only, it calls LiveKit RoomServiceClient.deleteRoom once. Successful acknowledgment is `requested`, not proof of disconnect; failure is `unknown`, not retried.
- Both successful and unknown results remain subject to independent provider status/receipt reconciliation. No reserve settlement is based on a room deletion alone.

## Optional local **stop-only** guardian

Only for an owned, consented LiveKit test trunk/account: set `DATABASE_URL`, `RUNTIME_PROFILE=postgres`, `OUTBOUND_ENABLED=true`, `TEST_CLOUD_SIP_ENABLED=true`, `SIP_GUARDIAN_ENABLED=true`, one or two consented E.164 numbers in `CLOUD_SIP_ALLOWED_TEST_NUMBERS`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `LIVEKIT_SIP_OUTBOUND_TRUNK_ID`. Run `pnpm dev:sip-guardian` in an isolated process. The normal HTTP API must continue using OUTBOUND_ENABLED=false.

This worker **never dials**; it sweeps deadlines and processes one-shot stop requests, at most one per loop. On process restart, `terminationState=attempting|requested|unknown` is not automatically retried. A provider lookup or manual recovery is required.

## Coverage / limitations

PostgreSQL regression tests cover pre-dispatch stop/release, stop-after-claim with late provider acknowledgment, persisted single hangup request, simulated hangup timeout with no retry, timeout sweep and pause/resume. No live provider or native audio is exercised in CI.

**Important remaining gaps before live calling:** provider-authenticated participant status and hangup confirmation, reliable ongoing call usage metering, provider invoice settlement, handling a lost hangup acknowledgment without abandoning a live call, alarm/escalation of stuck calls, AI voice sessions and real opt-in test numbers. `deleteRoom` is not a substitute for verified PSTN billing cessation.

References: https://docs.livekit.io/telephony/making-calls/outbound-calls/ and https://docs.livekit.io/reference/server-sdk-js/classes/RoomServiceClient.html

# P1 — Preflight cost reservation slice (2026-10-14)

## Added
- `WorkflowCostReservation`: immutable workflow + eventKey + category + maximum, state `reserved|settled|released`, actual amount on settlement.
- `WorkflowRun.reservedCents`: amount committed but not yet invoiced. Invariant `spentCents + reservedCents <= maxCostCents` for API-mediated charges.
- `reserveWorkflowSpend`: one durable idempotency key per prospective provider action; atomic Postgres row update rejects insufficient headroom and paused/terminal runs.
- `settleWorkflowSpend`: provider-confirmed charge up to the reserved bound, releases unused amount, creates one actual cost ledger entry and audit event.
- `releaseWorkflowSpend`: only for definitely undispatched actions or provider-confirmed no-charge, with explicit reason and audit. Unknown network outcomes remain reserved.
- `recordWorkflowCost`: existing legacy direct metering now respects reserved funds.
- UI displays recorded, reserved and ceiling amounts separately. Regression tests exercise races and failures.

## Critical integration boundary
NO worker is authorized to initiate a paid call by this data model alone. Provider adapters **must** reserve ahead of time, define a defensible upper bound, atomically dispatch via a durable outbox, reconcile provider identifiers/invoices and stop/alert on unknown/budget incidents. The existing OpenAI planner has no verified provider token usage and still does not use reservations. Telephony has no live provider connection. Never treat a network timeout or stale lease as proof of no charge.

Cost values are in integer USD cents, used as conservative bookkeeping. Production currency conversion, per-day/global caps, per-provider rates/taxes and invoice reconciliation are NOT implemented. No external payment, booking or live telephony is enabled.

## Gate / validation
- [x] PostgreSQL migration, transactional reserve/settle/release, idempotency keys, mocked accounting cases and UI display.
- [ ] CI and merge verified.
- [ ] Integrate paid LLM usage and future telephone cost ceiling; handle exceptional overrun via incident/audit.
- [ ] Enforce global/day caps and channel-wide attempt throttles, verify actual provider price estimates.
- [ ] Full local real-world E2E, billing invoice reconciliation and operator emergency stop.

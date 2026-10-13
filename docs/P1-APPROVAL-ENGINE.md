# Integron P1 — Approval Engine (mock-only slice, 2026-10-13)

## Scope and threat boundary

An owner may explicitly authorize a *specific* proposed action; this must
not be confused with free-text feedback to a task. The currently implemented
API records and simulates authorizations **only for fictional organizations in
mock workflows**. Neither `approve` nor `consume-demo` sends messages,
creates bookings, discloses documents or transfers money. There are no live
executor adapters and no payment provider integration in this PR.

## Implemented

- [x] Separate PostgreSQL `WorkflowApproval` and
  `WorkflowApprovalNotification` tables with parent task FK, immutable
  request key, action type, fictional recipient, exact action summary,
  currency/amount fields when relevant, SHA-256 intent digest, owner
  user/chat IDs, state, TTL, audit timestamps and delivered message ID.
- [x] Valid action types: `booking`, `payment`, `data_disclosure`; **all**
  use `mode=simulation_only`, and creation only allows explicitly named
  `mock_fixture` workflow targets. A payment prototype requires a positive
  integer amount in minor units and a 3-letter uppercase currency.
- [x] Stable idempotent request key: same workflow/key/intent/owner returns
  the same approval; reuse for different action or amount fails closed.
- [x] Owner-only Telegram buttons and `/approve <approvalId>` /
  `/deny <approvalId>`; callbacks additionally require the *original sent*
  notification message ID and verified Telegram sender/chat IDs. No "yes"
  free-text acceptance and no inference from the last active approval.
- [x] **Atomic decisions:** pending -> approved/denied, TTL and owner checks;
  replay with the same decision is harmless; reversing a final decision
  is refused. Workflow stop and decision serialize on their parent row.
- [x] **One-time simulation:** the consumer must provide the exact matching
  action digest, parent workflow, mock mode, not-paused active state and
  unexpired `approved` state. An atomic transition to `consumed` and
  audit event reports `externalActions: 0`. A second attempt fails.
- [x] Owner notification outbox uses atomic claiming, no automatic retry
  when the Telegram acceptance status is unknown, queued messages held
  during pause, cancellation on stop/expiry and safe mock-only details.
- [x] Web UI: shows pending mock approvals, exact recipient, status, expiry,
  Telegram commands; can request one fixed demo-booking per workflow and
  invoke one-time mock consumption only after verified owner approval.
- [x] Offline validation + PostgreSQL regression coverage: duplicate
  requests/approvals, concurrent consume, wrong owner/chat/message,
  unrelated questions, forged amounts, timeout, stop, pause, unknown
  network delivery, origin/host and absence of provider I/O.

## API for local mock demos

- `POST /api/workflows/:id/approvals/demo` creates a *fixed* synthetic
  booking approval for the first fictional target; it will not accept a
  user-specified contact, amount, action or transport.
- `POST /api/workflows/:id/approvals/:approvalId/consume-demo` atomically
  records a successful *simulation*, never a real action.
- The approval is visible with workflow details via
  `GET /api/workflows/:id`.

Both HTTP endpoints inherit the existing loopback-only Fastify
Host/Origin rules. **The local web UI is unauthenticated**, so these
endpoints must never be exposed on a public interface or used to
authorize external providers. A verified Telegram Bot API owner identity
(`OWNER_TELEGRAM_USER_ID`, `OWNER_TELEGRAM_CHAT_ID`) must be configured
on the API process and owner worker to request and decide approvals.
The decision is **not** available as an unauthenticated web API.

## Lifecycle / policy

```text
request(mock target + exact intent)
  -> pending [outbox queued/sent/failed/unknown]
  -> approved | denied | expired | cancelled
approved -> consumed (simulation ONLY, one atomic claim)
approved -> expired / cancelled (TTL or stop)
```

A stop invalidates pending and approved approvals and revokes queued
owner notifications. Already-dispatched network requests cannot be
withdrawn and ambiguous sends are never automatically retried.
No generated LLM text or third-party message may authorize, rebind
or consume an action.

## Future production dependencies (NOT done)

- [ ] Authenticated/authorized server API, CSRF/session controls,
  transport identity and explicit owner-device validation.
- [ ] Dedicated future action executor with deterministic policy,
  real recipient/contact identity, legal/consent checks,
  spend reservation and provider reconciliation. The present
  approval records must **not** be accepted by that executor.
- [ ] Real financial authorization with exact currency, taxes,
  total price, beneficiary and per-action binding, redaction,
  limits and legal/fraud controls.
- [ ] Call-scoped approvals and bounded realtime wait; no telephony yet.
- [ ] Real Mac M1/account E2E and replay at provider boundary.
- [ ] Additional contact/identity/call schema models and approval UX.

## Acceptance

CI must run `pnpm test`, Prisma migration deployment,
`pnpm test:postgres` (including `tests/approvals.test.ts`) and
macOS offline adapter checks. No live messages, payment, call, third-party
login or provider secrets are needed or claimed.

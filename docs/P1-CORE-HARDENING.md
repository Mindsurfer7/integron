# P1 Core hardening — 2026-10-13

This increment builds on the existing durable orchestrator, owner notification outbox,
paused state and source-linked facts. It does **not** certify complete P1 acceptance
or enable live autonomous outreach, phone calls or production server access.

## Implemented

- [x] **Telegram owner control:** authenticated owner can use `/status`, `/pause <workflowId>`,
  `/resume <workflowId>` and `/stop <workflowId>`. Existing
  `/stop <legacyDemoTaskId>`, `/answer`, reply-to and inline buttons remain.
  If a mock workflow and its underlying demo task share an ID, a stop
  targets the durable workflow, revokes queued external/owner outbox and closes
  the underlying pending owner question.
- [x] **Pause CAS:** the stored `pausedFrom` must equal the state *actually paused*.
  Concurrent plan/send/wait transitions cannot leave a resumed task in an
  incompatible state/step. In-flight network sends cannot be recalled.
- [x] **Conflicting evidence:** multiple exact literal price, availability and
  delivery quotes are preserved with offsets; distinct values within the same
  field are `conflicting`, never silently resolved into an authoritative price.
  Negative and positive overlapping phrases are not double-counted.
- [x] **Per-workflow cost accounting primitive:** PostgreSQL stores
  `maxCostCents` (default 500 USD cents), `spentCents` and an idempotent
  `WorkflowCostEntry` ledger. Atomic conditional updates handle concurrent
  entries, duplicate event keys and budget rejection; a cost audit event is
  generated. The web UI displays the *recorded* amount and ceiling.
- [x] Regression tests: unauthorized owner commands, terminal stop, queued
  delivery cancellation, mock task cancellation, pause/read races,
  contradictions with exact offsets, idempotency and concurrent budget writes.

## Important limitations

- **No actual billing metering yet.** Existing provider adapters and LLM code do
  not invoke the cost ledger. The web UI explicitly labels amounts as recorded
  only. Do not claim these amounts are invoices or that the ledger alone stops
  provider-side spending. Before enabling paid calls, add preflight budget
  reservations and reconcile actual provider costs.
- Telegram free-text answers and approvals beyond fixed demo
  `cheapest|fastest|defer` are still not supported.
- No general `TargetOrganization/Contact/Conversation/Call` persistence model
  or public API authentication. The API remains localhost only.
- An unavailable Telegram/WhatsApp native test account and unknown outbound
  delivery cannot be automatically retried or treated as successful.
- Real Mac/Native TDLib, WhatsApp QR and complete P1 integration E2E still
  require interactive owner-controlled accounts and were not executed.

## Verification

CI: `pnpm test`, `pnpm db:deploy`, `pnpm test:postgres` including
`tests/budget.test.ts`, macOS offline TDLib/WhatsApp checks. PostgreSQL
integration validates state, outbox, cost and owner command behavior using
fake Telegram HTTP; never live sends. Before merging, all required jobs must
pass on the PR head.

## Remaining P1 acceptance

- [ ] Fully normalized targets, contacts, conversations, identities, approvals
  and call-specific clarifications.
- [ ] Schema-validated free-text human answers, approval TTL and concurrent
  owner questions with independent callback routing.
- [ ] Authenticated server deployment (HTTPS, sessions, CSRF); avoid exposing
  the localhost-only prototype over the public internet.
- [ ] Preflight reservation and reconciliation of **real** paid usage;
  per-channel rate limits, invoice-based actuals and emergency budgets.
- [ ] Local Mac M1 owner Telegram E2E and full restart test with
  simultaneous tasks; live E2E remains an explicit separate gate.

Next recommended P1 increment: normalized target/conversation/approval
models and free-text/approval-safe HITL; then live E2E and deployment auth.

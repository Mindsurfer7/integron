# P1.4 incremental HITL — workflow-scoped free-text conflict review (2026-10-13)

This increment implements one **end-to-end, non-financial clarification path**:
a *consented test* text conversation contains contradictory price, delivery or
availability statements -> the workflow waits for an authenticated owner's
free-text response -> the response is stored against its exact workflow
question -> the existing durable worker finalizes the workflow. It **never**
automatically acts on the response, sends another outbound inquiry, pays or
upgrades contradictory facts to verified.

## Components / behavior

- [x] PostgreSQL `WorkflowOwnerQuestion` (workflow FK, source message ID,
  unique request key, exact question UUID, response text, owner identity, TTL,
  state and timestamps) plus independent `WorkflowOwnerNotification` outbox.
  The legacy `OwnerClarification` for scripted mock choices stays unchanged.
- [x] Conservative trigger: only when literal extracted evidence contains
  `conflicting` values. The original source spans and `conflicting` status
  are preserved. Workflow transitions to `waiting_owner / await_conflict_review`
  atomically with fact extraction and question creation.
- [x] Verified Telegram owner may reply **only** to the exact sent bot
  `message_id` or send `/reply <questionUUID> <text>`; no ambient "last
  conversation" guessing. A free-text message without correlation is ignored.
- [x] A local web inbox displays questions and accepts scoped text via
  `POST /api/workflows/:workflowId/owner-questions/:questionId/answer`. The
  existing API is **localhost-only and unauthenticated**, so this is **not**
  a public owner login.
- [x] Input validation (2–500 characters), owner user/chat verification,
  workflow/question FK check, idempotent duplicate answer, terminal-state,
  expiry and stop guards. Multiple concurrent workflows maintain independent
  IDs and responses.
- [x] Separate delivery outbox: atomic claim; interrupted/ambiguous Telegram
  send -> `unknown` **without automatic resend**. Queued notices remain
  queued while the workflow is paused; stop/expiry cancels queued notices.
  The Telegram prompt is a static summary, not copied untrusted chat text.
- [x] Crash/restart behavior: the owner answer persists, the orchestrator
  claims the same `await_conflict_review` step after restarting and completes
  with `conflict_review_recorded`. The answer is advisory evidence, not a
  contact instruction and not an approval.
- [x] Negative and race-regression tests using synthetic provider transport:
  wrong sender/chat, uncorrelated text, two open questions, conflicting facts,
  repeated answer, expiry, stop, pause/resume, unknown send and localhost
  fallback. No credentials or real live E2E required.

## Manual mock acceptance

1. Run PostgreSQL migrations: `pnpm db:generate && pnpm db:deploy`.
2. Configure separate verified owner Telegram Bot API account privately with
   `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_USER_ID`, `OWNER_TELEGRAM_CHAT_ID`,
   and start `pnpm dev:telegram` locally. No secrets go into Git.
3. Start `pnpm dev:orchestrator` with the **same owner IDs** so that newly
   created conflict questions queue Telegram notifications.
4. With an explicitly allowed test recipient, create a test workflow and
   simulate an incoming answer such as "Цена 100 THB или 200 THB". It waits
   for human clarification and exposes two conflicting source quotes.
5. Reply to the exact owner notification or use `/reply <UUID> <text>`;
   optionally answer in the local dashboard. On worker tick, the task completes
   with review recorded, while the two facts remain conflicting.

If owner credentials are not configured, the workflow can still be answered
in the loopback web inbox. Expired requests fail closed after 24h. Paused tasks
stay paused after an owner answer; `/resume` must be explicit.

## Compatibility / remaining P1

- Existing demo and legacy `/answer` buttons unchanged; no blanket migration
  of historical legacy questions.
- No generic free-form external prompts, outbound follow-up, payment approval,
  call-bound question state or phone calls. None are implied by a recorded answer.
- No server-side authentication or CSRF/session stack for a public interface:
  do not expose the API outside loopback; `HOST/Origin` filtering is not a
  substitute for public authentication.
- `OwnerIdentity` is captured when the question is created by the
  orchestrator; changing owner IDs will not silently transfer authorization
  of a pending question.
- The Telegram worker remains single-poller. An already-dispatched provider
  request cannot be withdrawn by a pause/stop; outbound records use `unknown`
  on ambiguous delivery.
- Full P1.3/P1.4, approval policies, generic Contact/Identity/Call models,
  money reservations, and real Mac account E2E remain open roadmap items.

## CI gates

`pnpm test`, `pnpm test:postgres` (including
`tests/owner-questions.test.ts`), macOS offline TDLib/WhatsApp tests and
Prisma migrations. PR can merge only after all required checks pass.

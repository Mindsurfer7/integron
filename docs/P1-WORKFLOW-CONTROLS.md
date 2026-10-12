# P1 slice 4 — pause, resume, stop and correlated replies

**Status:** implemented with PostgreSQL integration tests; still a local test system,
not a production multi-account agent.

- WorkflowRun can be paused from any active state; pause atomically clears the
  orchestrator lease and records an audit event. The worker does not claim
  paused workflows. Repeated pause of an already paused workflow is idempotent.
- Resume restores the **same step**, without creating a new task/question/outbox.
  A paused reply that arrived while the workflow was stopped is checked in the
  same PostgreSQL transaction used to resume it, so it is not lost.
- Text adapters skip queued deliveries of paused workflows instead of marking
  them cancelled. An external reply to an already-sent message is accepted and
  stored while paused (after normal authenticated recipient+exact reply-to
  checks). It will be processed only after resume. Telegram Bot polling cursor
  may advance safely because the incoming message is already stored.
- Stop is valid during pause. It cancels unattempted queued messages and pending
  mock owner questions; a stopped task cannot be resumed.
- Existing lease fencing means a concurrent planner/collector cannot persist an
  advancement after pause. Stop similarly clears leases.
- Local API adds POST /api/workflows/:id/pause and /resume. UI shows a
  Pause/Continue button for every active/paused workflow.
- The Telegram **owner notification bot** accepts authenticated
  /wpause <workflowId>, /wresume <workflowId>, /wstop <workflowId>.
  The old /stop <mockTaskId> and /answer commands are unchanged.
  These commands require correct owner user **and** chat IDs, never general
  incoming third-party messages.

## Safety limitations

- Once Telegram has already accepted an in-flight send, pause/stop cannot
  unsend it. Queued messages are blocked when pause is observed, but a pause
  racing the final check before transport I/O cannot guarantee zero sends.
- If an external reply TTL or mock owner-question TTL expires during pause,
  resume does not extend it; the existing timeout/fail-closed policy applies.
- Ingest and resume coordinate via transaction updates on the workflow row.
  Genuine transient database races are retried; a persistent concurrency
  exception prevents acknowledging the polling offset.
- Owner Telegram bot has to be configured with the same
  TEST_TELEGRAM_ENABLED/TEST_TDLIB_ENABLED allowlists as the orchestrator if
  /wresume will re-enable an opt-in outbound workflow. Otherwise resume fails
  closed. It is safe to /wpause or /wstop without enabling outbound.
- The API is localhost only and has no remote authentication. Neither live
  Telegram test channel becomes unrestricted. No LLM contact decisions,
  payment or calling capability is added.
- A paused mock owner question may still be delivered by the separate owner
  notification worker; pause affects orchestration and agent messages, not
  existing owner notification traffic.
- Integration tests simulate network and Telegram commands. Real-account
  testing is not claimed.

See [P1-LLM-EVIDENCE.md](P1-LLM-EVIDENCE.md) for previous slice details.

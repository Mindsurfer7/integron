# P1 slice 2 — PostgreSQL durable task orchestrator

**Status:** executable asynchronous mock pipeline. This is not a production autonomous agent. External organizations, LLMs, calls and outbound text are **not** connected.

## Architecture
- WorkflowRun in PostgreSQL stores goal, stage, durable plan, state, next runnable time, lease token, retries, and preallocated clarification UUID.
- WorkflowEvent is an append-only audit of steps and retries.
- One tick processes one stage: queued/plan -> running/collect -> waiting_owner -> completed/cancelled.
- Collect is a deterministic simulation using 3 fixture organizations. It creates the existing DemoTask + owner clarification + notification in one DB transaction. UUIDs are allocated **before** execution, so an interrupted collect can retry without duplicate tasks/questions.
- Owner replies arrive by the existing Telegram worker or local web UI. The orchestrator polls the related persisted DemoTask and resumes the right workflow. It does not guess which question the reply belongs to.
- Claim uses atomic updateMany compare-and-swap on a 30s lease; expired claims can be reclaimed. Step writes require the current lease token. Failure retries with capped exponential delay (5 attempts) and a sanitized error type, no raw provider payload.
- Cancellation stops the related mock task and closes its pending question. Question expiry continues to fail closed.
- Because **only internal mock steps** are implemented, retries are safe. Future real external send/call steps MUST use an outbox plus reconciliation/unknown outcome, not blindly repeat on expired leases.

## Run on Mac/Linux

Keep the existing PostgreSQL + API + Telegram setup in [P1-TELEGRAM-HITL.md](P1-TELEGRAM-HITL.md). Apply the latest migration and generate Prisma Client:

    pnpm install
    pnpm db:generate
    pnpm db:deploy
    pnpm dev:postgres

Then in another terminal with the same DATABASE_URL:

    pnpm dev:orchestrator

Optionally, in a third terminal set Telegram credentials and run:

    pnpm dev:telegram

No VPS needed; no Telegram credentials needed just to run the orchestrator. New "Долгие поручения" UI appears only in PostgreSQL mode. The original immediate web demo and SQLite flow remain unchanged. If Telegram is disabled, reply through the linked mock task in the web UI. If the orchestrator is disabled, jobs stay queued; restarting it resumes.

## Local API (loopback only)

- POST /api/workflows with JSON { "goal": "Сравни три предложения" } returns 201 and a queued workflow.
- GET /api/workflows lists latest 100 runs with audit events.
- GET /api/workflows/:id returns the saved run.
- POST /api/workflows/:id/stop stops the workflow. Already terminal runs are returned unchanged.
- The linked mock task is visible through GET /api/tasks/:id and can receive /answer or /stop through the existing routes.

## Acceptance and limits

Integration tests cover restart, idempotent collect after crash, lease expiry, stop before/after creating a question and late answer rejection; CI uses disposable PostgreSQL. Multi-worker *orchestrator* leases are supported, but **Telegram getUpdates polling remains single-worker**. A lease alone is not exactly-once delivery of external effects.

Remaining P1 work: normalized external messages/facts/evidence, richer plans, approval policies, pause/resume, reconciliation UX, production API security and load/chaos tests. Existing ROADMAP checkboxes are not automatically marked complete by this slice.


## Slice 3 — read-only research fields and source-linked facts

Research planning can now be supplied by an opt-in OpenAI structured-output planner, but the deterministic mock is the default. All proposals are validated and have no action/recipient authority. WorkflowFact keeps tentative facts with exact source spans and saves them atomically with completion. See [P1-LLM-EVIDENCE.md](P1-LLM-EVIDENCE.md).

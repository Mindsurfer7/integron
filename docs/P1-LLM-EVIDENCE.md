# P1 slice 3 — explicit LLM research planning and cited facts

**Status:** code plus offline and PostgreSQL tests, not an autonomous multi-company agent.
**Default remains OFFLINE:** the planner uses a deterministic mock. No LLM API call
occurs unless configured explicitly on the orchestration worker.

## What this slice adds

1. A workflow always has a read-only research proposal with selected fields:
   price, availability, delivery or conditions. The mock planner derives these
   deterministically from the goal. An optional OpenAI structured-output model
   proposes the same schema. It cannot choose message recipients, transport,
   permissions, tools, payment actions or an execution step.
2. A strict validator rejects unknown fields, duplicate fields, out-of-range
   arrays, extra keys or unsafe model output. Plan/research becomes durable
   WorkflowRun.plan at the existing lease-fenced transition. Worker failures
   retry at most five times then fail; no outbound is queued on invalid plans.
3. For allowlisted Telegram test workflows only, fixed code chooses a question
   from validated research-field enums. The model's free-form rationale is NOT
   sent. The existing contact allowlist, single outbox and unknown-send protection
   remain enforced by separate code.
4. A reply is stored in TextMessage as before; on process_external, the system
   extracts only literal quoted text with a source offset and message ID into
   WorkflowFact. Fields currently supported are price, availability and delivery.
   All are tentative **third-party reports**, never verified facts. Facts and
   completion are saved in the same DB transaction and fenced by the lease,
   so restart/stop cannot produce an uncited completed report.
5. The workflow list/detail API now includes facts and UI shows the source quote
   and Telegram provider message ID; no additional external messages are sent.
   This also fixes the TDLib Web UI selector's missing target Chat ID submission.

## Local run

Run the existing PostgreSQL migrations and worker:

    pnpm install
    pnpm db:generate
    pnpm db:deploy
    pnpm dev:postgres
    pnpm dev:orchestrator

LLM is disabled by default; the mock planner requires no keys. For actual paid
OpenAI planning only, opt-in on the **orchestrator process** with:

    export LLM_PLANNER_PROVIDER=openai
    export LLM_PLANNER_LIVE_ENABLED=true
    export LLM_PLANNER_API_KEY='your_key_from_secret_manager'
    export LLM_PLANNER_MODEL=gpt-4o-mini
    pnpm dev:orchestrator

The owner's task description is sent to OpenAI only if opted in. Do not enter
credentials, private health information or secrets in task goals. The
provider receives only goal text; third-party replies are not forwarded to
the planner. The HTTP request is limited to 12s; malformed/refused/failed
responses are rejected and never silently promoted into action. Stored plans
contain only whitelisted research fields and a short rationale, no tokens.

There is **no** authentication for public deployment: API remains localhost
only. Keep TEST_TELEGRAM_ENABLED/TEST_TDLIB_ENABLED false except controlled
consented-chat tests, and OUTBOUND_ENABLED=false. In mock profile, no messages
can be sent. For Telegram testing, see the separate Telegram runbooks.

## Verified CI acceptance

- Offline: mock planning, schema validation, rejected injected destinations,
  OpenAI HTTP JSON-schema request shape using fake fetch, source-quote offsets,
  negative availability, no invented facts.
- PostgreSQL: durable plan fields, no altered recipient/transport, at most one
  outbox, message source linkage, restart, duplicate resilience, invalid
  model output fail-closed, stop before evidence transaction.
- Existing Fastify/demo/Telegram Bot/TDLib tests remain in CI.

## Honest limitations / what remains

- Live OpenAI API calls have not been performed in CI; prompt quality, provider
  billing, latency and privacy require an owner-run test. This is a constrained
  planner, **not** multi-step autonomous discovery or execution.
- Extractor is deliberately conservative and supports only explicit text
  patterns and currencies. It may miss Vietnamese, English variants, numbers,
  comparative prices, complex availability and time ranges. Ambiguous source
  data is not inferred. No verified/conflicting-fact adjudication yet.
- No live multi-contact research, real account E2E, dynamic actions, follow-up,
  approvals for financial actions, budget/cost enforcement, production auth,
  rich HITL, pause/resume or voice.
- A crash after a paid planner API request but before committing its plan may
  repeat an LLM request during retry. No exactly-once cost guarantee;
  production requires budget accounting and plan-request reconciliation.
- This intentionally does NOT mark all of P1.1–P1.7 fully complete.

Next: rich persisted facts/approval semantics, pause/resume and cost caps, then
integrate the independently developed WhatsApp P2.3 slice if CI is successful.

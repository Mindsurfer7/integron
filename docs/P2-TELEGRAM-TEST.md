# P2 first integration — consented Telegram BOT test transport

**Status:** code is wired for sending and receiving *real Telegram bot text messages*, but live end-to-end with two owned test accounts has **not** been verified here. Do not label Telegram USER/TDLib complete, and do not use this to contact unknown organizations. This is P2.1 foundation plus an allowlisted bot-chat integration *spike*.

## What actually happens
1. Create a workflow with transport `telegram_test` and a private numeric Chat ID on the allowlist.
2. PostgreSQL stores a deterministic plan. A separate orchestrator creates a one-message outbox for that workflow.
3. A **separate agent Telegram bot** (NOT the Telegram owner-notification bot) sends one inquiry. The test recipient must have already initiated a private conversation with that bot using /start. No first-contact to users who never started the bot.
4. The consenting test account replies **using Telegram Reply** to the outgoing message. Plain messages are intentionally ignored; the exact reply-to ID + allowed private sender/chat match a single workflow.
5. The reply text is stored as source evidence alongside the provider message IDs. A restarted orchestrator resumes and completes the same workflow. The text is **a reported statement, not independently verified price or inventory**.
6. If a send result is uncertain, it is marked `unknown` with **no automatic retry**; it requires manual inspection/reconciliation. If explicitly rejected, it is `failed`. A 24h reply timeout fails closed. Stop prevents queued sends, but cannot unsend an already in-flight request.

## Setup: local Mac / Linux, PostgreSQL required
Use `pnpm install && pnpm db:generate && pnpm db:deploy` and your existing DATABASE_URL.

Create a fresh bot through BotFather **only for the agent test channel**. It MUST be different from the token for owner notifications. On your private test Telegram account start that bot with /start, and determine your private numeric chat ID. Never commit credentials or actual IDs.

Set in **all 3 processes** (API, orchestrator and agent Telegram worker):

```sh
export TEST_TELEGRAM_ENABLED=true
export AGENT_TELEGRAM_ALLOWED_CHAT_IDS='12345678'  # replace with your own test chat ID
```

Set `AGENT_TELEGRAM_BOT_TOKEN` **only for** `pnpm dev:agent-telegram`, in its private shell or secret manager. Keep `OUTBOUND_ENABLED=false` and the original owner Telegram secret separate.

Three terminal processes (same PostgreSQL):

```sh
pnpm dev:postgres           # terminal 1
pnpm dev:orchestrator       # terminal 2
pnpm dev:agent-telegram     # terminal 3; additionally needs AGENT_TELEGRAM_BOT_TOKEN
```

In the local web UI choose **Telegram — только разрешённый тестовый чат**, enter that exact test Chat ID and create a task. Or POST /api/workflows:

```json
{"goal":"Уточни наличие у тестового собеседника","transport":"telegram_test","targetChatId":"12345678"}
```

Look at the workflow detail to see delivery state and evidence. Every outbound attempt is constrained by both the persisted target and a deterministic allowlist checked again by the worker. Max 2 private IDs; no groups, channels, cold outreach, automatic follow-ups, calls, LLM or WhatsApp/LINE.

## Failure and security contracts
- Agent bot only receives updates from private test chats; sender ID must equal chat ID. Replies must target the exact sent provider message.
- Store only necessary message body, IDs and timestamps in a local PostgreSQL database; treat external text as *untrusted data*. No LLM tool calls from it.
- The agent getUpdates poller is **single instance per agent bot**. Persistent cursor makes replay safe, but concurrent polling/offset race is not supported.
- Queued send claimed atomically. Interrupted sending older than 35 seconds becomes UNKNOWN; no automatic resend because Telegram may have accepted it.
- Network timeouts and provider 5xx are UNKNOWN; definitive 4xx are failed.
- API remains loopback only. Not safe to expose publicly without authentication and authorization.
- A stop racing with a send already in flight may still result in a delivered message. No externally visible cancellation guarantee exists once dispatch begins.
- Runtime capability registry marks this Bot API test transport **experimental**, not general Telegram USER or tested E2E.
- All integration tests use fake fetch in disposable PostgreSQL. No real message is sent from CI.

## Next: P2.2 proper Telegram USER
TDLib requires api_id / api_hash, secure per-account local session and interactive login. Implement a genuine MTProto/TDLib client behind the same TextTransportAdapter and explicit owner consent policy, then verify separate test accounts end-to-end on Mac and Linux. P2.3 WhatsApp and P2.4 LINE are further separate experiments.

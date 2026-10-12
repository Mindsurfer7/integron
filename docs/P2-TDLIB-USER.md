# P2.2 — Telegram USER via TDLib (opt-in test slice)

**Status:** implemented code and mocked TDLib/PostgreSQL integration tests. Real account authorization and live E2E on Mac/Linux were **not** performed in CI. Capability stays EXPERIMENTAL, limited to 1–2 explicitly consented private test contacts.

This uses Telegram USER/MTProto via TDLib, not Bot API. Telegram does not guarantee messaging unknown users; account privacy and anti-spam rules apply. Do not use for cold outreach.

## Design
- Separate TDLib user session in ~/.integron/tdlib-agent (native TDLib, tdl 8.1.0 and prebuilt-tdlib 1.8.65). Native files are not committed, cached inside PostgreSQL or exposed to the web API.
- New workflow transport telegram_user_test reuses existing WorkflowRun, TextDelivery and TextMessage tables, with independent TEST_TDLIB_ENABLED and TDLIB_ALLOWED_CHAT_IDS checks. No new destinations from AI/LLM.
- getMe().id must match TDLIB_AGENT_USER_ID and not represent a bot. getChat must confirm chatTypePrivate and matching user ID prior to sending. No groups, channels or mass messaging.
- TDLib sendMessage can return a **signed** temporary ID; updateMessageSendSucceeded provides a final provider ID. Only the confirmed ID is saved. Missing/pending confirmation is UNKNOWN and is **never** stored as successful (including missing sending_state). Explicit failures fail, unknown timeouts are UNKNOWN, never automatically resent.
- The consenting recipient must use Telegram Reply to the original outgoing message. Private sender, chat, reply message ID and unexpired workflow must all match. Actual text is stored as untrusted evidence; there is no automated interpretation or new outbound step.
- Streamed updates are best-effort. On restart, getChatHistory checks the most recent 100 messages in allowed private chats for awaiting workflows and deduplicates by message ID. Older replies may be missed.
- Bot API and mock workflows remain separate; each worker processes only its own outbox. The API remains localhost-only.

## macOS M1 / Linux local setup

Node.js 22.16+, pnpm, PostgreSQL, migrations:

    pnpm install
    pnpm db:generate
    pnpm db:deploy

TDLib is provided by optional dependencies tdl and prebuilt-tdlib (with platform binaries). Alternatively set absolute TDJSON_PATH to your native library.

Set in the API, orchestrator and TDLib worker:

    export TEST_TDLIB_ENABLED=true
    export TDLIB_ALLOWED_CHAT_IDS='12345678'

The ID must be an existing private contact who agreed to this test. Only 1–2 IDs are accepted. The owner and agent identities must not be in this list.

Only for the TDLib worker, supply secrets locally from https://my.telegram.org and the separate user account's own numeric ID:

    export TDLIB_API_ID='your_app_id'
    export TDLIB_API_HASH='your_32char_api_hash'
    export TDLIB_AGENT_USER_ID='your_agent_user_id'

Never paste passwords, Telegram OTP, phone numbers, session files, app hashes or full personal chat IDs into GitHub or ChatGPT. First login via interactive local terminal and enter phone/code/2FA there.

Before using real credentials, check **configuration only** (no TDLib login/network and no secrets printed):

    pnpm preflight:tdlib

For an entirely account-free smoke test on Mac/Linux:

    pnpm preflight:local
    pnpm test:tdlib:unit
    pnpm dev:demo

These commands cannot prove the native tdjson library loads, the interactive sign-in completes, or that a real test recipient receives a message. The macOS CI smoke tests do not establish Apple Silicon native TDLib E2E.

Start three local processes with the same DATABASE_URL and matching feature flags:

    pnpm dev:postgres
    pnpm dev:orchestrator
    pnpm dev:agent-tdlib

In the browser choose Telegram USER (TDLib), enter the allowlisted chat ID, and create a task. Equivalent local API request:

    POST /api/workflows
    {"goal":"Уточни наличие у тестового собеседника","transport":"telegram_user_test","targetChatId":"12345678"}

The test recipient must Reply to the outgoing message. Workflow detail shows delivery status, message evidence and audit. No automatic follow-up.

## Limitations and acceptance gate

- First-run authentication is interactive; unusual Telegram authentication states may require custom handler changes.
- Single TDLib worker per account; no distributed native session.
- In-flight sends cannot be undone with stop; UNKNOWN needs manual verification.
- Recovery scans only recent history; no general guaranteed event replay.
- API has no production authentication; do not expose it publicly.
- No real-account send/receive test has yet been done; do not mark fully tested. Run with two owned consenting accounts on macOS and separately on Linux before production.
- No WhatsApp, LINE, calls, LLM planner, payments or automatic recipient discovery.

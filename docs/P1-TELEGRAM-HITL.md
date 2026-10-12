# P1 slice 1 — Durable owner clarification via Telegram

**Status:** initial implementation: real **owner-only Telegram notifications** about **mock tasks** stored in PostgreSQL. No outreach to clinics/stores, no calls and no LLM. This is *not yet* the full P1 durable orchestrator.

## Supported behavior

- Creating a mock task via Fastify `dev:postgres` writes the task, clarification, and outbox row together in one PostgreSQL transaction.
- A separate worker `dev:telegram` fetches pending owner questions, sends inline Telegram buttons, and receives callbacks via Telegram `getUpdates` long polling.
- Only messages/callbacks matching **both** `OWNER_TELEGRAM_USER_ID` and `OWNER_TELEGRAM_CHAT_ID` can change anything. The bot cannot chat with organizations; its only destination is the configured owner.
- Buttons and `/answer <question-uuid> cheapest|fastest|defer` resolve a specific question. A simple text `cheapest`, `fastest`, or `defer` works when written **as a reply to the matching bot message**.
- `/status` shows up to five pending questions; `/stop <task-uuid>` cancels a task. The same demo task is also manageable in its localhost browser UI.
- Expiration defaults to 24 hours. A missed deadline cancels the mock task, but **cannot authorize an action**. We never silently choose an option.
- Telegram polling offset is persisted. Delivery outbox state is persisted. Duplicate callback is acknowledged but does not apply a second answer.
- A network send with uncertain result becomes `unknown`, **not automatically retried** after crash/restart, avoiding duplicate owner messages. The pending clarification is still accessible via the browser UI or `/answer` command.
- Reconcile/repair of uncertain notifications is deliberately manual in this slice. Multiple simultaneous poller instances per database are **not supported** until distributed locking is implemented.

## Start (macOS or Linux, no VPS required)

Node.js 22.16+, pnpm; Postgres 16+ installed locally or started with OrbStack/Docker.

```bash
corepack enable
pnpm install
docker compose -f infra/compose/local-postgres.yml up -d
export DATABASE_URL='postgresql://integron:integron_dev_only@127.0.0.1:5432/integron?schema=public'
pnpm db:generate
pnpm db:deploy
pnpm dev:postgres  # terminal 1, local UI http://127.0.0.1:4317
```

In another terminal, with the *same* `DATABASE_URL`:

```bash
export TELEGRAM_BOT_TOKEN='from-BotFather'
export OWNER_TELEGRAM_USER_ID='your-numeric-user-id'
export OWNER_TELEGRAM_CHAT_ID='your-private-chat-id'
pnpm dev:telegram  # terminal 2
```

**Do not put the token or numeric IDs into public issues, GitHub files, commits, screenshots or ChatGPT messages.** Create a **separate notification bot** with BotFather and open it once in Telegram, then press Start / send `/start` before expecting notifications. IDs must belong to your own conversation. If a Telegram webhook is already configured for the bot, disable it *through the official Telegram management route* before using polling; don't run two pollers.

Create a mock task in the browser. It will create a pending question with buttons in your Telegram conversation. Click a choice. Refresh the browser — the correct mock task will be completed with matching evidence. The phone number, WhatsApp, LINE or real organization are not touched.

For tests on **disposable** PostgreSQL database (the test deletes mock tasks and the polling cursor):

```bash
pnpm test
pnpm test:postgres
```

CI has an ephemeral Postgres job and runs integration tests. No Telegram API request is sent by tests; they inject a fake fetch implementation.

## Security and remaining gaps

- API still listens on `127.0.0.1`; there is **no public access or authentication**. Exposing it directly is not supported.
- Caller identity is validated using numeric Telegram user ID *and* chat ID. Third-party forwarded messages are rejected.
- The token is never stored in the DB or Git. Worker redacts errors instead of logging token-containing URLs.
- WhatsApp/LINE notification failover is **not** implemented.
- Polling has a persistent offset and handles replays safely, but supports **one worker** only.
- General task queue, event ingestion, action planning, durable long-running call state, bounded voice-wait, cost budgets, real external research, and live integration remain P1/P2/P3.
- Owner clarification and outbox are new normalized tables; P0 `DemoTask` remains a JSON mock object. A later migration will normalize operational entities.
- The outbox ensures no *automatic* duplicate sends after uncertain network outcomes; it cannot guarantee an exactly-once delivery result from Telegram.

## Acceptance

1. UI creates two tasks; Telegram sends two distinct questions.
2. Reply to task A does not mutate task B; unknown Telegram user/chat does nothing.
3. Duplicate callbacks do not create duplicate decisions.
4. Restart API/worker before answer; outstanding question and the Telegram update cursor persist.
5. Uncertain send is not retried; UI remains usable.
6. Expired question cannot be answered, and task is cancelled by worker.
7. `/stop <taskId>` cancels a task.
8. `dev:demo` and `dev:local` still work without Telegram or Postgres.

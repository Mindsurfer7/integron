# Integron

Персональный AI-оператор для обращений к организациям: поиск контактов, уточнение цен и наличия по сообщениям и телефону, отчёт с источниками. **Текущий код — безопасная симуляция:** LLM, реальные звонки, WhatsApp, LINE и Telegram ещё не подключены.

## Быстрый локальный запуск (без VPS)

Node.js 22.16+, macOS Apple Silicon или Linux:

```bash
corepack enable
pnpm install
pnpm dev:demo       # RAM; http://127.0.0.1:4317
pnpm dev:local      # SQLite ~/.integron/tasks.sqlite
```

Поручение создаёт три вымышленных ответа и вопрос владельцу в веб-интерфейсе. Результат в режиме SQLite переживает перезапуск. Реальные исходящие сообщения и звонки запрещены.

## Fastify и PostgreSQL — дополнительный runtime

```bash
pnpm dev:api:demo   # Fastify + RAM
pnpm dev:api:local  # Fastify + SQLite
```

Чтобы проверить постоянное хранение в PostgreSQL на Mac без аренды сервера:

```bash
docker compose -f infra/compose/local-postgres.yml up -d
export DATABASE_URL='postgresql://integron:integron_dev_only@127.0.0.1:5432/integron?schema=public'
pnpm db:generate
pnpm db:deploy
pnpm dev:postgres
```

Тесты: `pnpm test`; `pnpm test:postgres` — **только на отдельной тестовой БД**: он удаляет строки mock-задач. Порт API привязан к `127.0.0.1`; доступ в интернет без аутентификации запрещён.

## Документация

- [План P0–P7](docs/ROADMAP.md)
- [Архитектура](docs/ARCHITECTURE.md)
- [Уточнения у владельца во время звонка](docs/HUMAN-IN-THE-LOOP.md)
- [Поддержка платформ](docs/PLATFORMS.md)
- [Инструкция для Mac и VPS](docs/RUNBOOK.md)
- [Демо](docs/P0-FIRST-SLICE.md)
- [SQLite](docs/P0-PERSISTENCE.md)
- [Fastify + PostgreSQL](docs/P0-FASTIFY-POSTGRES.md)
- [Telegram HITL (P1 slice)](docs/P1-TELEGRAM-HITL.md)

Никаких платных записей, платежей или предоставления личных данных без явного согласования с владельцем.


## Асинхронный оркестратор (P1, PostgreSQL)

После pnpm db:generate && pnpm db:deploy запустите pnpm dev:postgres и в отдельном терминале pnpm dev:orchestrator. На веб-странице откроется очередь «Долгие поручения» с состояниями, журналом и остановкой. Для кнопок владельцу можно дополнительно запустить pnpm dev:telegram с секретами, установленными локально. Всё ещё **mock** — никакие организации не получают сообщений. См. [docs/P1-ORCHESTRATOR.md](docs/P1-ORCHESTRATOR.md).


## P2 — тестовый Telegram-адаптер (с реальными сообщениями только для allowlist)

В PostgreSQL-профиле можно подключить отдельного Telegram Bot API агента, который общается исключительно с одним-двумя своими тестовыми private чатами после /start. Требуются отдельный BotFather-токен и явный TEST_TELEGRAM_ENABLED=true. Bot API не заменяет Telegram USER/TDLib и не может инициировать сообщение произвольной организации. Инструкция: [docs/P2-TELEGRAM-TEST.md](docs/P2-TELEGRAM-TEST.md).


## Telegram USER TDLib (P2.2 experimental)

Added opt-in, private 1–2 test-chat workflow through native TDLib. Real interactive account login and a working native tdjson library are required. CLI: pnpm dev:agent-tdlib. Existing bot and mock flows remain separate. Full setup and limitations: [docs/P2-TDLIB-USER.md](docs/P2-TDLIB-USER.md). No real-account E2E confirmed yet.


## P2.2 offline verification and P2.3 research (no personal credentials)

```sh
pnpm preflight:local         # no Docker/Telegram account required
pnpm test:tdlib:unit        # mocked TDLib, no native lib/network
pnpm test                   # RAM/SQLite + TDLib offline tests
pnpm dev:demo               # purely simulated local UI
```

For the opt-in Telegram USER worker, configure real credentials **only on your own Mac** and run `pnpm preflight:tdlib` before starting the worker. It validates configuration without logging secrets or initiating login. Successful preflight is **not** evidence that a TDLib native login/real message works. See [TDLib instructions](docs/P2-TDLIB-USER.md).

P2.3 WhatsApp USER has a [research and local E2E gate](docs/P2-3-WHATSAPP-SPIKE.md), **not** an active adapter; no QR pairing or WhatsApp sends are enabled. A macOS CI job checks the credential-free TDLib unit tests, not real native ARM integration.


## P1 — safe LLM planner + cited facts

PostgreSQL workflow planning now has offline research fields by default, with explicit worker-only OpenAI opt-in. Incoming text produces conservative source-linked, **tentative** price/availability/delivery facts. These do not authorize any new recipient/action or constitute verified prices. [Details and setup](docs/P1-LLM-EVIDENCE.md).

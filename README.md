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

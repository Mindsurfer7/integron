# P0 slice 1 — локальный демонстрационный прототип

**Статус:** первая работающая часть P0, не весь P0.

## Уже реализовано

- Монорепозиторий с pnpm workspace и пакетами `core`, `fixtures`, `transports`, `llm`, приложениями `api` и `web` (неиспользуемый worker остаётся в плане).
- Node.js 22.16+ с TypeScript type-stripping, без сторонних runtime-зависимостей.
- Локальный веб-сервер только на `127.0.0.1`; профиль `demo`; любые реальные исходящие действия заблокированы.
- Сквозной сценарий: создать поручение → симулировать ответы трёх **вымышленных** организаций → уточнить предпочтение владельца в веб-интерфейсе → выбрать самое дешёвое/быстрое или отложить выбор.
- У вопросов случайный ID; неправильный ID не влияет на другую задачу; после stop/ответа повторное действие отклоняется.
- Источники фактов честно помечены `fixture:...` и `mock`.
- Шесть unit-тестов и smoke CI job.

## Запуск на Mac и Linux

Требуется Node.js **22.16+**. Не нужны сервер, Docker, SIM, Telegram, WhatsApp, LINE, LLM API keys или платежи.

```bash
corepack enable
pnpm install
pnpm dev:demo
# Открыть http://127.0.0.1:4317
pnpm test
```

Можно без pnpm:

```bash
node --experimental-strip-types apps/api/src/server.ts
node --experimental-strip-types --test tests/*.test.ts
```

В Node 22 type-stripping может выводить ExperimentalWarning — для этого slice нормально.

`PORT=4400 pnpm dev:demo` меняет порт. `RUNTIME_PROFILE` кроме `demo` и `OUTBOUND_ENABLED` кроме `false` вызывают отказ запуска.

## Проверки

- Шесть unit-тестов прошли на Node 22.16 в локальном тестовом окружении.
- Проверен HTTP smoke: `GET /health` → `POST /api/tasks` → `POST /api/tasks/:id/answer` → завершение; а также `POST /api/tasks/:id/stop`.
- Нужна отдельная проверка на macOS Apple Silicon после checkout; GitHub Actions также должна подтвердить выполнение.
- Сервер хранит данные **только в RAM**: рестарт очищает задачи.

## Пока не реализовано (следующие slices)

- Fastify, полноценный контракт API и API integration tests.
- PostgreSQL/Prisma, durable worker, сохранение задач и событий после рестартов.
- Typecheck/lint/format/secret scan CI, lockfile; P0.1/P0.6 ещё не закрыты целиком.
- Настоящая LLM, Telegram-уведомления владельцу, звонки и аккаунты WhatsApp/LINE.

Это **не** телеграм-бот и **не** автономный AI-агент: пока только безопасная имитация базового workflow.

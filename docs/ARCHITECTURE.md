# Архитектура Integron — техническое ТЗ

**Статус:** proposed; реализация не начата. Документ фиксирует границы модулей, долгоживущие задачи и работу на macOS и Linux VPS из одной кодовой базы.

## 1. Система

```text
Owner / Web UI / Telegram Bot / later WhatsApp owner channel
            | questions, approvals, commands
            v
Fastify API / authentication / audit / SSE
            |
Durable Task Orchestrator <--> Postgres / outbox / queue
     |          |                  |
 Research   Messaging workers   Voice worker
                |                  |
          Transport registry   LiveKit/Voice engine
             /   |   \          /       |         \
          TDLib WA UI LINE    SIP/PSTN  WA Web    LINE device
                                 |
                           HITL / owner notifications
```

Агент предлагает `ActionIntent`; **policy engine** разрешает или отвергает конкретный вызов; адаптер исполняет действие; ingest привязывает результат к исходному поручению. Сообщения посторонних являются данными, но никогда источником новых разрешений.

## 2. Предлагаемая структура монорепозитория

```text
apps/api/           REST, webhooks, auth
apps/web/           задания, диалоги, подтверждения, отчёты
apps/worker/        durable orchestration and retries
packages/domain/    типы, состояния, политика, проверка фактов
packages/transports/ Telegram, WhatsApp, LINE, PSTN adapters
packages/voice/     voice sessions, SIP, platform audio bridges
packages/notifications/ Telegram owner bot; WhatsApp later
packages/providers/ LLM, STT, TTS, research
packages/storage/   Postgres/Prisma, transactional outbox
packages/fixtures/  mock conversations and audio
infra/              local/server/hybrid manifests
```

Node.js LTS, TypeScript strict, pnpm, Fastify, PostgreSQL/Prisma. Начинаем с PostgreSQL job queue (например pg-boss); Temporal — только после необходимости. Избегаем микросервисов до получения рабочих коммуникационных адаптеров.

## 3. Контракты

```ts
type Runtime = 'demo' | 'local' | 'server' | 'hybrid';
type Channel = 'telegram' | 'whatsapp' | 'line' | 'pstn' | 'zalo';
type Capability = 'text.send' | 'text.receive' | 'voice.outbound' | 'voice.inbound';
type Support = 'tested' | 'experimental' | 'unavailable';
type ActionStatus = 'queued' | 'attempting' | 'sent' | 'failed' | 'unknown';
interface ActionIntent {
  id: string; taskId: string; contactId: string; identityId: string;
  capability: Capability; risk: 'low' | 'requires-approval' | 'prohibited';
  idempotencyKey: string; summary: string;
}
interface TransportAdapter {
  capabilities(runtime: Runtime, identityId: string): Promise<Record<Capability, Support>>;
  health(identityId: string): Promise<{ready: boolean; reason?: string}>;
  sendText(intent: ActionIntent, text: string): Promise<
    {status: 'sent'; externalId: string} |
    {status: 'failed' | 'unknown'; reason: string}>;
}
interface VoiceAdapter {
  startCall(intent: ActionIntent): Promise<{callId: string; state: string}>;
  endCall(callId: string): Promise<void>;
  // Audio streams and provider-specific callbacks live in dedicated bridges.
}
```

Не пытаться использовать `TransportAdapter.sendText` для звонков; поддержка звонков определяется отдельно. `unknown` после сетевого сбоя не означает, что отправки не было: требуется reconciliation, а не слепая повторная отправка.

## 4. Данные

Предварительные таблицы: `tasks`, `task_targets`, `organizations`, `contacts`, `identities`, `conversations`, `messages`, `calls`, `transcript_segments`, `facts`, `evidence_links`, `clarifications`, `approvals`, `audit_events`, `action_outbox`, `inbound_dedupe`, `job_leases`, `budgets`.

- Task хранит цель, разрешённый scope, дедлайн, бюджет, статус, контактные цели и предпочтения владельца.
- Conversation связывает task + recipient + канал + identity; сообщения хранят внешние ID, время, направление и исходник.
- Call хранит id провайдера, момент ответа/завершения, расходы, аудиосостояние и привязанные уточнения.
- Clarification связывает `taskId`, `callId?`, `questionId`, `ownerUserId`, `ownerMessageId`, срок жизни, состояние и результат.
- Evidence хранит точный источник каждого факта, время получения и статус `confirmed/tentative/conflicting/unknown`.
- Аудит фиксирует: кто действовал, что было разрешено, к какому адресату, итог попытки — без секретов.

## 5. Конечные автоматы

```text
Task: CREATED -> PLANNING -> RUNNING -> WAITING_EXTERNAL/WAITING_OWNER
        -> RUNNING -> COMPLETED/PARTIAL/FAILED/CANCELLED
Call: CREATED -> DIALING -> RINGING -> CONNECTED -> ENDING -> ENDED
                           |             |-> AWAITING_OWNER (overlay)
                           +-> REJECTED / NO_ANSWER / UNKNOWN / FAILED
Clarification: DRAFT -> SENT -> ANSWERED/EXPIRED/CANCELLED
Action: QUEUED -> RESERVED -> ATTEMPTING -> SENT/FAILED/UNKNOWN
```

Сохранять state **до** внешнего действия, обрабатывать повторные входящие events по уникальному ключу, после рестарта восстанавливать ожидания и незавершённые задания. Никаких необоснованных обещаний exactly-once доставки в сторонних мессенджерах.

## 6. Human-in-the-loop

См. [HUMAN-IN-THE-LOOP.md](HUMAN-IN-THE-LOOP.md). При активном звонке отдельный realtime worker задаёт адресный вопрос владельцу через Telegram Bot API, ждёт bounded interval, затем продолжает тот же разговор, если ответ пришёл и звонок активен. При таймауте сообщает собеседнику об уточнении позже, ставит follow-up. Два параллельных звонка не могут использовать ответ друг друга. Обработка `/stop`, двойных callback и просроченных ответов обязательна.

## 7. Политика и безопасность

- По умолчанию разрешены только безопасные информационные запросы по явному поручению: цены, доступность, часы, условия. Покупки, оплата, платная запись и передача персональных/медицинских документов требуют явного подтверждения.
- Под запретом по умолчанию массовые непрошеные рассылки, угадывание номеров, обход антибот-мер и выдача агента за человека.
- Использовать отдельные agent-outbound и owner-notification identities; хранить браузерные профили/сессии изолированно.
- Секреты в Keychain/secret manager; без cookies, токенов, логов и реальных персональных данных в Git.
- `OUTBOUND_ENABLED=false` в demo; адреса и номера в allowlist для первых реальных тестов.
- UI на localhost по умолчанию; при размещении в интернет — HTTPS, auth, CSRF для writes; raw call recording выключена по умолчанию и включается лишь при законных основаниях.
- Внешние сайты/сообщения недоверенные: prompt injection не может добавлять инструменты или повышать разрешения.
- Лимиты: contacts/task, messages/contact, calls/task, minutes/call, cost/task, daily budget, quiet hours; аварийный stop.

## 8. Портативность

Общий код: workflow, DB, policy, HITL, LLM gateway, извлечение фактов, UI. Различия: запуск графического браузера, микрофон/динамики, SIP, hardware Android.

- **demo:** in-memory fake adapters, сценарии без Docker, логинов и платного API.
- **local/macOS:** headed Playwright, Postgres через Docker/OrbStack или локальную установку, интерактивный QR-login, PSTN по интернету; Mac может работать как самостоятельный оператор без VPS.
- **server/Linux:** browser/Xvfb/PipeWire или PulseAudio, persistent profile volume, защищённые вебхуки, мониторинг.
- **hybrid:** local или server core + физический Android (для некоторых LINE call paths), ADB/Appium и проверенный двухсторонний audio bridge.

Capability registry возвращает `unavailable`, когда функция не проверена в конкретной среде. Оркестратор выбирает fallback message/PSTN, а не молча запускает неподдерживаемый звонок.

## 9. Наблюдаемость и ADR

Метрики: успешные контакты, подтверждённые ответы, время ожидания, AI/audio/phone cost, latency STT+LLM+TTS, error/hangup reason, HITL response times; correlation IDs на всех уровнях, маскирование PII.

Перед реализацией создаются ADR/spikes для: WhatsApp Web outbound calling, текстовых Baileys/WAHA vs браузер, LINE desktop/main-device rules, двустороннего Android аудио, SIP-провайдера, голосового realtime движка и выбора долгоживущей очереди.

Статус experimental не переводится в tested по одному успешному клику: нужны реальный двусторонний разговор, корректные состояния, тест на рестарт и teardown.

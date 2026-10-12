# Integron — подробный roadmap

**Версия:** 2026-10-12. **Статус:** поэтапная частичная реализация; чекбоксы ниже обозначают **полную приёмку**, а не наличие первого рабочего slice.

## 1. Продуктовая цель

Владелец формулирует поручение: «Найди три магазина с нужной моделью, уточни наличие, точную стоимость, сроки доставки». Агент находит публичные контакты, исследует сайты, пишет в доступные каналы или звонит, собирает структурированные ответы с доказательствами и возвращает сравнение. Через несколько часов или дней новые ответы обрабатываются в исходной задаче.

При неоднозначном выборе во время звонка агент отправляет **адресный** вопрос владельцу в Telegram/WhatsApp. После ответа он продолжает **тот же** разговор, если он ещё идёт. Если ждать нельзя — корректно просит разрешения уточнить позже, завершает/продолжает разговор и создаёт follow-up, а не зависает.

### Обязательные условия

- **Одна кодовая база:** `demo` (моки, без серверов/аккаунтов), `local` (Mac), `server` (Linux VPS), `hybrid` (сервер + физический Android). Два первых сценария тестирования — **без аренды VPS**.
- Собственные, отдельные идентичности агента в WhatsApp/LINE/Telegram. Отдельно — канал уведомления владельцу. Идентичность для исходящих запросов нельзя случайно использовать для ответа самому себе.
- Сообщения + голос, маршрутизация по реальным возможностям конкретного аккаунта/клиента.
- Персистентные задачи, источники фактов, история действий, ограничение затрат, стоп-кнопка.
- Лимиты числа адресатов/попыток, безопасное поведение при неудачных отправках и невыполненных согласованиях.
- Публичный репозиторий не должен содержать пароли, токены, cookies, сессии, номера и реальные транскрипты.

### MVP / не-MVP

**MVP:** один владелец; задачи по 2–5 организациям; текстовые запросы; Telegram HITL; отчёт с подтверждениями; затем один стабильный голосовой канал (PSTN). Наличие канала определяется capability-моделью.

**Не MVP:** платежи, платные записи без подтверждения, массовый холодный outreach, универсальный агент с произвольными ОС-правами, мультиарендность, Kubernetes, обучение своих моделей, собственная телефония с SIM-шлюзом.

## Текущий прогресс — 12 октября 2026

- **P0:** local demo + SQLite + Fastify/PostgreSQL реализованы отдельными итерациями; полный P0 (строгая типизация, секрет-сканер, полноценный CI на macOS) ещё не закрыт.
- **P1 (частично):** PostgreSQL теперь транзакционно хранит mock-вопросы и notification outbox. Отдельный Telegram-worker отправляет их проверенному владельцу, принимает ответы по UUID, сохраняет polling offset и не повторяет неоднозначную отправку автоматически. См. [P1-TELEGRAM-HITL.md](P1-TELEGRAM-HITL.md).
- **P1 (добавлен slice 2):** самостоятельная PostgreSQL-очередь WorkflowRun с жизненным циклом plan → collect(mock) → wait owner → resume, lease и retries, аудит WorkflowEvent, UI/API. См. [P1-ORCHESTRATOR.md](P1-ORCHESTRATOR.md). Реальный планировщик LLM, нормализованные сообщения/факты, reconcile внешних side effects, пауза/возобновление и production-security остаются впереди. Telegram и оркестратор пока работают **только на симуляции**, реальные звонки и outreach выключены.

- **P2 (первый узкий slice):** контракты `TextTransportAdapter`, детерминированный allowlist и Telegram **Bot API test** (только начавшие /start приватные test-чаты): отправка, нормализованные доказательства ответов, resume workflow и no-retry unknown. CI использует fake fetch; реальный E2E ещё не проверен. Это **не** Telegram USER (TDLib) и не реальная рассылка организациям. См. [P2-TELEGRAM-TEST.md](P2-TELEGRAM-TEST.md).

- **P1 (slice 3, 13 Oct 2026):** ограниченный AI-планировщик `price|availability|delivery|conditions` (mock по умолчанию; OpenAI opt-in только у worker), строгая проверка предложений, PostgreSQL `WorkflowFact` с дословными цитатами/offset/ID исходного сообщения, атомарное сохранение при завершении и просмотр в UI. Реальный AI API и межорганизационный E2E не проверялись. См. [P1-LLM-EVIDENCE.md](P1-LLM-EVIDENCE.md).

- **P1 (slice 4, 13 Oct 2026):** pause/resume/stop для WorkflowRun через API, UI и авторизованного owner Telegram bot. Очередь сообщений не сбрасывается при паузе; replies во время паузы сохраняются и обрабатываются после resume. Проверки race/stop/queued-send — PostgreSQL tests. [P1-WORKFLOW-CONTROLS.md](P1-WORKFLOW-CONTROLS.md).

## 2. Этапы и зависимости

**Критический путь:** P0 → P1 → P2 (минимум 1 реальный text adapter) → P3 → P6. P4 и P5 — исследовательские ветки для звонков WhatsApp/LINE, не блокируют пользу проекта. P7 — развитие. Везде ниже статус `[ ]` означает запланировано, не выполнено.

### P0 — Основа и локальный demo (первым)

- [ ] **P0.1** pnpm/TypeScript strict monorepo: `apps/api`, `apps/web`, `apps/worker`, `packages/core`, `packages/transports`, `packages/llm`, `packages/fixtures`.
- [ ] **P0.2** Fastify + контрактный API; `/health`, минимальный web UI c созданием демонстрационной задачи.
- [ ] **P0.3** `pnpm dev:demo`: scripted fake contacts, fake messaging, fake voice; работает на свежем Mac **без Docker, VPS, номера телефона, аккаунтов и API-ключей**.
- [ ] **P0.4** `docker compose up -d db` + PostgreSQL + Prisma migrations для полноценного local; `pnpm dev`, `pnpm test`.
- [ ] **P0.5** Валидируемые runtime profiles: `demo|local|server|hybrid`, feature flags на любые live side effects (по умолчанию OFF).
- [ ] **P0.6** CI: format, lint, typecheck, unit/integration tests, secrets scan; `.env.example`, `.gitignore`, README и runbook.

**Приёмка:** clone → `pnpm install && pnpm dev:demo`; с моками создаётся и выполняется задача, никакие реальные сообщения не отправляются, CI зелёный. Mac ARM не требует VPS.

### P1 — Durable Core + уведомления владельца (обязательно до живых звонков)

- [ ] **P1.1** Модели: Task, TargetOrganization, Contact, Identity, Conversation, Message, Call, Fact, Evidence, ClarificationRequest, Approval, AuditEvent, OutboxItem.
- [ ] **P1.2** State machines для task/conversation/call/clarification; PostgreSQL-backed worker (pg-boss или эквивалент); event ingestion, retries/backoff, leases, reconciliation.
- [ ] **P1.3** Telegram Bot API для владельца: `/status`, `/pause`, `/resume`, `/stop`; кнопки-варианты и свободный ответ (в reply на конкретный вопрос).
- [ ] **P1.4** HITL: корреляция `request_id`, `task_id`, `call_id`; подтверждение владельца, TTL, таймаут, неподходящие/просроченные ответы, рестарт и несколько одновременных запросов. См. `HUMAN-IN-THE-LOOP.md`.
- [ ] **P1.5** Данные/доказательства: каждое извлечённое поле связано с исходным сообщением/фрагментом транскрипта; статус `confirmed|tentative|conflicting|unknown`.
- [ ] **P1.6** Web UI: очередь задач, состояние контактов и звонков, незавершённые вопросы, история действий, расходы.
- [ ] **P1.7** Тесты: повторный webhook, гонка ответов, двойное нажатие, неверный chat_id, перезапуск во время ожидания, `/stop`.

**Приёмка:** имитация переписки с 3 компаниями -> запрос решения владельцу в Telegram -> ответ -> восстановление именно нужной задачи; после рестарта данные не теряются. Нельзя приступать к автономным звонкам без P1.

### P2 — Реальные текстовые адаптеры

- [ ] **P2.1** Общий `TextTransportAdapter`, event envelope, capability registry, health checks, rate limits, send/reconcile semantics.
- [ ] **P2.2** Telegram USER через TDLib/MTProto с отдельным аккаунтом; Bot API — только для уведомлений/других допустимых bot chat сценариев, не для произвольного первого сообщения.
- [ ] **P2.3** WhatsApp USER spike: Baileys/WAHA против UI Playwright, QR/pairing, входящие, исходящие, прикрепления, сессии, баны и переходы состояний. Выбрать за feature flag.
- [ ] **P2.4** LINE USER spike: реальная отправка/получение сообщений в доступном клиенте на Mac и Linux; при ограничениях desktop/Android fallback.
- [ ] **P2.5** Directory/contact discovery: только опубликованные или переданные владельцем контакты, дедупликация адресатов, опции follow-up/opt-out.
- [ ] **P2.6** Два тестовых аккаунта для real E2E; 1:1 диалог, восстановление, идемпотентность/unknown send outcome.

**Приёмка:** два различных текстовых канала проверены на собственных тестовых контактах; минимум один работает на Mac, затем на VPS; адаптеры, не прошедшие проверку, маркируются experimental/unavailable. Не отправлять массовые нежелательные сообщения.

### P3 — Обычная телефония + realtime voice

- [ ] **P3.1** Сравнить совместимых SIP-провайдеров (Twilio/Telnyx/местные), доступность исходящих направлений, KYC, номера/caller ID, стоимость, разрешённость автоматических звонков.
- [ ] **P3.2** LiveKit Agents (или эквивалент) с STT/LLM/TTS или realtime speech; interruption/barge-in, VAD, latency, ограничения call budget.
- [ ] **P3.3** Voice task brief: кто звонит и по чьему поручению, какой вопрос, допустимые ответы, что нельзя подтверждать без владельца; учёт языка и часового пояса организации.
- [ ] **P3.4** **HITL во время активного звонка**: вопрос -> Telegram -> owner reply -> voice agent продолжает тот же call; если ответа нет, согласование follow-up или завершение.
- [ ] **P3.5** Определение no-answer/voicemail, hangup, отказ, ошибки SIP; расходы, транскрипты, запись только при правовом основании/согласии.
- [ ] **P3.6** Тестовые добровольные звонки в Mac local runtime и Linux VPS, разные языки, минимум 10 сценариев, тест stop/timeout.

**Приёмка:** AI ведёт тестовый обычный звонок, задаёт два вопроса, запрашивает решение владельца, получает ответ и завершает звонок; запуск и с Mac (через внешний SIP), и с VPS. Сервер для звонка с Mac арендовать не требуется, но внешняя телефония/AI может быть платной.

### P4 — WhatsApp Web voice, только после технического spike

- [ ] **P4.1** Проверить, что звонки WhatsApp Web доступны конкретному связанному аккаунту/браузеру (Meta объявила Web Calling 2026-07-28 с постепенным развёртыванием).
- [ ] **P4.2** macOS Playwright persistent Chrome profile, QR linking, call state (ringing/answered/rejected/ended) с собственным тестовым номером.
- [ ] **P4.3** Двусторонний audio bridge на Mac (при необходимости BlackHole/виртуальные аудиоустройства) -> voice engine; тесты echo/crosstalk/latency.
- [ ] **P4.4** Linux VPS: headed Chromium в Xvfb с PipeWire/PulseAudio virtual sink/source, проверка voice media и реального поведения WebRTC.
- [ ] **P4.5** HITL, завершение по `/stop`, reconnect, деградация в PSTN/text.
- [ ] **P4.6** Fallback на Windows VM/Desktop — только если этот способ выдержал тесты; не обещать голос в браузере, пока audio E2E не доказан.

**Gate:** не «кнопка звонка видна», а подтверждены (a) фактический ответ, (b) звук туда-обратно, (c) 2+ реплики, (d) правильный hangup, (e) recovery. Отдельные результаты для Mac и VPS. Возможна блокировка неофициальной автоматизации.

### P5 — LINE voice и Android / Windows (сложный способ)

- [ ] **P5.1** Матрица доступности LINE на Mac, Chrome и Windows; текстовые сообщения и desktop voice ordinary contacts — отдельные эксперименты.
- [ ] **P5.2** Для звонка в LINE Official Account на практике **основное устройство**, обычно физический Android; проверить, разрешил ли получатель звонки.
- [ ] **P5.3** Android + Appium/ADB: удалённое управление и **отдельный двусторонний аудиомост** (scrcpy не гарантирует инжекцию микрофона).
- [ ] **P5.4** Эмулятор считать R&D, а не стандартным поддерживаемым окружением.
- [ ] **P5.5** Если голос невозможен — fallback LINE text или обычная телефония, capability в UI `unavailable`.

**Gate:** реальный звонок с подтверждённой двусторонней речью и корректным завершением на поддерживаемой паре клиент/получатель; иначе эксперимент закрыт без фальшивой пометки «готово».

### P6 — Мультиканальный автономный оператор

- [ ] **P6.1** Web research и сбор подтверждённых публичных контактов организации с источником/датой и проверкой назначения.
- [ ] **P6.2** Распределение запросов по каналам, quiet hours, цена/доступность, альтернативный канал после корректного таймаута.
- [ ] **P6.3** Follow-ups с лимитами, explicit stop, отказ по просьбе контакта, запрет повторного обращения к получателю, который отказался.
- [ ] **P6.4** Сравнение цен/наличия/сроков с evidence; статус неопределённых и противоречивых ответов, без выдуманных данных.
- [ ] **P6.5** Permissions: информация автономно; финансовые, договорные, конфиденциальные действия только с подтверждением.
- [ ] **P6.6** Recovery, audit, observability, cost caps, prompt injection hardening, acceptance 3–5 компаний.

**Приёмка:** задача на 3–5 организаций, 2+ доступных канала, неоднозначный вопрос владельцу, проверяемый итоговый отчёт; никакой повторной отправки при рестарте без сверки.

### P7 — Опциональные расширения

- [ ] **P7.1** WhatsApp как канал уведомлений владельцу, отдельный от рабочего WhatsApp; корректная привязка ответа к question ID.
- [ ] **P7.2** Zalo для Вьетнама: сначала текст, затем отдельное голосовое исследование, с учётом неофициальных SDK.
- [ ] **P7.3** Calendar/booking/payment только через отдельный approval policy и явные границы разрешений.
- [ ] **P7.4** Упрощение VPS-деплоя: compose, секреты, backup, мониторинг, автостарт.
- [ ] **P7.5** Temporal/multitenancy/multi-worker **по необходимости**, не до MVP.

## 3. Критерии качества всей системы

- **State:** не смешивать `queued`, `attempting`, `sent`, `delivered`, `answered`, `unknown`, `failed`; неизвестный результат исходящего звонка/сообщения нельзя слепо переисполнять.
- **Security:** входящие тексты/веб-страницы — недоверенные данные, не инструкции для вызова tools. Адресаты/внешние команды через allowlist и policy checks.
- **Audit:** у каждого отправленного контакта, цены и звонка есть источник/время; записи/transcripts выключены по умолчанию, если не соблюдены применимые требования.
- **HITL:** чужой пользователь не может одобрить действие; просроченный ответ не влияет на новый звонок; параллельные уточнения не путаются.
- **Reliability:** service restart, network loss, duplicate webhook, QR relink, cancelled call, no answer, max retries, quiet hours, max spend.
- **Compatibility:** одинаковая бизнес-логика на Mac/VPS; платформенные voice features активируются только после реальных проверок.

**Порядок разработки:** P0 и P1 нельзя пропустить. P3 можно развивать параллельно P2 после P1. WhatsApp/LINE calls — R&D с возможностью объективного «не поддерживается» и альтернативного пути.

## 4. Контрольные источники

- Meta WhatsApp Web Calling, 2026-07-28: https://about.fb.com/news/2026/07/whatsapp-web-calling-new-features/
- LINE звонки Official Accounts только с main device: https://help.line.me/line?contentId=20017541
- LINE for Chrome без звонков: https://help.line.me/line/desktop/pc?contentId=20000270&lang=en
- Telegram Bot API: https://core.telegram.org/bots/api
- TDLib: https://core.telegram.org/tdlib
- Baileys (неофициальный): https://github.com/WhiskeySockets/Baileys
- Playwright persistent profile: https://playwright.dev/docs/api/class-browsertype
- Playwright headed Linux/Xvfb: https://playwright.dev/docs/ci
- LiveKit voice + SIP: https://docs.livekit.io/agents/ и https://docs.livekit.io/telephony/

> Описанные способности мессенджеров — продуктовые гипотезы/документированные возможности платформ. Они ещё **не реализованы и не испытаны в Integron**.

## Current P2.2 implementation status (2026-10-12)

- P2.2 TDLib USER adapter and private test worker: implemented as an experimental slice.
- Native account authentication and real two-account send/reply smoke: **not tested** (requires local interactive credentials and consenting accounts).
- Full P2.2 platform coverage (Mac + VPS), unknown delivery operator reconciliation and production security: incomplete.
- See [P2-TDLIB-USER.md](P2-TDLIB-USER.md).


## Current P2.2 hardening / P2.3 spike follow-up

- [x] Credential-free TDLib unit tests cover signed temporary IDs, early/late confirmation, definitive rejection, missing sending_state (UNKNOWN), blocked chats and reply parser.
- [x] Mac/Linux local preflight script validates test flags/configuration without network or printing credentials.
- [x] macOS CI job added for credential-free TDLib contract tests; PostgreSQL integration tests retained.
- [x] P2.3 WhatsApp USER option research and risk/acceptance gate documented at [P2-3-WHATSAPP-SPIKE.md](P2-3-WHATSAPP-SPIKE.md).
- [ ] Real TDLib USER account login and two-account E2E on Mac M1 / Linux (interactive secrets and consent required).
- [ ] Actual WhatsApp USER QR pairing, live send/reply, crash recovery and permitted account validation (interactive accounts required).
- [ ] Production WhatsApp adapter (not created; feature remains unavailable).

No personal account E2E, macOS ARM native library load, or WhatsApp messages are claimed by this offline follow-up.

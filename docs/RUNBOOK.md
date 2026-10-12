# Integron — запуск локально и на VPS

**Обновление P0 (2026-10-12):** команда `pnpm dev:demo` теперь реализована в ветке P0 и проверена на Node 22.16 (Linux). Текущие mock-диалоги и вопрос владельцу доступны через локальный Web UI, **не** через Telegram. Остальные команды local/server/voice по-прежнему целевые. См. [P0-FIRST-SLICE.md](P0-FIRST-SLICE.md).

## 1. Mac / локальный demo (приоритет P0)

Для первого запуска не требуются ни VPS, ни Docker, ни SIM, ни OAuth, ни платный LLM.

```bash
git clone https://github.com/Mindsurfer7/integron.git
cd integron
corepack enable
pnpm install
pnpm dev:demo
```

Реализована локальная UI с тремя mock-организациями, перепиской и вопросом владельцу. Звонки и push-уведомления пока не реализованы. Все фейковые события явно помечены. `OUTBOUND_ENABLED=false` жестко запрещает внешние звонки и сообщения.

### macOS requirements (цель)

- Node.js LTS + Corepack/pnpm, Git.
- Apple Silicon M1 поддерживается; не закладывать Linux-only зависимости в domain.
- Для полноценного local — PostgreSQL через OrbStack/Docker Compose либо локальный Postgres.
- Для браузерной автоматизации — headed Chromium через Playwright с постоянным профилем; подтверждение QR человеком. Profile/cookies за пределами репозитория.
- Для голосовых звонков — SIP через интернет, для browser/app voice — отдельный виртуальный аудиомост после успешного spike.

```bash
# Целевой сценарий P0 (ещё не работает)
cp .env.example .env
docker compose up -d db
pnpm db:migrate
pnpm dev
pnpm test:e2e
```

## 2. Linux VPS (после работающего локального сценария)

Скрипты P7 должны запускать те же API/worker/storage, но с Linux runtime adapters. Ориентир: Docker Compose или systemd; Postgres persistent volume; отдельный браузерный sidecar с Chrome/Chromium, Xvfb, PipeWire/PulseAudio для звонков; HTTPS/Tailscale; secret store и healthchecks. Не пробрасывать базу, ADB, browser debugging port и admin UI в публичный интернет.

```bash
# Целевой интерфейс, пока документация
cp .env.example .env
docker compose -f infra/compose/server.yml up -d
pnpm health
```

Нужны: автоматическое восстановление tasks, persistent session state/owner questions, резервное копирование БД, health check на каждую identity, журнал звонков и расходов, защита от авто-повторной отправки после рестарта.

## 3. Hybrid / LINE main device

Если конкретный LINE call path работает только с основного смартфона, подключается выделенный **физический Android** с отдельной SIM/аккаунтом LINE; Appium/ADB через приватную сеть и контролируемое устройство. Android emulator не гарантирует поддержку LINE. Перед использованием подтвердить, что аудио двусторонне передаётся: захват remote speech и подача синтеза в микрофон реального звонка. Один scrcpy сам по себе не решает направление «компьютер -> микрофон Android».

Голос через LINE помечается experimental до проверенного аудиомоста; при отсутствии возможности fallback text/PSTN.

## 4. Конфигурация (предлагаемые имена)

```dotenv
RUNTIME_PROFILE=demo      # demo | local | server | hybrid
OUTBOUND_ENABLED=false
DATABASE_URL=             # only local/server
LLM_PROVIDER=mock
OWNER_TELEGRAM_USER_ID=
OWNER_TELEGRAM_CHAT_ID=
TELEGRAM_BOT_TOKEN=       # NEVER commit
MAX_CONTACTS_PER_TASK=5
MAX_MESSAGES_PER_CONTACT=3
MAX_CALLS_PER_TASK=3
MAX_CALL_MINUTES=5
MAX_TASK_COST_USD=5
CALL_HITL_WAIT_SECONDS=20
```

Все поля проходят валидацию при запуске; demo игнорирует внешние токены. Секреты — macOS Keychain либо защищённое storage/secret manager на VPS. `.env`, browser profiles, cookies, транскрипты и аудио исключены из Git. Никогда не копировать реальные номера/PII в публичный issues/CI logs.

## 5. Онбординг учётных записей

- Уведомления владельцу: Telegram Bot API. Владелец сам выполняет /start, сервер сохраняет verified user/chat ID. Добавить команду /status и сценарий /stop. Не путать этот бот с Telegram USER identity для общения с организациями.
- Telegram USER: TDLib авторизуется отдельным аккаунтом.
- WhatsApp USER: отдельный телефонный номер и QR/login session в постоянном профиле; не отдавать модели пароль/сессию в prompt. Первый живой тест строго на собственном контакте.
- LINE USER: отдельный аккаунт, логин на выбранном поддерживаемом клиенте; LINE OA звонки требуют отдельного main-device теста.
- PSTN: договор с voice/SIP провайдером; проверить тариф, caller ID/KYC, направления и требования законов. Платить и звонить только после подтверждённого профиля.

## 6. Acceptance checklist по окружениям

**Demo:** `pnpm dev:demo` после чистого клона без облачных учёток; fake task проходит полный цикл; неожиданных внешних запросов нет.

**Local Mac:** 3 параллельные задачи, внешний mock owner question через Telegram, сохранение state после рестарта, no duplicate sends, UI доступен только локально.

**Server:** clean deployment, restart/restore, TLS/auth, backups, наблюдаемость, bounded расходы; WhatsApp browser audio отдельно, не подразумевается работоспособным без spike.

**Voice/HITL:** во время звонка Telegram доставляет вопрос владельцу и привязывает ответ к правильному `callId`; на таймаут корректная фраза и follow-up; /stop завершает текущий звонок; два параллельных звонка не путаются.

## 7. Аварийные действия

- Команда /stop, UI emergency stop, либо `OUTBOUND_ENABLED=false`: отменять queued outbox и останавливать дальнейшие внешние действия, а активные звонки завершать по возможности.
- Не пытаться автоматически повторить `UNKNOWN` send/call без сверки провайдера: возможно, внешнее действие уже состоялось.
- При потере сессии аккаунта — paused identity, уведомление владельца и ручная повторная авторизация.
- При сбое callback owner — повторять доставку сообщения идемпотентно, но не придумывать за владельца решение.
- При превышении daily budget — блокировать следующие платные операции до явного разрешения.

## 8. Источники

Playwright: https://playwright.dev/docs/ci ; Telegram Bot API: https://core.telegram.org/bots/api ; LiveKit voice + SIP: https://docs.livekit.io/telephony/ ; LINE help: https://help.line.me/

> Команды здесь — **требования к будущей реализации**, а не подтверждение, что Integron уже развёрнут.

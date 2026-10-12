# Матрица каналов Integron

**Оценка на 2026-10-12.** Это исследовательские гипотезы и документы платформ, **не реализованные возможности проекта**. Перед разработкой проверять доступность в конкретной версии клиента, аккаунта и стране. Все реальные интеграции пока TODO.

| Канал | Исходящие сообщения | Входящие | Голосовые звонки | Локально на Mac | Linux VPS | Риски |
|---|---|---|---|---|---|---|
| Telegram Bot API (владельцу) | да, после /start | да | нет | да | да | проверять owner chat/user ID |
| Telegram USER/TDLib | возможны | да | отдельный сложный spike | да | да | ограничения новых диалогов, anti-spam |
| WhatsApp USER / Baileys/WAHA | экспериментально | да | не включено в text SDK | да | да | неофициальные API, ban risk |
| WhatsApp Web / Playwright | через UI | через UI | объявлены звонки Web, audio bridge не проверен | spike | spike | feature rollout, WebRTC, UI ломается |
| LINE Chrome | UI automation | UI automation | не поддерживает звонки | spike | spike | ограничения сессии и клиента |
| LINE Desktop | да, проверить | да, проверить | обычные контакты: spike | macOS app spike | Windows VM spike | часть функций зависит от типа контакта |
| LINE Official Account как получатель | проверить | проверить | OA calls только main device при включённых звонках | физический Android для call spike | hybrid Android | ADB/audio routing не решён |
| SIP/PSTN | — | — | API доступен | да, через интернет | да | KYC, стоимость, законы, страны |
| Zalo personal (позже) | неофициальный text spike | spike | отдельно исследовать | неизвестно | неизвестно | ограничения/бан |

## Порядок экспериментов

1. **Demo на Mac:** fixture contacts/messages/calls, ни внешнего сервера, ни аккаунтов, ни платного вызова.
2. **Telegram owner bot:** владелец выполняет /start, Chat ID связывается с его identity; отправка вопросов и приём команд.
3. **Telegram USER текст:** аккаунт агента отдельно; разрешённые тестовые контакты; восстановление TDLib сессии.
4. **WhatsApp текст:** browser Playwright vs Baileys/WAHA; реальные сообщения собственному тестовому аккаунту; reconnect.
5. **LINE текст:** проверить Mac desktop/Chrome, отдельно Linux; не объявлять универсальное решение до испытания.
6. **PSTN:** звонок на свой тестовый номер с Mac и с VPS через SIP; HITL при активном разговоре.
7. **WhatsApp Web voice:** проверить наличие звонков у выбранного аккаунта, виртуальное аудио Mac, затем Linux Xvfb/PipeWire; двухсторонняя речь, ring/answer/hangup; fallback PSTN/Windows VM при неудаче.
8. **LINE calls:** обычные контакты отдельно от LINE Official Account. Для OA calls потребуется main-device путь; Android emulator не является поддерживаемым решением. Не обещать звонки через Chrome.
9. **Zalo:** только после основных каналов, осторожный spike на отдельной identity.

## Capability gate

Каждый адаптер публикует `tested / experimental / unavailable` по runtime, identity и типу адресата. `voice.outbound: tested` только после верифицированного разговора: успешное соединение, двустороннее аудио, 2+ реплики, корректный teardown, таймаут, команда остановки, отсутствие повторных звонков после рестарта.

Неофициальные клиенты могут нарушать условия платформы; отдельные аккаунты ограничивают последствия, но не устраняют блокировки. Не обходить антибот-ограничения. Номера для регистрации WhatsApp/LINE и программируемая PSTN-идентичность не должны считаться взаимозаменяемыми.

## Источники для проверки непосредственно перед spike

- Telegram Bot API: https://core.telegram.org/bots/api
- TDLib: https://core.telegram.org/tdlib
- WhatsApp Web: https://web.whatsapp.com/
- Baileys: https://github.com/WhiskeySockets/Baileys
- WAHA: https://github.com/devlikeapro/waha
- LINE Developers: https://developers.line.biz/en/docs/messaging-api/overview/
- LINE help: https://help.line.me/
- Playwright: https://playwright.dev/docs/api/class-browsertype
- LiveKit Agents: https://docs.livekit.io/agents/
- LiveKit SIP: https://docs.livekit.io/telephony/

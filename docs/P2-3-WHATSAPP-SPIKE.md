# P2.3 — WhatsApp USER technical spike (no live connection)

**Status 2026-10-12:** research/architecture and test gate prepared. QR login, sending, incoming, media and restart have **not** been tested on a real account. Nothing in this milestone enables WhatsApp outbound. Do not call P2.3 completed.

## Decision for a local-first opt-in experiment

Compare three unofficial *personal account* approaches separately from Meta's official Business Platform. A personal/USER transport is **not** equivalent to the official WhatsApp Business Cloud API.

| Candidate | Local Mac | Linux | Strengths | Blocking issues |
| --- | --- | --- | --- | --- |
| **Baileys** (experimental first probe) | Node.js, no browser | Node.js | JS event API; direct websocket; connection, credential, message lifecycle APIs | Unofficial; session/key safety, protocol drift and account restrictions; no production approval |
| **WAHA** (container-based second probe) | Docker/OrbStack | Docker | HTTP/webhook boundary, multiple backends; easy to isolate from Integron core | Operational overhead and resource use; upstream changes, version/edition-specific features; still unofficial USER automation |
| **Playwright WhatsApp Web** (fallback diagnostic only) | headed persistent Chromium | headed Chromium/Xvfb | Tests UI behavior independently of an unofficial protocol SDK | Fragile selectors, browser resource use, difficult delivery semantics and session recovery |
| **Meta official Cloud API** (production alternative) | HTTP | HTTP | Official business channel, managed server API and documented lifecycle | Requires eligible business setup/recipient opt-in; does not control a regular WhatsApp USER account |

**Recommendation for an opt-in local spike:** prototype **Baileys** in an isolated, opt-in process *only after* consenting test accounts are available and the risk of account restrictions is accepted. Pin and review the dependency. Do not promote to a production USER adapter on simulated evidence. If this experiment cannot meet reliable-session / policy requirements, fall back to official Business API where feasible, or mark WhatsApp unavailable. WAHA remains the second candidate rather than adding Docker to the simplest Mac experience.

Security note: Baileys published a critical inbound message/history spoofing advisory **CVE-2026-48063**; old versions before 6.7.22 or 7.0.0-rc12 were vulnerable. A future spike must verify a patched maintained release, provenance and dependency changes before any inbound payload can be trusted. Treat vendor events, sender IDs, quoted IDs, and every message body as untrusted.

## Scope constraints (enforced before enabling any future adapter)

- [x] Research sources and compare local strategies; document a reversible choice.
- [x] No WhatsApp USER provider is registered in the production transport registry, no QR/session code installed and no outbound route is enabled.
- [ ] Separate dedicated agent identity and separately consenting 1–2 recipient accounts, never the owner-notification identity.
- [ ] Feature flag `TEST_WHATSAPP_USER_ENABLED=false` by default; per-identity recipient allowlist, private 1:1 only; explicit recipient approval, max rate, no automated contact discovery.
- [ ] Encrypted/private local session persistence outside repository (`~/.integron/whatsapp-agent/` with mode 0700), no QR/key/cookie/provider payload logging.
- [ ] Startup identity check, ready/disconnected/logged-out state machine and bounded reconnect; logout must not silently recreate a different identity.
- [ ] Outbox claim and no automatic retry when send outcome is unknown; receipt must be a final correlated provider ID, not merely a socket enqueue.
- [ ] Inbound private sender, quoted-message correlation to one nonexpired `WorkflowRun`, replay dedupe, atomic resume, stop/late reply handling.
- [ ] Mac offline unit tests + PostgreSQL fake-transport tests, then manual real two-account E2E on macOS M1 and Linux.
- [ ] Attachments/media support assessed separately; no downloads or uploads before explicit content/storage policy.
- [ ] Verify current WhatsApp policies and account suitability before any real connection. No bulk messaging, unsolicited outreach or evasion of anti-abuse controls.

## Reproducible local test sequence

### Now (no account, no outbound)
```sh
corepack enable
pnpm install
pnpm preflight:local
pnpm test
pnpm dev:demo
```
`pnpm test:tdlib:unit` separately runs the credential-free TDLib identity/correlation/send tests. The macOS CI runner also exercises this test, but does **not** prove macOS ARM native TDLib login.

### Later (only when the user provides accounts locally)
1. Run test-provider process in `local` runtime only; keep `OUTBOUND_ENABLED=false` globally and require an independent explicit opt-in flag for the isolated test route.
2. Pair a *dedicated* agent account via QR/phone on the user's own computer. Never share QR, OTP, key files or JIDs in PRs/chats.
3. Consent from 1–2 test recipients; check identity, private chat and allowlist before first send.
4. Test one outgoing text → a direct quoted reply → one corresponding workflow completed; duplicate reply and wrong chat have no effects.
5. Restart between send and reply; test reconnection, history reconciliation and de-duplication. Disconnect mid-send → `UNKNOWN` and **no automatic resend**.
6. Test stop before dispatch, expiry, logout, attachment rejection and identity mismatch. Repeat on Linux before reporting cross-platform support.
7. Preserve only synthetic test cases in GitHub. Keep a human-reviewed E2E checklist and redacted results; do not commit genuine chat content.

## Sources checked

- Baileys: https://github.com/WhiskeySockets/Baileys
- Baileys event model and history event semantics: https://github.com/WhiskeySockets/docs/blob/main/concepts/events.mdx
- Baileys security advisory: https://github.com/WhiskeySockets/Baileys/security/advisories/GHSA-qvv5-jq5g-4cgg
- WAHA overview / Docker: https://github.com/devlikeapro/waha
- Playwright persistent browser context: https://playwright.dev/docs/api/class-browsertype
- Official WhatsApp Business Platform: https://developers.facebook.com/docs/whatsapp/cloud-api

**Boundary:** no real account scan/QR, WhatsApp connection, live E2E or actual local Mac execution is claimed in this PR.

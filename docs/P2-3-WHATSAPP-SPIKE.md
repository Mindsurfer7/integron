# P2.3 — WhatsApp USER technical spike (no live connection)

**Status 2026-10-12:** opt-in Baileys personal account worker + typed adapter + mocked unit/PostgreSQL tests added. **Real QR login, actual account sends/receives, history catch-up, reconnect and media have NOT been tested.** No general outbound is enabled; only a specifically opted-in worker can connect to test contacts. P2.3 remains incomplete.

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
- [x] Experimental `whatsapp_user_test` is isolated from production/mock and Bot/TDLib routes. No WhatsApp connection or QR is initiated by demo, API or orchestrator.
- [ ] Separate dedicated agent identity and separately consenting 1–2 recipient accounts, never the owner-notification identity.
- [x] Feature flags `TEST_WHATSAPP_USER_ENABLED=false` and `WHATSAPP_LIVE_CONNECT_ENABLED=false` by default; 1–2 private JIDs in allowlist; one-minute pacing from durable gateway; no contact discovery.
- [ ] Session **encryption at rest** not yet implemented. [x] Baileys multi-file session under `~/.integron/whatsapp-agent/session`, chmod 0700 + process umask 0077, QR printed **only to local terminal** for explicit pairing, no key/provider payload logging. Single worker lock.
- [x] Identity verified at startup and before each outbound, disconnected worker stops without automatic relink. [ ] Real reconnect/logout state machine and recovery gate remain pending.
- [x] Durable outbox claim and no automatic retry when outcome unknown; receipt waits for matching Baileys server ACK (status >= 2), never only socket enqueue; mocked tests only.
- [x] Incoming notify private JID + quoted message ID, durable DB correlation, expiry/dedupe/atomic resume/stop in mocked PostgreSQL tests. [ ] Provider history replay on worker restart not implemented yet.
- [x] No-account unit and PostgreSQL fake-transport tests; CI on Linux/macOS (mocked). [ ] Manual real two-account E2E on macOS M1/Linux.
- [x] Media/attachments deliberately rejected (no download/upload). [ ] Explicit content/storage policy for future support.
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

## Implemented experimental local runner (requires own consenting accounts)

There is **no** live WhatsApp connection while using the regular `pnpm dev:demo`, `pnpm dev:postgres`, `pnpm dev:orchestrator`, `pnpm test`, or `pnpm test:postgres` commands. These can exercise test data with fake sockets only.

On a **private Mac** after consent and dedicated WhatsApp account creation, set the **same** flags and recipient JIDs in API, orchestrator and the special WhatsApp worker; keep DB local and port on loopback:
```sh
export DATABASE_URL='postgresql://integron:integron_dev_only@127.0.0.1:5432/integron?schema=public'
export TEST_WHATSAPP_USER_ENABLED=true
export WHATSAPP_AGENT_JID='77777777777@s.whatsapp.net'       # example only
export WHATSAPP_ALLOWED_JIDS='12345678901@s.whatsapp.net'    # example only
export WHATSAPP_LIVE_CONNECT_ENABLED=true
export OUTBOUND_ENABLED=false

pnpm db:generate && pnpm db:deploy
pnpm dev:postgres       # terminal 1
pnpm dev:orchestrator   # terminal 2
pnpm dev:agent-whatsapp # terminal 3, QR only here
```

**Do not use example JIDs for real operations.** UI must explicitly select `whatsapp_user_test` and one allowlisted JID. Account pairing QR is sensitive; printed in the *local terminal only*, not stored in the DB, readme, GitHub or app logs. The linked auth keys are sensitive files: protect your Mac user account and backups; the current storage is **not encrypted at rest**. Removing the device from WhatsApp Linked Devices invalidates the session. If a worker lock survives a crash, verify no other process is running before removing the lock manually. Do not run multiple workers for one account. Use only on accounts willing to risk restrictions under WhatsApp policies.

Notes: status >=2 is treated as provider SERVER_ACK, not recipient delivery or read receipt. No 100% delivery guarantee. This worker does not yet reconcile missed messages from server history after restart, so reply loss around downtime is possible. Real two-account E2E, host platform verification and ToS/account risk review gate production use.

Mocked credential-free tests:
```sh
pnpm test:whatsapp:unit
pnpm test
# in isolated test PostgreSQL only (test script clears mock/workflow tables)
pnpm test:postgres
```

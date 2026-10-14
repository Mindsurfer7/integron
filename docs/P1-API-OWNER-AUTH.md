# P1 — Single-owner localhost API authentication (2026-10-14)

## Scope

- PostgreSQL Fastify refuses startup without INTEGRON_API_TOKEN (32–256 printable ASCII characters).
- All /api/* read and write routes require a Bearer token or eight-hour random HttpOnly session cookie.
- /login form submits the token over a same-origin POST; the token is not written to browser storage or a URL. Sessions are process-local and lost on restart.
- Cookie-authenticated mutations require X-Integron-CSRF: 1, and SameSite=Strict. The loopback Host/Origin checks remain in force.
- Timing-safe SHA-256 token comparison, 256-bit opaque session IDs, bounded session memory and five failed logins per source per 15 minutes.
- RAM/SQLite demo modes continue without a password and without live external effects.
- Unit/regression coverage includes unauthorized read/write, login, logout, cookie, bearer, CSRF, invalid host/origin, duplicate cookies and rate limiting.

## Setup

Generate a unique random secret locally and set INTEGRON_API_TOKEN in the environment of the API process; for example:

    export INTEGRON_API_TOKEN="$(node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\")"
    pnpm dev:postgres

Open http://127.0.0.1:4317/login to sign in. CLI clients may send Authorization: Bearer <token>.

## Security boundaries

This is **not approval for public hosting**. Fastify still binds to 127.0.0.1 and permits only loopback Host and Origin. Remote browser access requires separately tested HTTPS ingress/proxy settings, including secure cookies, appropriate host/origin validation, secret rotation and an authorization scheme for the trusted reverse proxy. INTEGRON_COOKIE_SECURE=true merely marks cookies Secure. Do not expose a proxy to the public Internet yet.

The messenger agent accounts have **separate** TDLib phone/code/2FA or WhatsApp QR sign-in. The owner API token does not sign in to messenger providers. Native sessions/credentials must stay outside Git.

## Remaining acceptance

- [x] Locally safe owner-token and browser session entry point with regression tests.
- [ ] CI verified on this PR and merge into dev.
- [ ] Authenticated HTTPS server ingress, external rate limiting, operational secret rotation, multi-replica session store.
- [ ] Real local account sign-in and send/reply E2E on Mac with consenting test accounts.
- [ ] Live paid-action budget and provider-usage reconciliation before PSTN outbound.

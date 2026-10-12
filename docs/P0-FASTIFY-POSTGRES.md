# P0 slice 3 — Fastify API + PostgreSQL / Prisma

**Status:** initial implementation. This adds an *optional*, dependency-based API and Postgres profile. The original zero-third-party-dependency `dev:demo` and SQLite `dev:local` remain unchanged. Real communications remain disabled.

## Goals and boundaries

- A Fastify HTTP API with the same task contract as the existing Node HTTP server. For now it binds to 127.0.0.1 and checks Host/Origin; internet access requires future authentication and TLS.
- PostgreSQL 16 + Prisma for persistent simulated tasks. The `DemoTask` table is **temporary P0 mock storage**, not the normalized P1 conversations/outbox schema.
- Concurrency-safe decisions: revision-based compare-and-swap. A second or stale choice must not replace the winner.
- A local Mac still requires no VPS. Database mode needs local Postgres (Docker/OrbStack or installed PostgreSQL) and dependencies; basic demo does not.

## Quick start: Fastify, without Postgres

```bash
corepack enable
pnpm install
pnpm dev:api:demo
# http://127.0.0.1:4317
```

## Quick start: Fastify + PostgreSQL on Mac or Linux

```bash
corepack enable
pnpm install
docker compose -f infra/compose/local-postgres.yml up -d
export DATABASE_URL='postgresql://integron:integron_dev_only@127.0.0.1:5432/integron?schema=public'
pnpm db:generate
pnpm db:deploy
pnpm dev:postgres
# http://127.0.0.1:4317
```

Alternative to Docker: a local PostgreSQL 16+ installation and corresponding `DATABASE_URL`. Do not expose the example database password or Postgres port to the internet. Credentials are for loopback-only development.

## Tests

```bash
pnpm test                 # existing tests + Fastify inject tests
pnpm test:postgres        # requires DATABASE_URL and a migrated, disposable test DB
```

The Postgres test deletes `DemoTask` rows. **Use a disposable database, never production.** CI has a separate ephemeral PostgreSQL job. Migration/schema tests and proper TypeScript checking should be expanded before production.

## Upgrade and compatibility

- `dev:demo`: old Node HTTP API + RAM and no extra packages at runtime.
- `dev:local`: old Node HTTP API + SQLite, offline, no Postgres required.
- `dev:api:demo`: Fastify + RAM.
- `dev:api:local`: Fastify + SQLite.
- `dev:postgres`: Fastify + Prisma/Postgres; simulated contacts only.
- `OUTBOUND_ENABLED=true` is rejected by all profiles. No Telegram, WhatsApp, LINE, PSTN, voice or LLM is implemented here.
- Migration from SQLite to Postgres is not automatic. Existing mock tasks live in separate development stores.

## Remaining before P0/P1 completion

- Pin dependency graph in pnpm lockfile and run macOS ARM smoke.
- Normalized Postgres schema for long-running tasks, outbox, messages, clarifications and facts.
- Durable worker, transactional outbox, idempotency/reconciliation.
- Authentication before binding outside localhost; encrypted secrets.
- Telegram owner notifications after durable clarification primitives exist.

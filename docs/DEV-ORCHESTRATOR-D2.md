# D2 — Development phase graph and safe parallel work planning

**Status:** implementation under PR; automatic execution, public MCP and phase acceptance deliberately disabled. Builds on [D0/D1 ADR](DEV-ORCHESTRATOR-D0-ADR.md) and [roadmap](DEV-ORCHESTRATOR-ROADMAP.md).

## Delivered scope

1. Additive PostgreSQL models: `DevPhase`, `DevDependency` (cross-product DAG), `DevTask` (owned repository/path scopes plus coordination keys), and `DevBlocker` (explicit open/resolved). They are independent from the outreach `WorkflowRun` models.
2. Validated local JSON roadmap import for known projects/repositories. The import only creates or updates *planned* phases and tasks; it **cannot** mark phases accepted, launch agents, call GitHub write APIs, or merge PRs.
3. Transactional imports with a PostgreSQL advisory transaction lock. Full stored DAG validated for cycles before commit. Imports are additive, not destructive.
4. Deterministic, read-only priority planner with blockers for unverified prerequisites, missing or stale D1 GitHub snapshots, missing integration branches, manually recorded blockers, file/path overlaps, Prisma migration conflicts, shared coordination keys, and repository concurrency.
5. Unit tests and PostgreSQL integration tests for idempotency, cross-project edges, rollback, and safe parallelism.

## Safety and truth semantics

- A D2 decision of `ready` is a **planning suggestion**, not a reserved task, dispatch, successful CI result or merge authorization. D3/D5 must add authenticated actions, atomic leases/fencing, and reconciliation first.
- A prerequisite phase is accepted only with `state=accepted`, nonempty acceptance criteria, `acceptedAt`, and SHA-linked evidence. D2's importer cannot set any of the acceptance fields or change running-task state.
- The future D3 privileged acceptance path must independently validate evidence and repository scope. Manual editing of the database is outside D2's trust boundary.
- No assumption that a green GitHub CI means phase acceptance. D1 only observes a bounded recent set of PR/check records.
- Missing, stale or missing-branch repository observations block task readiness. Default freshness: 30 minutes. Default parallel task capacity per repo: 2.
- Paused, waiting-for-PR/CI and reviewing tasks retain their scope reservation for **planning conflict purposes**. D2 does not automatically reassign them.
- Scope collisions are conservative. Any files in the same Prisma schema/migration group conflict, and cross-repository contract changes conflict if they share a `coordinationKey`.
- Missing ownership scopes block tasks. An importer cannot include repository scopes outside the task's project.
- The example roadmap is **synthetic**. No real Flowboard/Qonbaq/Mindsurfing phase status is inferred from chat history or merged PRs.
- Roadmap import is explicitly invoked by a local operator; records omitted from a subsequent manifest are retained, so unrelated running phases are not silently deleted.

## Operator runbook

Requires Node 22.16+, PostgreSQL, installed packages and applied migrations. Set `DATABASE_URL` in local environment.

```bash
corepack enable
pnpm install
pnpm db:generate
pnpm db:deploy

# Explicitly import synthetic example only into a test database.
pnpm dev:roadmap --import docs/examples/dev-roadmap.example.json

# Read-only planning report.
pnpm dev:roadmap --plan
```

For genuine readiness reports, run D1's `pnpm dev:github:once` against the same database with a read-only GitHub token. Without recent evidence, tasks correctly appear blocked by `repository_unobserved` or `repository_stale`.

Import JSON structure: `{ "version": 1, "phases": [...] }`. Each phase has `projectSlug`, `code`, `workstream`, `title`, `acceptanceCriteria`, optional `dependsOn` and `tasks`. Each task has `key`, `title`, optional `priority`, required `scopes` with `repo` and `paths`, and optional `coordinationKeys`. Inspect [the example manifest](examples/dev-roadmap.example.json); do not treat its example phase codes as current progress.

The output includes `readyTaskIds` and decisions with `taskId`, `projectSlug`, `phaseCode`, `taskKey`, `state`, and `reasons`. No credentials, PR titles or raw GitHub payloads are included.

## D2 acceptance

- PostgreSQL migration and tests succeed.
- Cross-product DAG validates existing and imported dependencies, rejects cycles with transaction rollback.
- Repeated import is idempotent and cannot rewrite running tasks or active phase acceptance criteria.
- Missing/stale observer evidence and incomplete phase verification block scheduling.
- Concurrent work is selected deterministically with checked file, migration and contract conflicts.
- No MCP write path, GitHub write action, agent launch or auto-merge is added.

## Following stage: D3

Authenticated MCP read-only status/roadmap/blocker/available-task tools first; scoped writes, audit and exact-SHA owner approval later. Agent execution is D5 and guarded merges are D6.

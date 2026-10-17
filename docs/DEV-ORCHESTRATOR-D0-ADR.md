# ADR D0 — Development Orchestrator bounded context

**Status:** accepted for D0/D1 implementation (2026-10-18). **Integration:** separate `packages/dev` module and D1 tables, no changes to existing `WorkflowRun` lifecycle. See [DEV-ORCHESTRATOR-ROADMAP.md](DEV-ORCHESTRATOR-ROADMAP.md).

## Decision / scope

Integron manages software delivery across multiple independent products. The first implementation is **observation only**: a deliberately fixed allowlist of GitHub repositories, read-only REST polling, tamper-checked webhook receipts and PostgreSQL evidence snapshots. It does **not** create ChatGPT chats, write GitHub branches, trigger actions, deploy code or merge PRs. D2/D3 will add phase graph and scoped MCP after explicit security design.

Domain terminology: `project` = product, `repository` = one Git remote with an integration branch, `phase` = roadmap acceptance unit, `task` = atomic work scope, `session` = agent/chat participation, `artifact` = immutable evidence. D1 only persists project/repository/snapshot/webhook delivery; deferred models from D2–D6 are conceptual, not already implemented.

### Port boundaries

- **GitHubReader**: immutable repo snapshot of default branch, configured integration-branch HEAD, recently updated PRs and bounded CI metadata. A snapshot has a timestamp and `partial` flag.
- **RepositoryRegistry**: explicit `projectSlug, fullName, integrationBranch` mapping. D1 seed upserts reviewed defaults; custom tenant mapping/permissions postponed to D2.
- **SnapshotStore**: record the last successful observation. A failed request sets `stale=true` and a sanitized error code without destroying evidence.
- **WebhookReceipt**: verify HMAC-SHA256 on the raw body; allowlisted repository, delivery ID dedupe and replay detection in database. Webhook causes another remote **read**; webhook payload is never treated as authoritative state.
- **Orchestrator policy (future)**: no direct GitHub write or shell method in D1. Merge permissions require separately authenticated, scoped, exact-SHA approvals.

## Lifecycle contracts (for D2, not yet executed)

`planned -> ready -> running -> pr_open -> ci_pending -> review -> verified -> completed`. Side states: `blocked`/`paused`; terminal `failed`/`cancelled`. A phase is done only when its acceptance criteria are independently verified across every relevant repository. A merged PR is evidence of merge only, **not** proof of acceptance.

Events carry `source`, `observedAt`, `repo`, `externalId`, `SHA`, `confidence` and `verificationState`. Owner input and ChatGPT reports never supersede checked GitHub state. An operation with an unknown external outcome is reconciled, not automatically retried.

## D1 truth semantics

- Observation is recent PR metadata, **not** a complete historical PR index or comprehensive GitHub Search.
- Check runs and commit status values are reported as observed; an absent/not fetched/unfinished check is **unknown**, not green.
- D1 does not know GitHub branch-protection requirements, review policy, code correctness, integration-test acceptance, or deploy status. It cannot authorize a merge.
- Integration branch is explicit; never silently substitute `main` if `dev` is absent.
- Two pages of 100 recent PRs maximum; `partial=true` when that window is exhausted. Inspect up to 12 open PRs' latest check runs per observation; others retain `checksObserved=false`.
- Signed webhooks can be duplicated or arrive out of order. Durable receipt is idempotent; periodic refresh remains the recovery mechanism.
- Last known snapshot is retained on token expiry, rate limit, upstream outages or malformed data, but marked stale. No false current-state claims.

## Threat model

| Threat | Control |
|---|---|
| Malicious PR title / issue comment prompt injection | Store metadata as inert, untrusted text; do not execute instructions |
| Forged or replayed webhook | HMAC on original bytes; bounded payload; stable delivery ID and SHA-256 dedupe |
| Token exfiltration via redirected URL | Fixed `https://api.github.com` origin and validated repo/branch; no generic URL fetch; never print response bodies |
| Excess API quota / pagination explosion | Read-only API, max 2 PR pages, 12 CI probes, finite HTTP timeout, periodic polling |
| Incorrect green CI / missing history | Explicit check-observation flags, partial snapshots, stale errors; no automatic merge |
| Existing outreach workflow interference | Separate Prisma models and worker; no mutation of P0–P7 workflows |
| Accidental public API exposure | Webhook worker binds `127.0.0.1` only and requires a secret; no remote MCP endpoint |
| Mismatched external repository | Allowlist validated on both webhook ingress and polling |
| Crash after webhook receipt | Periodic reconciliation; delivery payload is not an executor command |

**Operational permissions:** GitHub fine-grained token with *metadata and contents/checks/pull-request read-only* access only to specified repositories. Store the token and `GITHUB_WEBHOOK_SECRET` in environment/secret manager, never in committed files. Network access to GitHub is outbound HTTPS only. Do not map this worker's loopback port directly to the internet; configure reverse proxy and IP/rate protections deliberately if webhook ingress is eventually needed.

## D1 runbook

Prerequisites: Node 22.16+, pnpm, PostgreSQL, Prisma migrations.

```bash
corepack enable
pnpm install
pnpm db:generate
pnpm db:deploy
export DATABASE_URL='postgresql://...'
export GITHUB_READ_TOKEN='...'
pnpm dev:github:once
```

`dev:github:once` loads/upserts registry and refreshes all tracked repository snapshots. It prints only totals and sanitized error codes. `dev:github:serve` additionally requires `GITHUB_WEBHOOK_SECRET` (at least 32 characters) and starts a **loopback** `POST /webhooks/github` receiver on port 4327, while polling every five minutes. The webhook must be configured to send the original unmodified request bytes and `X-Hub-Signature-256` header. In the current architecture, there is no public webhook URL; exposing one is separate infrastructure/security work.

`DEV_OBSERVER_PORT` overrides the local receiver port. `RUNTIME_PROFILE=postgres` is set by package scripts. No outbound messaging or paid calls are involved.

## D0/D1 acceptance and non-goals

| Requirement | Evidence / status |
|---|---|
| Isolated bounded context and documented trust boundaries | This ADR, `packages/dev`, dedicated Prisma models |
| Known repo registry (Qonbaq backend + mobile, Flowboard, Mindsurfing) | `registry.ts` and idempotent seed |
| Deterministic read-only REST snapshot, bounded pagination | `github.ts`, `tests/dev-observer.test.ts` |
| Signed webhook handling, no-op duplicate, collision rejection | `webhooks.ts`, `store.ts`, tests |
| Last-known-good preservation, stale error and recovery | `store.ts`, PostgreSQL integration test |
| Runtime credential provisioning and webhook reachability | **Not provided by code; operator setup required** |
| Full remote end-to-end validation against all 4 repositories | **Pending runtime credentials and post-merge smoke test** |
| Verified full phase/agent orchestration or automatic merges | **Not in D0/D1; D2–D6** |

## Compatibility

Additive Prisma migration only. Existing P0–P7 models, API endpoints, demo flow and outbound policy remain unchanged. The D1 worker does not run by default and requires explicit start. `pnpm test` runs offline contract tests; `pnpm test:postgres` covers persistence. No third-party dependency added.

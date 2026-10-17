# Development Orchestrator — architecture and roadmap

Status: D0/D1 merged to `dev`; D1 credentialed smoke acceptance still pending. D2 planner in feature-branch PR. Target: Integron `dev`. This module is independent of P2–P7 messaging and voice acceptance.

D0 architecture decision: [DEV-ORCHESTRATOR-D0-ADR.md](DEV-ORCHESTRATOR-D0-ADR.md). D2 implementation and runbook: [DEV-ORCHESTRATOR-D2.md](DEV-ORCHESTRATOR-D2.md).

## Goal

One control plane for development across Qonbaq, Flowboard, Mindsurfing and future products. Discover GitHub changes, track phase dependencies and agent sessions, identify blockers, assign independent work, check PR/CI evidence, and request owner approvals. Owner interacts through Integron MCP from ChatGPT. Do not claim access to arbitrary existing ChatGPT conversations.

## Principles and boundaries

- Separate `development` bounded context from existing customer-outreach `WorkflowRun`; reuse PostgreSQL/Prisma, durable queue/lease patterns, audit, notifications and approval principles, not customer-contact state machines.
- GitHub is authoritative for branches, commits, PR merges and CI; roadmap/acceptance criteria are authoritative for intended scope. Neither a merged PR nor a chat's self-report proves phase acceptance.
- Agent reports are untrusted assertions until checked against GitHub. Store evidence URL, repo, SHA, timestamp and provenance.
- Each project has multiple repositories and parallel workstreams. Explicit cross-repository dependencies and resource/file ownership.
- Default to read-only observation. Writing branches, dispatching agents and merging require scoped permissions, policies and audit. No direct production deploy.
- External instructions from PR text, issue comments and repository files are untrusted content, not new permissions.
- Existing ChatGPT chats can voluntarily report through MCP; do not promise automatic discovery, reading or launching of arbitrary personal chats. New managed sessions require an independently validated official API/SDK integration and suitable entitlements.
- Keep local-first deployment. Public MCP needs proper OAuth, HTTPS, least-privilege GitHub credentials, CSRF/origin validation where applicable, secret redaction and webhook signature verification.

## Logical architecture

```text
Owner ChatGPT -- MCP tools --> Integron Dev API
                                |-- Project/roadmap registry
                                |-- Dependency scheduler + conflict detector
                                |-- GitHub observer (webhooks + reconciliation polling)
                                |-- Agent session registry
                                |     |-- ChatGPT voluntary-report bridge
                                |     |-- Managed agent runner (API/SDK; gated)
                                |-- PR/CI review + merge policy
                                |-- Approval/audit + notifications
                                +-- PostgreSQL / durable jobs
```

## Data model

- `DevProject`: product, name, lifecycle, settings.
- `DevRepository`: project, owner/repo, default/integration branch, scopes, webhook cursor.
- `DevPhase`: workstream, phase code, description, acceptance criteria, state and evidence.
- `DevDependency`: directed prerequisite edge, cross-repository support; reject cycles.
- `DevTask`: actionable scope, allowed paths, branch, assignee, acceptance checklist, state.
- `DevAgentSession`: provider, external session reference, capabilities, last heartbeat, link; never store raw session credentials.
- `DevExecution`: task, attempt, lease/fencing token, idempotency key, timestamps, result.
- `DevArtifact`: PR, commit, check run, docs, release with immutable SHA/provenance.
- `DevBlocker`: type, source, owner, status, resolution.
- `DevDecision`: approval request, exact action digest, scope, actor, expiry, outcome.
- `DevEvent`: append-only normalized audit and dedupe key.

Suggested task lifecycle: planned -> ready -> running -> pr_open -> ci_pending -> review -> verified -> completed; orthogonal blocked/paused and terminal failed/cancelled. A phase completes only when all acceptance criteria have verified evidence. Never overwrite an unknown external execution outcome with success or retry it blindly.

## GitHub observer

Initial full scan then signed webhooks + periodic reconciliation (webhooks can be delayed or dropped). Collect branch heads, PR base/head and merge status, review state, check suites, failing logs metadata, commit references, issue references. Respect rate limits and ETags. Keep `observed_at`, `source_sha` and `stale` flags. A missing check is not green. For multi-repo tasks, independently confirm all relevant repos. Report discrepancies between roadmap and actual code rather than silently changing phase status.

## Dependency and scheduling policy

A task is ready only if prerequisite phases meet their acceptance gates, required repos/branches exist, no incompatible active task holds the same ownership scope, and required authorization is available. Detect overlap using declared components/files, PR changed paths, schema/migrations and shared contracts; heuristic overlap is a warning, not a proof of safety. Serialize migrations and common contract changes unless explicitly coordinated. Concurrency caps per repo and provider. Reserve scope with TTL/lease; on expiry reconcile remote agent/PR state before reassigning.

## Agent integrations

1. `ChatGPTSessionBridge`: user connects a chat to a DevTask; chat reports structured progress via MCP (`task_id`, `session_ref`, branch, PR, blockers, next steps). No arbitrary chat enumeration or guaranteed push into an existing chat.
2. `ManagedAgentRunner`: provider interface `createSession`, `startTask`, `getStatus`, `resume`, `cancel`, `getArtifacts`. Validate official provider capability before enabling; API/SDK agents are distinct from ordinary ChatGPT UI conversations. Require idempotent dispatch, cost budget, scoped GitHub permissions and external outcome reconciliation.
3. `ManualRunner`: produce a task handoff/prompt and accept an explicit session link when programmatic execution is unavailable.

## MCP surface (proposed)

Read: `integron.dev.projects`, `status`, `roadmap`, `blockers`, `available_tasks`, `sessions`, `daily_digest`.
Write: `integron.dev.report_progress`, `start_task`, `start_phase`, `pause_task`, `resume_task`, `review_pr`, `approve_merge`.
Write operations must validate project/repository permissions, identity, request idempotency and action-specific approval. Never expose arbitrary shell execution or arbitrary repository writes.

## Merge and completion gates

- PR targets explicitly configured integration branch (normally `dev`), branch protection and required checks pass at current head SHA.
- No unresolved conflicts, blocking review, unreviewed security changes or unrelated scope; required tests and migrations assessed.
- Merge authorization policy is explicit; approval tied to exact PR head/base SHA and expires on change.
- Verify merged commit and affected acceptance criteria after merge. Failed checks trigger a repair task, not infinite blind retries.

## Roadmap

| Phase | Scope | Prerequisites | Acceptance |
|---|---|---|---|
| D0 | ADR, schema/contracts, policy, state machines, acceptance examples | None | Reviewed docs, explicit threat model and no implied ChatGPT chat API |
| D1 | GitHub observer, repository/project registry, polling and webhook reconciliation | D0 | Rebuild correct PR/CI state for 3 products; replay/duplicate tests |
| D2 | Phase graph, dependency checks, blocker/conflict detection, ready queue | D1 | Cycles rejected, cross-repo dependencies, safe parallel schedule tests |
| D3 | Authenticated MCP read/write tools, audit and approvals | D1–D2 | Scoped access, prompt injection tests, end-to-end read/status and safe write |
| D4 | Existing-chat voluntary progress bridge and session registry | D3 | Chat reports task, GitHub evidence reconciled, stale report detected |
| D5 | Managed API/SDK agent runner and manual fallback | D2–D3 | One authorized agent task -> branch -> PR, safe restart/reconciliation |
| D6 | CI watchdog, guarded merge, dashboard, summaries and alerts | D2–D5 | Failing CI surfaced; no merge before required green checks and approval |

D0/D1 code has been merged; D2 planning code is under review. D4 and D5 can progress independently after shared D2–D3 contracts. D1's credentialed real-repository smoke test remains an outstanding acceptance item. P2–P7 outreach/voice work is not a prerequisite.

## MVP acceptance scenario

Register Qonbaq (Flutter + backend), Flowboard (F/C/G/DS workstreams) and Mindsurfing. Sync real roadmaps and GitHub states. From one ChatGPT MCP conversation, ask for verified progress, blockers and independently runnable tasks; attach an existing chat's voluntary progress report; start one managed or manually handed-off task; observe branch, PR and CI; require verified checks and merge authorization before declaring completion. No need to open all development chats.

## Integration work and risks

- Current Integron `dev` CI has test jobs but no full lint/typecheck/secrets scan; add these before broad write permissions.
- Current API is localhost-only; do not expose it as public MCP unchanged.
- Main branch is not the working integration branch; use `dev` and preserve branch policy.
- Existing P0–P7 roadmap tracks full acceptance, not first slices; keep original domain roadmap independent from D0–D6.
- Provider session creation capabilities and pricing must be checked against current official docs at implementation time; do not promise arbitrary ChatGPT UI chat control.

## First implementation PR scope

D0 documentation and ADR; D1 read-only registry and observer with fixtures for the three projects, reconciliation and deterministic tests. No automatic agent launches, PR merges or public endpoints in this PR.

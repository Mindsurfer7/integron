# D5b — durable managed-agent session creation, after D3

**Status:** PR #25 targets Integron \`dev\`. D3 PR #23 and D5a PR #24 have already merged. D5b is a bounded implementation slice, NOT completed end-to-end developer automation.

## What works

- D5b PostgreSQL schema: \`DevAgentSession\`, \`DevExecution\`, \`DevArtifact\`. The migration is additive and ordered after D3; D3 \`DevDecision\` and immutable \`DevEvent\` are preserved.
- A locally prepared, immutable, SHA-256-bound \`create_session\` envelope includes task UUID, allowlisted repository, exact worktree directory, Git branch, observed integration-branch SHA, title, request key and requested max spend. No secrets or prompts are stored.
- \`DevExecutionStore.prepareCreate\` checks the D2 readiness plan, recent D1 repository observation, repository/project ownership, single-repository scopes, blockers and dependency evidence in an atomic PostgreSQL transaction. It reserves one task and moves it into D2 \`paused\` (not \`running\`, \`verified\` or \`completed\`).
- Shared advisory lock order D2→D5b coordinates D3 blocker application, D2 manifest edits and D5b reservation. Replayed request keys return the same pending execution; collisions fail.
- Owner approval is separate from the write-token MCP path. A local TTY CLI must display the complete exact intent, check the digest and require typed confirmation. No remote model tool can approve, claim or run a session.
- Before the single outbound create call, a durable \`attempting\` row with a monotonic fence is committed. A timeout, crash or ambiguous reply is never automatically retried. Recovery lists \`attempting\`/\`unknown\` records for manual reconciliation.
- The local CLI's \`--run\` creates **only an empty session** through an authenticated loopback OpenCode server in its exact configured directory. It does not submit a prompt. Session creation is presently restricted to \`maxCostCents=0\`, because metered model use has not yet been controlled.

## Threat boundaries

1. OpenCode runs commands and edits files with OS permissions. Use a dedicated clean worktree, least-privilege OS account/container and trusted OpenCode permission configuration. \`/path\` equality does not establish filesystem confinement by itself.
2. D3 MCP permission to add/resolve blockers is NOT permission to launch agents. The D5b local TTY approval is a separate capability, and no D5b routes are exposed via MCP or the main HTTP server.
3. D2 \`ready\` is a recommendation; the D5b prepare path reserves it transactionally. No implicit approval is derived from readiness.
4. UNKNOWN remote side effects remain reserved until reconciliation; do not resubmit the same action or free its path without verifying remote OpenCode and GitHub state.
5. OpenCode diff is not independently verified GitHub evidence. \`DevArtifact\` has provenance and \`verifiedAt\` restrictions; artifact ingestion from GitHub, checks and merges is a later stage.

## Local runbook

Requires Node 22.16+, PostgreSQL and applied migrations. Use environment variables (do not commit secrets).

\`\`\`bash
corepack enable
pnpm install
pnpm db:generate
pnpm db:deploy

export DATABASE_URL="postgresql://..."
export OPENCODE_SERVER_PASSWORD="long-unique-local-secret"
export OPENCODE_SERVER_URL="http://127.0.0.1:4096"
export OPENCODE_ALLOWED_WORKTREE_ROOT="/absolute/path/to/isolated/worktrees"
# Start OpenCode serve yourself in a dedicated, independently checked worktree. The CLI verifies that the exact worktree root is inside the configured trusted root, has the approved feature branch and integration SHA at HEAD, a clean worktree and the allowlisted GitHub origin.
# Keep its host bound to 127.0.0.1 and configure matching Basic auth.

pnpm dev:agent:local --prepare ./private-reviewed-intent.json
pnpm dev:agent:local --inspect <execution-id>
pnpm dev:agent:local --approve <execution-id> <64-hex-digest>
pnpm dev:agent:local --run <execution-id> <64-hex-digest>
pnpm dev:agent:local --reconcile
\`\`\`

Example reviewed intent file, stored **outside the Git repository**:

\`\`\`json
{
  "taskId": "REPLACE-WITH-REAL-UUID",
  "repository": "Qonbex/qonbaq",
  "directory": "/absolute/path/to/dedicated/worktree",
  "branch": "feat/approved-change",
  "baseSha": "REPLACE-WITH-40-HEX-D1-INTEGRATION-SHA",
  "title": "Review and create an empty coding session",
  "requestKey": "unique_request_key_123456",
  "maxCostCents": 0
}
\`\`\`

The `baseSha` supplied by the operator must match D1's fresh integration-branch snapshot at reservation and claim time; a changed branch invalidates dispatch. The D1 observer must have a fresh integration-branch snapshot; task prerequisites and scopes must be registered via D2. A prepared intent expires after 10 minutes if it was never attempted. Expire only unattempted stale reservations with \`--expire <execution-id>\`; once a provider call has been attempted, reconcile rather than expire it.

## Automated acceptance and what remains

\`pnpm test\` contains D5b pure and simulated provider tests; \`pnpm test:postgres\` contains transaction/restart/idempotency tests. CI also runs D3 tests and macOS offline suite.

Not yet implemented or accepted: durable prompting/resume/cancel, metered budget reservations, OS-level isolation enforcement, dedicated branch creation and PR creation/verification, D5→D6 guarded CI/merge policy, public OAuth/HTTPS MCP and end-to-end live OpenCode smoke on the operator's Mac. These are necessary before claiming full D5 acceptance.

See [D5a adapter](DEV-ORCHESTRATOR-D5.md) and [D3 authorization](DEV-ORCHESTRATOR-D3.md).

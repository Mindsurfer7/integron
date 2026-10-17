# Development Orchestrator — MCP contract (proposed)

Status: draft for D3. Complements [DEV-ORCHESTRATOR-ROADMAP.md](DEV-ORCHESTRATOR-ROADMAP.md) and [DEV-ORCHESTRATOR-D0-ADR.md](DEV-ORCHESTRATOR-D0-ADR.md).

Owner interacts with Integron Dev from ChatGPT via these tools. No automatic discovery or launch of arbitrary existing ChatGPT conversations. Write tools require identity, scoped permissions, idempotency and (where noted) explicit approval.

## Principles

- Stable identifiers only: `projectSlug`, `taskId`, `phaseCode`, `repo` + `prNumber` + SHA.
- Agent/chat reports are untrusted assertions until reconciled against GitHub.
- Dangerous actions (merge) require an approval bound to exact head/base SHA that expires on change.
- No shell execution, no arbitrary repository writes, no silent phase completion.
- Read tools are safe and may be broader; write tools are narrow and audited.

## Read tools

### `integron.dev.status`

Short verified snapshot of one project or all.

**Input**
```json
{
  "projectSlug": "qonbaq"
}
```
`projectSlug` optional — omit for all projects.

**Returns**: phases state, open PRs, CI status, blockers, ready tasks count, last observed SHA timestamps.

### `integron.dev.roadmap`

Phases, dependencies and acceptance criteria.

**Input**
```json
{ "projectSlug": "flowboard" }
```

### `integron.dev.available_tasks`

Tasks that are ready (prerequisites satisfied, no ownership conflicts).

**Input**
```json
{
  "projectSlug": "mindsurfing",
  "limit": 10
}
```

**Returns**: `taskId`, phase, scope, allowed paths, relevant repos + current SHAs, suggested handoff prompt.

### `integron.dev.blockers`

**Input**
```json
{ "projectSlug": "qonbaq" }
```

### `integron.dev.sessions`

Active agent/chat sessions linked to tasks.

**Input**
```json
{
  "projectSlug": "qonbaq",
  "staleOnly": false
}
```

### `integron.dev.digest`

Human-readable summary (done / not done / next recommended actions).

**Input**
```json
{ "projectSlug": "qonbaq" }
```
Omit `projectSlug` for a multi-project digest.

## Write tools

All write tools require `idempotencyKey` (string). Repeated calls with the same key are no-ops.

### `integron.dev.report_progress`

Voluntary progress report from a connected chat (D4 bridge). Stored as an untrusted assertion.

**Input**
```json
{
  "taskId": "qb-phase-3-auth",
  "sessionRef": "chatgpt-abc123",
  "branch": "feat/auth-20261018",
  "prNumber": 42,
  "prUrl": "https://github.com/...",
  "status": "pr_open",
  "blockers": ["need design review"],
  "nextSteps": "fix tests",
  "idempotencyKey": "..."
}
```

`status` values follow the task lifecycle: `planned` | `ready` | `running` | `pr_open` | `ci_pending` | `review` | `verified` | `completed` | `blocked` | `paused` | `failed` | `cancelled`.

### `integron.dev.start_task`

Start or hand off a task.

**Input**
```json
{
  "taskId": "qb-phase-3-auth",
  "mode": "manual",
  "idempotencyKey": "..."
}
```

- `mode: "manual"` — returns a ready-to-paste handoff prompt + context (current SHAs, acceptance criteria, allowed paths).
- `mode: "managed"` — only available when D5 managed runner is enabled and entitled; otherwise rejected.

### `integron.dev.pause_task` / `integron.dev.resume_task`

**Input**
```json
{
  "taskId": "...",
  "reason": "...",
  "idempotencyKey": "..."
}
```

### `integron.dev.review_pr`

Record a review decision (does not write to GitHub by itself).

**Input**
```json
{
  "repo": "Qonbex/qonbaq",
  "prNumber": 42,
  "headSha": "abc123...",
  "decision": "approve_for_merge",
  "note": "...",
  "idempotencyKey": "..."
}
```

`decision`: `approve_for_merge` | `request_changes` | `comment`.

### `integron.dev.approve_merge`

Explicit merge authorization bound to exact SHAs.

**Input**
```json
{
  "repo": "Qonbex/qonbaq",
  "prNumber": 42,
  "headSha": "abc123...",
  "baseSha": "def456...",
  "idempotencyKey": "..."
}
```

Creates a `DevDecision`. Actual merge happens only in D6 after re-validation that SHAs are still current, required checks are green, and no conflicts exist. Approval expires if head or base changes.

## Non-goals

- No tool launches arbitrary ChatGPT UI chats.
- No tool performs shell commands or unrestricted repository writes.
- No tool treats a chat self-report or a merged PR as phase acceptance without independent evidence.

## Implementation notes

- Tools live behind authenticated MCP (D3).
- All write paths emit `DevEvent` audit records.
- Responses must never include raw secrets or full GitHub tokens.
- Prompt injection resistance: untrusted text from PRs/issues/chats is returned as inert data, never executed as instructions.

# D5d — approved first coding prompt on an explicitly local model

**Status:** feature PR targeting Integron \`dev\`, after merged D3 and D5a–D5c. This adds a narrow operator-controlled prompt launch; it is NOT fully unattended development.

## Implemented

1. \`start_task\` intent with a SHA-256 digest of the exact local prompt file, session UUID, external session ID, repository, branch, integration SHA, fixed local model, request key and **zero API spend**. Prompt content stays on the owner's machine, not in PostgreSQL.
2. D5b \`DevExecution\` now supports idempotent \`preparePrompt\`, exact-digest owner approval, one-shot \`claimPromptApproved\` (fenced **before** network IO), and \`settlePromptAttempt\`. A timed-out/unknown provider response holds the task and prevents automatic retry. A prompt ACK means **queued**; it does not mean code finished.
3. \`OpenCodeClient.assertRestrictedLocalModel\` fetches the authenticated loopback server's \`GET /config\` and rejects anything other than explicitly configured \`ollama\` with an allowlisted model and loopback Ollama base URL (\`127.0.0.1:11434/v1\` or \`localhost:11434/v1\`). OpenCode permissions must be deny-by-default, allowing only local reads and edits, with bash and external directories denied.
4. \`POST /session/:id/prompt_async\` receives an explicit \`model: {providerID:'ollama',modelID}\` field to prevent silently using the server's default paid model. The original D5a API remains backward compatible for other callers, but the D5d coordinator requires this model pin.
5. Local TTY CLI adds \`--prepare-prompt\`, \`--inspect-prompt\`, \`--approve-prompt\` and \`--run-prompt\`. Approval displays the exact prompt text and digest, requires a typed confirmation, and checks the same private file again before sending.
6. The D5b clean-worktree, exact-feature-branch and integration-SHA checks are run immediately before sending a prompt. No GitHub push/PR creation/merge tool is exposed via MCP.

## Required server setup

Launch OpenCode and Ollama inside a **separate OS/container sandbox** with no writable host secrets or broad filesystem mounts. D5d's configuration checks are defense in depth, **not a sandbox**.

Example \`opencode.json\`, installed in the isolated worktree:

\`\`\`json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama local",
      "options": { "baseURL": "http://127.0.0.1:11434/v1" },
      "models": { "coder-local": { "name": "Local coding model" } }
    }
  },
  "permission": {
    "*": "deny",
    "read": "allow",
    "edit": "allow",
    "bash": "deny",
    "external_directory": "deny"
  }
}
\`\`\`

The model ID must match a **real model installed in the local Ollama server**; the example ID is illustrative. Do not use \`--auto\` to override interactive tool permissions. Because bash is denied, this slice edits code but **cannot automatically run tests or create Git branches/PRs**.

\`\`\`bash
export DATABASE_URL="postgresql://..."
export OPENCODE_SERVER_URL="http://127.0.0.1:4096"
export OPENCODE_SERVER_PASSWORD="unique-local-password"
export OPENCODE_ALLOWED_WORKTREE_ROOT="/absolute/path/to/isolated/worktrees"

pnpm db:generate
pnpm db:deploy
# The D5b session must be active/acknowledged first.
pnpm dev:agent:local --prepare-prompt <session-uuid> <request-key> <model-id> /private/approved-prompt.txt
pnpm dev:agent:local --inspect-prompt <execution-uuid>
pnpm dev:agent:local --approve-prompt <execution-uuid> <digest> /private/approved-prompt.txt
pnpm dev:agent:local --run-prompt <execution-uuid> <digest> /private/approved-prompt.txt
pnpm dev:agent:local --reconcile
\`\`\`

Never check the private prompt file or provider credentials into Git. A changed prompt file invalidates the digest. A stale GitHub snapshot, newly opened D3 blocker or changed model/worktree prevents launch.

## Acceptance limits

- The local Ollama provider avoids **metered cloud-model API billing**, not CPU/electricity costs. No paid provider can be selected by D5d; explicit paid-cost accounting remains unsolved.
- A 204 from OpenCode is only an async dispatch ACK. A separate status/reconciliation loop, code-scope diff checks, manual tests and GitHub PR creation still follow.
- D5c may subsequently observe a manually created PR, but doesn't claim that OpenCode authored every change.
- Full D5 still needs robust resume/cancel and prompts with safely metered providers (if desired), exact-scope changeset verification, operator-host E2E and durable integration with D6 approvals/merges.

Source: [OpenCode server API](https://opencode.ai/docs/server/), [local Ollama provider](https://opencode.ai/docs/providers/), [permissions](https://opencode.ai/docs/permissions/).

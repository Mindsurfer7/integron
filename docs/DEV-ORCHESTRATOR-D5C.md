# D5c — managed session ↔ verified GitHub PR observation

**Status:** implementation under PR to Integron \`dev\`, on top of merged D3, D5a and D5b. This is a read-only GitHub reconciliation stage. D5 full acceptance still requires owner-controlled prompt execution and bounded model costs.

## Implemented

1. **Dedicated read-only GitHub PR evidence probe.** \`GithubReadonlyClient.managedPrEvidence\` reads an explicit repository/PR number over the fixed GitHub REST origin using a read-only token. It validates the PR URL, exact same-repository head (forks unsupported), head branch, base branch, commit SHA and current GitHub branch HEAD. It reports bounded check run metadata with explicit coverage, never assuming missing check runs are green.
2. **Durable correlation.** \`DevPrEvidenceStore.observe\` only accepts an acknowledged, active D5b session whose task/repository ownership is valid, PR head is the managed session branch and PR base is the registered integration branch. A second database check guards session changes during the network probe. Observations are idempotently upserted by execution/source/kind/SHA.
3. **Artifact provenance.** A \`DevArtifact\` marked \`github_observer\` + \`verifiedAt\` means the PR fact and head SHA were read from authenticated GitHub. It explicitly does **not** mean the code passed the full required CI/branch-protection policy, was reviewed, merged or accepted. Both \`ciAccepted\` and \`phaseAccepted\` remain false.
4. **Read-only MCP.** New \`integron_dev_artifacts\` exposes project-scoped PR evidence, with safe fields only. Provider secrets, raw metadata, prompt strings and arbitrary upstream payloads are omitted. D3 write permissions remain only for blocker actions.
5. **Manual observation CLI.** \`pnpm dev:agent:pr --observe <session-uuid> <PR-number>\` requires local PostgreSQL and \`GITHUB_READ_TOKEN\`. This CLI never creates, edits or merges PRs.

## Example

After a manually operated and approved coding session has opened a PR in the right repository from the right feature branch:

\`\`\`bash
export DATABASE_URL="postgresql://..."
export GITHUB_READ_TOKEN="read-only-token"
pnpm db:generate
pnpm db:deploy
pnpm dev:agent:pr --observe <session-uuid> 123
\`\`\`

If GitHub cannot independently confirm that exact branch/head/repo, the operation is rejected. A branch can move while checks run; D5c records the observed SHA and doesn't assume it is still current later. D6 must re-check exact SHA, required checks, review, mergeability and owner authorization immediately before merge.

## Acceptance boundaries / remaining D5 work

- A human still needs to create the worktree/branch and produce a PR. D5c **does not** automatically prompt OpenCode, push, open PRs, approve or merge code.
- D5c does not enforce metered usage or filesystem sandboxing. Those require runtime model selection, budget accounting and a separately confined execution environment.
- Evidence currently supports same-repository PRs with a live head branch. Fork PRs and deleted-head merged PRs are rejected rather than guessed.
- GitHub observation authenticates the reported PR metadata, not the provenance that OpenCode authored every code change.
- D3 remote OAuth/HTTPS ChatGPT integration is a separate infrastructure requirement, still absent.

## Tests

- \`tests/dev-pr-evidence.test.ts\`: mock GitHub exact repository/head, fork, changed HEAD, partial checks and invalid parameters.
- \`tests/dev-pr-evidence-postgres.test.ts\`: idempotent artifact storage by SHA, session scope changes, no automatic task/phase acceptance.
- \`tests/dev-mcp-tools.test.ts\`: project scope and no raw metadata leakage.
- Existing demo, PostgreSQL and macOS CI must remain green.

See [D5b](DEV-ORCHESTRATOR-D5B.md) and [D3](DEV-ORCHESTRATOR-D3.md).

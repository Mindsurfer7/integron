# D5 — ManagedAgentRunner: OpenCode adapter (independent D5a slice)

**Status:** D5a merged to `dev` via PR #24; D5b durable execution in PR #25. D5 full acceptance remains **open**: authenticated launch/lease persistence, branch/PR evidence, cost gates and crash reconciliation require D5b after D3 is accepted.

## Implemented

- Provider interface `ManagedAgentRunner` in `packages/dev/src/agent-runner.ts`: `createSession`, `startTask`, `getStatus`, `resume`, `cancel`, `getArtifacts`. Also an inert `createManualHandoff` fallback.
- `OpenCodeClient` wraps **official documented OpenCode serve API**: `POST /session`, `POST /session/:id/prompt_async`, `GET /session/status`, `GET /session/:id`, `GET /session/:id/diff`, `POST /session/:id/abort`, plus health/path checks. No arbitrary shell, command, tool permission response, remote URL or generic proxy endpoint.
- `OpenCodeManagedRunner` locks to one explicitly configured repository and **one exact local directory**; rejects mismatching session/task; sends owner-authorized prompt asynchronously and exposes OpenCode-origin diff metadata with `githubVerified:false`.
- Mutations are **deny-by-default**. A caller must supply a separately implemented policy gate; tests use a fake gate for the provider protocol. The gate must not be shipped as a blanket allow rule. No route calls the new runner automatically.
- All HTTP calls use Basic auth and loopback-only `http://127.0.0.1:<port>`, no redirects, finite timeout, response-size ceiling and sanitized errors. After an ambiguous POST transport failure, result is `OPENCODE_OUTCOME_UNKNOWN`; never retry automatically.

## Security model / non-goals

OpenCode is a coding agent with filesystem and command execution rights. **Only launch a dedicated `opencode serve` bound to the loopback interface in a dedicated worktree, with OpenCode server password configured**, approved agent/model/tool permissions and repository-only OS/filesystem access. A matching `/path` is necessary but insufficient isolation: the host OS must enforce it.

The D2 `ready` value is advisory. The contract's `AgentAuthorizationGateway` is a privileged dependency, **not an approval in itself**; D5b must implement an atomic DB authorization/lease check for the exact action, prompt SHA-256, repository, scope, external session, budget and idempotency key. It must also verify task scope against changed files and independently prove branch/PR/CI via D1 GitHub observations. Current code does none of those durable side effects.

A timed-out session-create or prompt POST can have succeeded remotely. D5a does **not** know enough to retry it. OpenCode idle means no currently observed work, not that the task completed. An abort acknowledgment does not guarantee rollback of files. Never auto-merge or mark a phase accepted.

Existing ChatGPT UI sessions cannot be created/listed/controlled through this provider. This is a separate local OpenCode coding agent.

## Offline tests

```bash
node --experimental-strip-types --test tests/dev-agent-runner.test.ts
```

The separate GitHub workflow `dev-agent-runner-ci.yml` runs offline mock-HTTP tests on PRs. These do not replace a credentialed, manually approved real OpenCode smoke test.

## D5b remaining work (after D3 stabilization)

1. Add additive `DevAgentSession`, `DevExecution`, `DevArtifact`, durable action/outbox/lease with fencing; coordinate migration with D3.
2. Implement D3-authenticated owner request/approval that binds **exact** task, prompt digest, repository, branch, model, spending ceiling and idempotency; ensure D2 freshness/conflict/capacity validation occurs in same transaction as lease acquisition.
3. Prepare a dedicated validated worktree/branch; use restricted GitHub credentials; persist session ID and attempt **before** ambiguous external actions, and reconcile after crash. Do not resubmit unknown outcomes blindly.
4. Independently verify GitHub head SHA/PR target, code scope, tests and CI. Promote `DevArtifact` evidence with immutable origin; stop at review awaiting D6 merge approval.
5. Test duplicate requests, timeouts, wrong workspace, stale D1 snapshot, lease expiry, concurrent requests, restart, agent failure, scope escape, wrong branch and cost overrun. Run local-only provider E2E with explicit operator approval.

**Source:** [OpenCode serve API documentation](https://opencode.ai/docs/server/), current as checked 2026-10-18. The running installation's `/doc` specification must also be checked before enabling real execution.

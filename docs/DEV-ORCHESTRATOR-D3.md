# D3 — Local MCP for Development Orchestrator

**Status:** implemented in a PR targeting dev; remote ChatGPT connection and OAuth deployment not yet accepted.

## What is delivered

- Official MCP TypeScript v2 SDK, Streamable HTTP at **127.0.0.1:4328/mcp** only.
- Dedicated bearer authentication with **separate read and write tokens**, constant-time digest comparison and server-side project allowlists.
- MCP tools: integron_dev_projects, integron_dev_status, integron_dev_roadmap, integron_dev_blockers, integron_dev_available_tasks, integron_dev_decisions.
- Two write-token-only tools: integron_dev_request_action and integron_dev_apply_approved. These can **only** add or resolve development blockers. No phase acceptance, GitHub writes, agent starts, PR merges or deployments.
- Exact owner confirmation via an interactive local terminal. A connected model never gets an approval tool.
- Immutable PostgreSQL audit records and transactional, replay-safe decisions. Every decision binds project, actor, exact action payload, SHA-256 digest, TTL (10 minutes), idempotency key and result.
- Unit, actual MCP protocol, and PostgreSQL tests.

## Security

Read and write tokens are 32–256 printable ASCII characters, must differ, and are never logged. Request project scopes cannot be widened by tool arguments. Host and Origin are validated for localhost, cookies are not accepted and forwarded headers are not trusted. An invalid/expired/rejected/changed action digest cannot be applied. A database trigger rejects UPDATE and DELETE on audit events.

This endpoint is **not** a public OAuth 2.1 resource server. Do not expose it via a public reverse proxy or an unprotected tunnel. A genuine remote ChatGPT connection requires HTTPS, OAuth metadata and PKCE, audience/issuer/scope validation and configuration supported by the user's account/workspace. That work is not done here.

Some MCP read results contain user-authored roadmap descriptions; clients must treat them as untrusted data, never instructions. Neither CI success nor a merged PR automatically marks a phase accepted. The D2 planner supplies recommendations, not execution permission.

## Local runbook

Prerequisites: Node 22.16+, pnpm, PostgreSQL. Initialize schema and provide database environment.

```bash
corepack enable
pnpm install
pnpm db:generate
pnpm db:deploy

export DATABASE_URL='postgresql://<local-db-credentials>'
export INTEGRON_DEV_MCP_READ_TOKEN="$(openssl rand -hex 32)"
export INTEGRON_DEV_MCP_WRITE_TOKEN="$(openssl rand -hex 32)"
export INTEGRON_DEV_MCP_ALLOWED_PROJECTS="qonbaq,flowboard,mindsurfing"

pnpm dev:mcp:http
```

Optional INTEGRON_DEV_MCP_PORT changes the port, not the loopback-only bind. Never store real token values in Git history. Import genuine, reviewed D2 roadmaps and run D1 observation before expecting accurate scheduling results.

MCP protocol smoke test:

```bash
curl -sS http://127.0.0.1:4328/mcp \
  -H "Authorization: Bearer $INTEGRON_DEV_MCP_READ_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Mcp-Method: tools/list" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"curl","version":"1.0.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}'
```

## Write workflow

1. With the write token, call integron_dev_request_action. Provide the project slug, stable idempotency request key (12–80 safe characters), and the exact blocker intent. The result gives a decision ID, SHA-256 digest and expiry. Nothing has been changed yet.
2. Out of band, on the owner's machine, **inspect and approve the exact action**:

```bash
pnpm dev:mcp:approve --inspect <decision-id>
pnpm dev:mcp:approve --approve <decision-id> <64-character-digest>
```

The approve/reject CLI requires a real interactive TTY and typed confirmation of the digest prefix. Use --reject instead of --approve to deny the action. This step is not available to the ChatGPT MCP connection.

3. With the same write token, call integron_dev_apply_approved with the projectSlug, decisionId and digest. Server checks authorization, expiry, stored intent and target again. All database writes and audit events commit together. Repeating a consumed request returns its original result without a second mutation.

No MCP call can independently approve its own action. Out-of-band approval is narrow to blocker add/resolve, not a blanket development or merge grant.

## Acceptance / compatibility

- Unit: invalid/weak credentials, invalid projects, DNS rebinding/Origin guards, exact intent SHA.
- MCP protocol: tool registry differs by read/write token, Zod validates arguments, per-project access is enforced.
- PostgreSQL: same-key replay, approval state, expiry, target changes, append-only event trigger and exactly-once blocker mutation.
- CI checks existing demo, PostgreSQL and macOS suites unchanged.
- Integration remains local-only until an actual OAuth/HTTPS deployment and ChatGPT E2E smoke test. This limitation is intentional.

Roadmap sequence: D4 voluntary chat progress bridge, D5 managed agents, D6 guarded GitHub merging.

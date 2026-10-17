import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { type PrismaClient } from '@prisma/client';
import { DevMcpAuthError, type DevMcpPrincipal } from './mcp-auth.ts';
import { DevMcpError, DevMcpService, type DevMcpIntent } from './mcp-service.ts';
import { DevPlannerError } from './planner.ts';

const project = z.enum(['qonbaq', 'flowboard', 'mindsurfing']);
const key = z.string().regex(/^[a-zA-Z0-9_-]{12,80}$/);
const uuid = z.string().uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const intent = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add_blocker'),
    taskId: uuid,
    kind: z.string().regex(/^[a-z_]{2,50}$/),
    detail: z.string().min(3).max(500)
  }),
  z.object({ action: z.literal('resolve_blocker'), blockerId: uuid })
]);
function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}
function failure(error: unknown) {
  // Provider data, stack traces, raw SQL and secrets must never reach a model.
  const code = error instanceof DevMcpAuthError || error instanceof DevMcpError ||
    error instanceof DevPlannerError ? error.code : 'INTERNAL_ERROR';
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: code }) }],
    isError: true };
}
async function safely(action: () => Promise<unknown>) {
  try { return textResult(await action()); }
  catch (error) { return failure(error); }
}
/**
 * Per-client instance: principal comes from validated local HTTP bearer token.
 * Scope checks also run inside every service method (defense in depth).
 */
export function createDevMcpServer(db: PrismaClient, principal: DevMcpPrincipal) {
  const server = new McpServer({ name: 'integron-dev', version: '0.3.0' });
  const api = new DevMcpService(db);

  server.registerTool('integron_dev_projects', {
    description: 'List only development projects accessible to this owner connection.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => safely(() => api.projects(principal)));

  server.registerTool('integron_dev_status', {
    description: 'Read observed GitHub branch/PR coverage and phase counts. Missing or stale evidence is not proof of success.',
    inputSchema: z.object({ projectSlug: project }),
    annotations: { readOnlyHint: true }
  }, async ({ projectSlug }) => safely(() => api.status(principal, projectSlug)));

  server.registerTool('integron_dev_roadmap', {
    description: 'Read registered development phases, tasks, cross-project prerequisites and acceptance metadata. No implicit acceptance.',
    inputSchema: z.object({ projectSlug: project }),
    annotations: { readOnlyHint: true }
  }, async ({ projectSlug }) => safely(() => api.roadmap(principal, projectSlug)));

  server.registerTool('integron_dev_blockers', {
    description: 'Read local development blockers, including resolved ones. These are not automatic CI failure diagnoses.',
    inputSchema: z.object({ projectSlug: project }),
    annotations: { readOnlyHint: true }
  }, async ({ projectSlug }) => safely(() => api.blockers(principal, projectSlug)));

  server.registerTool('integron_dev_available_tasks', {
    description: 'Suggest independently runnable tasks, with explicit reasons for blockers. Does not reserve or start tasks.',
    inputSchema: z.object({ projectSlug: project }),
    annotations: { readOnlyHint: true }
  }, async ({ projectSlug }) => safely(() => api.availableTasks(principal, projectSlug)));

  server.registerTool('integron_dev_decisions', {
    description: 'Read approval requests and outcomes for this project. Approval must happen on the owner computer, never in MCP.',
    inputSchema: z.object({ projectSlug: project }),
    annotations: { readOnlyHint: true }
  }, async ({ projectSlug }) => safely(() => api.decisions(principal, projectSlug)));

  // Expose mutation tools only to the write principal. Even then, both
  // methods enforce role/project scope and require out-of-band owner approval.
  if (principal.role === 'write') {
    server.registerTool('integron_dev_request_action', {
      description: 'PREPARE a blocker add/resolve action (no mutation to blocker yet). Returns an exact SHA-256 digest. Owner must approve on their local terminal before it can be applied.',
      inputSchema: z.object({ projectSlug: project, requestKey: key, intent }),
      annotations: { readOnlyHint: false, destructiveHint: false }
    }, async ({ projectSlug, requestKey, intent: requested }) =>
      safely(() => api.request(principal, projectSlug, requestKey,
        requested as DevMcpIntent)));

    server.registerTool('integron_dev_apply_approved', {
      description: 'Consume a previously owner-approved, exact-digest blocker action. Cannot launch agents, accept phases or merge PRs.',
      inputSchema: z.object({ projectSlug: project, decisionId: uuid, digest }),
      annotations: { readOnlyHint: false, destructiveHint: false }
    }, async ({ projectSlug, decisionId, digest: requestedDigest }) =>
      safely(() => api.applyApproved(principal, projectSlug, decisionId, requestedDigest)));
  }
  return server;
}

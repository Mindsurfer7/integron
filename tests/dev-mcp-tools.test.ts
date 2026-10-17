import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type PrismaClient } from '@prisma/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createDevMcpServer } from '../packages/dev/src/mcp-server.ts';
import { type DevMcpPrincipal } from '../packages/dev/src/mcp-auth.ts';

const scopedRead: DevMcpPrincipal = {
  actorId: 'local-owner', role: 'read', allowedProjects: ['flowboard']
};
const scopedWrite: DevMcpPrincipal = {
  actorId: 'local-owner', role: 'write', allowedProjects: ['flowboard']
};
const fakeDb = {
  devProject: {
    findMany: async () => [{ slug: 'flowboard', name: 'Flowboard',
      repositories: [{ fullName: 'Qonbex/qonbaq-flowboard',
        integrationBranch: 'dev', enabled: true }] }]
  }
} as unknown as PrismaClient;

async function rpc(principal: DevMcpPrincipal, method: string,
  params?: Record<string, unknown>) {
  const handler = createMcpHandler(() => createDevMcpServer(fakeDb, principal),
    { responseMode: 'json' });
  // The 2026 MCP protocol requires a per-request envelope; headers alone
  // are not enough. Exercise the actual modern SDK path, not legacy fallback.
  const body = {
    jsonrpc: '2.0', id: 1, method,
    params: {
      ...(params ?? {}),
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'integron-test', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {}
      }
    }
  };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method
  };
  if (method === 'tools/call') headers['mcp-name'] = String(params?.name);
  try {
    const response = await handler.fetch(new Request('http://127.0.0.1/mcp', {
      method: 'POST', headers, body: JSON.stringify(body)
    }));
    const text = await response.text();
    const result = JSON.parse(text);
    return { response, result };
  } finally {
    await handler.close();
  }
}

test('actual MCP tool registry separates read and write identities', async () => {
  const read = await rpc(scopedRead, 'tools/list');
  assert.equal(read.response.status, 200, JSON.stringify(read.result));
  const readNames: string[] = read.result.result.tools.map((tool: {name: string}) => tool.name);
  assert.ok(readNames.includes('integron_dev_projects'));
  assert.ok(readNames.includes('integron_dev_available_tasks'));
  assert.ok(!readNames.includes('integron_dev_request_action'));
  assert.ok(!readNames.includes('integron_dev_apply_approved'));

  const write = await rpc(scopedWrite, 'tools/list');
  assert.equal(write.response.status, 200, JSON.stringify(write.result));
  const writeNames: string[] = write.result.result.tools.map((tool: {name: string}) => tool.name);
  assert.ok(writeNames.includes('integron_dev_request_action'));
  assert.ok(writeNames.includes('integron_dev_apply_approved'));
});

test('MCP tools/call returns project catalog without raw provider payloads', async () => {
  const called = await rpc(scopedRead, 'tools/call',
    { name: 'integron_dev_projects', arguments: {} });
  assert.equal(called.response.status, 200, JSON.stringify(called.result));
  const toolResult = called.result.result;
  assert.equal(toolResult.isError, undefined);
  const rows = JSON.parse(toolResult.content[0].text);
  assert.deepEqual(rows.map((row: {slug:string}) => row.slug), ['flowboard']);
});

test('MCP tools validate params before handler and reject forbidden project', async () => {
  const invalid = await rpc(scopedRead, 'tools/call',
    { name: 'integron_dev_status', arguments: { projectSlug: 'attacker' } });
  assert.ok(invalid.result.error || invalid.result.result?.isError);
  const denied = await rpc(scopedRead, 'tools/call',
    { name: 'integron_dev_status', arguments: { projectSlug: 'qonbaq' } });
  assert.equal(denied.result.result?.isError, true);
  assert.ok(denied.result.result.content[0].text.includes('PROJECT_FORBIDDEN'));
});

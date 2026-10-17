import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type PrismaClient } from '@prisma/client';
import { createDevMcpAuth } from '../packages/dev/src/mcp-auth.ts';
import { buildDevMcpHttpApp } from '../apps/api/src/dev-mcp-app.ts';

const READ = 'r'.repeat(64), WRITE = 'w'.repeat(64);
const fakeDb = {
  devProject: { findMany: async () => [
    { slug: 'flowboard', name: 'Flowboard', repositories: [
      { fullName: 'Qonbex/qonbaq-flowboard', integrationBranch: 'dev', enabled: true }
    ] }
  ] }
} as unknown as PrismaClient;

function modern(method: string, params: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0', id: 1, method,
    params: { ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'http-test', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {}
      }
    }
  };
}
function headers(token?: string, method = 'tools/list') {
  return {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method,
    ...(token ? { authorization: 'Bearer ' + token } : {})
  };
}

test('actual loopback HTTP MCP denies missing tokens and cross-origin traffic', async () => {
  const app = buildDevMcpHttpApp(fakeDb, createDevMcpAuth({
    readToken: READ, writeToken: WRITE, allowedProjects: 'flowboard'
  }));
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const url = base + '/mcp';
    const missing = await fetch(url, {
      method: 'POST', headers: headers(), body: JSON.stringify(modern('tools/list'))
    });
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get('www-authenticate') ?? '', /Bearer/);
    const cookieOnly = await fetch(url, {
      method: 'POST',
      headers: { ...headers(), cookie: 'integron_session=not-authorized' },
      body: JSON.stringify(modern('tools/list'))
    });
    assert.equal(cookieOnly.status, 401);
    const denied = await fetch(url, {
      method: 'POST', headers: { ...headers(READ), origin: 'https://attacker.example' },
      body: JSON.stringify(modern('tools/list'))
    });
    assert.equal(denied.status, 403);
    const method = await fetch(url, { method: 'GET', headers: headers(READ) });
    assert.equal(method.status, 405);
  } finally {
    await app.close();
  }
});

test('real HTTP MCP returns tools and role-scoped read-only project data', async () => {
  const app = buildDevMcpHttpApp(fakeDb, createDevMcpAuth({
    readToken: READ, writeToken: WRITE, allowedProjects: 'flowboard'
  }));
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const url = base + '/mcp';
    const readList = await fetch(url, {
      method: 'POST', headers: headers(READ),
      body: JSON.stringify(modern('tools/list'))
    });
    const catalog = await readList.json();
    assert.equal(readList.status, 200, JSON.stringify(catalog));
    const names: string[] = catalog.result.tools.map((tool: {name: string}) => tool.name);
    assert.ok(names.includes('integron_dev_status'));
    assert.ok(!names.includes('integron_dev_request_action'));
    const writeList = await fetch(url, {
      method: 'POST', headers: headers(WRITE),
      body: JSON.stringify(modern('tools/list'))
    });
    const write = await writeList.json();
    assert.equal(writeList.status, 200, JSON.stringify(write));
    assert.ok(write.result.tools.some((tool: {name: string}) =>
      tool.name === 'integron_dev_request_action'));

    const call = await fetch(url, {
      method: 'POST',
      headers: { ...headers(READ, 'tools/call'), 'mcp-name': 'integron_dev_projects' },
      body: JSON.stringify(modern('tools/call', {
        name: 'integron_dev_projects', arguments: {}
      }))
    });
    const called = await call.json();
    assert.equal(call.status, 200, JSON.stringify(called));
    assert.equal(called.result.isError, undefined);
    assert.deepEqual(JSON.parse(called.result.content[0].text)
      .map((project: {slug: string}) => project.slug), ['flowboard']);
  } finally {
    await app.close();
  }
});

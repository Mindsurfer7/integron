/**
 * D3 localhost-only MCP Streamable HTTP endpoint. NOT a public ChatGPT app.
 * Remote deployment requires an actual OAuth 2.1 resource server and HTTPS;
 * never tunnel this local bearer-token endpoint to the public internet.
 */
import { PrismaClient } from '@prisma/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { createDevMcpAuth, localMcpHostAllowed } from '../../../packages/dev/src/mcp-auth.ts';
import { createDevMcpServer } from '../../../packages/dev/src/mcp-server.ts';

if (process.env.RUNTIME_PROFILE !== 'postgres' || !process.env.DATABASE_URL) {
  throw new Error('MCP requires RUNTIME_PROFILE=postgres and DATABASE_URL');
}
if (process.env.OUTBOUND_ENABLED && process.env.OUTBOUND_ENABLED !== 'false') {
  throw new Error('OUTBOUND_ENABLED must remain false');
}
const auth = createDevMcpAuth({
  readToken: process.env.INTEGRON_DEV_MCP_READ_TOKEN ?? '',
  writeToken: process.env.INTEGRON_DEV_MCP_WRITE_TOKEN ?? '',
  allowedProjects: process.env.INTEGRON_DEV_MCP_ALLOWED_PROJECTS
});
const port = Number(process.env.INTEGRON_DEV_MCP_PORT ?? 4328);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MCP port');

const db = new PrismaClient();
await db.$connect();
const app = createMcpFastifyApp();
app.addHook('onRequest', async (request, reply) => {
  if (!localMcpHostAllowed(request.headers.host, request.headers.origin)) {
    return reply.code(403).send({ error: 'LOCAL_ONLY' });
  }
});
app.addHook('onSend', async (_request, reply, payload) => {
  reply.header('Cache-Control', 'no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  return payload;
});
app.all('/mcp', async (request, reply) => {
  if (request.method !== 'POST') {
    return reply.code(405).header('Allow', 'POST').send({ error: 'METHOD_NOT_ALLOWED' });
  }
  // Bearer only; no cookies or browser sessions, and never trust X-Forwarded-*.
  const principal = auth.authorize(request.headers.authorization);
  if (!principal) {
    return reply.code(401).header('WWW-Authenticate', 'Bearer realm="integron-dev-local"')
      .send({ error: 'UNAUTHORIZED' });
  }
  // Stateless per-request SDK handler, captured principal; no cross-request
  // global mutable identity. SDK parses MCP JSON-RPC and validates each tool.
  const mcp = createMcpHandler(() => createDevMcpServer(db, principal), {
    responseMode: 'json',
    maxSubscriptions: 0,
    maxRequestBodySize: 8_192
  });
  const handler = toNodeHandler(mcp);
  reply.raw.setHeader('Cache-Control', 'no-store');
  reply.raw.setHeader('X-Content-Type-Options', 'nosniff');
  reply.hijack();
  try { await handler(request.raw, reply.raw, request.body); }
  finally { await mcp.close(); }
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  await db.$disconnect();
}
process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
try {
  const listenUrl = await app.listen({ port, host: '127.0.0.1' });
  console.log('Integron D3 local MCP listening at ' + listenUrl + '/mcp');
} catch (error) {
  await shutdown();
  throw error;
}

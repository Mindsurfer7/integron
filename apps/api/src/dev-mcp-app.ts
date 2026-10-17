/**
 * D3 MCP HTTP adapter. Factory is testable without starting production workers.
 * Bind the returned app to 127.0.0.1 only; remote deployment is NOT supported.
 */
import { type PrismaClient } from '@prisma/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { localMcpHostAllowed, type createDevMcpAuth } from '../../../packages/dev/src/mcp-auth.ts';
import { createDevMcpServer } from '../../../packages/dev/src/mcp-server.ts';

type Auth = ReturnType<typeof createDevMcpAuth>;
export function buildDevMcpHttpApp(db: PrismaClient, auth: Auth) {
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
    const principal = auth.authorize(request.headers.authorization);
    if (!principal) {
      return reply.code(401).header('WWW-Authenticate', 'Bearer realm="integron-dev-local"')
        .send({ error: 'UNAUTHORIZED' });
    }
    const mcp = createMcpHandler(() => createDevMcpServer(db, principal), {
      responseMode: 'json',
      maxSubscriptions: 0,
      maxRequestBodySize: 8_192
    });
    const node = toNodeHandler(mcp);
    reply.raw.setHeader('Cache-Control', 'no-store');
    reply.raw.setHeader('X-Content-Type-Options', 'nosniff');
    reply.hijack();
    try {
      await node(request.raw, reply.raw, request.body);
    } finally {
      await mcp.close();
    }
  });
  return app;
}

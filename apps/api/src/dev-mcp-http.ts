/**
 * D3 authenticated local MCP. Never expose it to public internet:
 * production ChatGPT access requires OAuth 2.1, HTTPS and proper scopes.
 */
import { PrismaClient } from '@prisma/client';
import { createDevMcpAuth } from '../../../packages/dev/src/mcp-auth.ts';
import { buildDevMcpHttpApp } from './dev-mcp-app.ts';

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
const app = buildDevMcpHttpApp(db, auth);
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

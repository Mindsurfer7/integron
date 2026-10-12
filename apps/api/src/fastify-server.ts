import { homedir } from 'node:os';
import { join } from 'node:path';
import { DemoTaskStore } from '../../../packages/core/src/demo.ts';
import { SqliteDemoTaskRepository } from '../../../packages/storage/src/sqlite.ts';
import { buildFastifyApp, type TaskService, type WorkflowApi } from './fastify-app.ts';
import { readTestTextPolicy, readTdlibUserPolicy } from '../../../packages/transports/src/contracts.ts';

const profile = process.env.RUNTIME_PROFILE ?? 'demo';
if (profile !== 'demo' && profile !== 'local' && profile !== 'postgres') {
  throw new Error('Fastify runtime supports demo, local and postgres only.');
}
if (process.env.OUTBOUND_ENABLED !== undefined && process.env.OUTBOUND_ENABLED !== 'false') {
  throw new Error('Live outbound calls/messages are forbidden. Set OUTBOUND_ENABLED=false.');
}
const port = Number(process.env.PORT ?? '4317');
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
const sqlite = profile === 'local'
  ? new SqliteDemoTaskRepository(process.env.SQLITE_PATH ?? join(homedir(), '.integron', 'tasks.sqlite'))
  : undefined;
let store: TaskService = new DemoTaskStore(sqlite);
let disconnect: (() => Promise<void>) | undefined;
let workflows: WorkflowApi | undefined;
if (profile === 'postgres') {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required for postgres runtime');
  const { PrismaClient } = await import('@prisma/client');
  const { PrismaDemoTaskService } = await import('../../../packages/storage/src/prisma.ts');
  const client = new PrismaClient();
  await client.$connect();
  store = new PrismaDemoTaskService(client);
  const { DurableOrchestrator } = await import('../../../packages/storage/src/orchestrator.ts');
  workflows = new DurableOrchestrator(client, readTestTextPolicy(process.env), readTdlibUserPolicy(process.env));
  disconnect = () => client.$disconnect();
}

const app = buildFastifyApp(store, profile, workflows);
async function shutdown() {
  await app.close();
  sqlite?.close();
  await disconnect?.();
}
process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)); });

try {
  const url = await app.listen({ host: '127.0.0.1', port });
  console.log('Integron ' + profile.toUpperCase() + ' Fastify API running at ' + url + ' (no outbound)');
} catch (error) {
  await shutdown();
  throw error;
}

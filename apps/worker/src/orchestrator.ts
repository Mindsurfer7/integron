import { PrismaClient } from '@prisma/client';
import { PrismaDemoTaskService } from '../../../packages/storage/src/prisma.ts';
import { DurableOrchestrator } from '../../../packages/storage/src/orchestrator.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (process.env.OUTBOUND_ENABLED !== undefined && process.env.OUTBOUND_ENABLED !== 'false') {
  throw new Error('Real outbound messages and calls are not enabled for this worker');
}
const db = new PrismaClient();
const orchestrator = new DurableOrchestrator(db);
const tasks = new PrismaDemoTaskService(db);
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
await db.$connect();
console.log('Integron durable mock orchestrator started');
try {
  while (!stopping) {
    try {
      await tasks.expirePending();
      const worked = await orchestrator.tick();
      if (!worked) await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      // Do not leak DB credentials, goals, contacts or tokens into logs.
      console.error('Orchestrator cycle failed:', error instanceof Error ? error.name : 'UnknownError');
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
} finally {
  await db.$disconnect();
  console.log('Integron orchestrator stopped');
}

import { PrismaClient } from '@prisma/client';
import { PrismaDemoTaskService } from '../../../packages/storage/src/prisma.ts';
import { DurableOrchestrator } from '../../../packages/storage/src/orchestrator.ts';
import { readOwnerIdentity, expireWorkflowOwnerQuestions } from '../../../packages/storage/src/owner-questions.ts';
import { expireWorkflowApprovals } from '../../../packages/storage/src/approvals.ts';
import { plannerFromEnvironment } from '../../../packages/llm/src/planner.ts';
import { readTestTextPolicy, readTdlibUserPolicy, readWhatsAppUserPolicy } from '../../../packages/transports/src/contracts.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (process.env.OUTBOUND_ENABLED !== undefined && process.env.OUTBOUND_ENABLED !== 'false') {
  throw new Error('Real outbound messages and calls are not enabled for this worker');
}
const db = new PrismaClient();
const orchestrator = new DurableOrchestrator(db, readTestTextPolicy(process.env),
  readTdlibUserPolicy(process.env), plannerFromEnvironment(process.env),
  readWhatsAppUserPolicy(process.env), readOwnerIdentity(process.env));
const tasks = new PrismaDemoTaskService(db);
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
await db.$connect();
console.log('Integron durable orchestrator started (external actions policy-gated)');
try {
  while (!stopping) {
    try {
      await tasks.expirePending();
      await expireWorkflowOwnerQuestions(db);
      await expireWorkflowApprovals(db);
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

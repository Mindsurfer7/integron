import { PrismaClient } from '@prisma/client';
import { readTestTextPolicy } from '../../../packages/transports/src/contracts.ts';
import { AgentTelegramTestAdapter } from '../../../packages/transports/src/telegram-test.ts';
import { flushTestTextOutbox, pollTestText } from '../../../packages/storage/src/text-gateway.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
if (process.env.OUTBOUND_ENABLED !== undefined && process.env.OUTBOUND_ENABLED !== 'false') {
  throw new Error('Global outbound is forbidden; test channel uses a dedicated feature flag');
}
const policy = readTestTextPolicy(process.env);
if (!policy.enabled) throw new Error('TEST_TELEGRAM_ENABLED=true required');
if (process.env.AGENT_TELEGRAM_BOT_TOKEN &&
    process.env.AGENT_TELEGRAM_BOT_TOKEN === process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error('Agent and owner notification bots must be different');
}
const adapter = new AgentTelegramTestAdapter(process.env.AGENT_TELEGRAM_BOT_TOKEN ?? '');
const db = new PrismaClient();
let stopped = false;
process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });
await db.$connect();
if (!(await adapter.health())) throw new Error('Agent bot health check failed');
console.log('Integron allowlisted Telegram TEST worker started; private chats only');
try {
  while (!stopped) {
    try {
      await flushTestTextOutbox(db, adapter, policy);
      if (stopped) break;
      await pollTestText(db, adapter, policy);
    } catch (error) {
      // Never print Telegram Bot API URL (contains token), contact identifiers, or message text.
      console.error('Agent test cycle failed:', error instanceof Error ? error.name : 'UnknownError');
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
} finally {
  await db.$disconnect();
}

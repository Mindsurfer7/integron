import { PrismaClient } from '@prisma/client';
import { PrismaDemoTaskService } from '../../../packages/storage/src/prisma.ts';
import { TelegramBotClient, flushOwnerOutbox, pollOwnerUpdates } from '../../../packages/notifications/src/telegram.ts';

// Telegram bot communicates ONLY with the verified owner. Mock tasks only.
// Single poller per database. Persistent cursor protects against duplicate callbacks.
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (process.env.OUTBOUND_ENABLED !== undefined && process.env.OUTBOUND_ENABLED !== 'false') {
  throw new Error('P1 does not permit real contacts/calls. OUTBOUND_ENABLED must be false.');
}
const bot = new TelegramBotClient({
  token: process.env.TELEGRAM_BOT_TOKEN ?? '',
  ownerUserId: process.env.OWNER_TELEGRAM_USER_ID ?? '',
  ownerChatId: process.env.OWNER_TELEGRAM_CHAT_ID ?? ''
});
const prisma = new PrismaClient();
const tasks = new PrismaDemoTaskService(prisma);
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

await prisma.$connect();
console.log('Integron owner Telegram worker started (mock conversations; single poller)');
try {
  while (!stopping) {
    try {
      await tasks.expirePending();
      // Inbound first: pressing a button while queued cancels the notification.
      await pollOwnerUpdates(prisma, bot);
      if (stopping) break;
      await flushOwnerOutbox(prisma, bot);
    } catch (error) {
      // Never log Telegram URL/token, request body or personal data.
      console.error('Telegram worker cycle failed:', error instanceof Error ? error.name : 'Unknown error');
      await new Promise(resolve => setTimeout(resolve, 3_000));
    }
  }
} finally {
  await prisma.$disconnect();
  console.log('Integron Telegram worker stopped');
}

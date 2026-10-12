import { PrismaClient } from '@prisma/client';
import { mkdir, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { readTdlibUserPolicy } from '../../../packages/transports/src/contracts.ts';
import { TdlibUserTransport } from '../../../packages/transports/src/tdlib-user.ts';
import { flushTestTextOutbox, handleTestText, TDLIB_ROUTE } from '../../../packages/storage/src/text-gateway.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
if (process.env.OUTBOUND_ENABLED !== undefined && process.env.OUTBOUND_ENABLED !== 'false') {
  throw new Error('Global outbound must remain disabled');
}
const policy = readTdlibUserPolicy(process.env);
if (!policy.enabled) throw new Error('TEST_TDLIB_ENABLED=true and explicit private allowlist required');
const apiId = Number(process.env.TDLIB_API_ID);
const apiHash = process.env.TDLIB_API_HASH ?? '';
const expectedUserId = process.env.TDLIB_AGENT_USER_ID ?? '';
if (!Number.isSafeInteger(apiId) || apiId < 1 || !/^[a-f0-9]{32}$/i.test(apiHash) ||
    !/^[1-9][0-9]{0,15}$/.test(expectedUserId)) {
  throw new Error('TDLIB_API_ID, TDLIB_API_HASH and TDLIB_AGENT_USER_ID required');
}
if (policy.allowedChatIds.has(expectedUserId) || expectedUserId === process.env.OWNER_TELEGRAM_USER_ID) {
  throw new Error('Agent USER identity must differ from its contacts and the owner');
}
// Session and files live outside the repository, with owner-only permissions.
const sessionRoot = resolve(homedir(), '.integron', 'tdlib-agent');
for (const path of [resolve(homedir(), '.integron'), sessionRoot,
  join(sessionRoot, 'database'), join(sessionRoot, 'files')]) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}
const tdl = await import('tdl');
let library = process.env.TDJSON_PATH;
if (library) {
  if (!library.startsWith('/')) throw new Error('TDJSON_PATH must be absolute');
} else {
  const binary = await import('prebuilt-tdlib');
  const getTdjson = binary.getTdjson ?? binary.default?.getTdjson;
  if (!getTdjson) throw new Error('prebuilt-tdlib cannot locate native TDLib');
  library = getTdjson();
}
tdl.configure({ tdjson: library });
const client = tdl.createClient({
  apiId, apiHash,
  databaseDirectory: join(sessionRoot, 'database'),
  filesDirectory: join(sessionRoot, 'files'),
  skipOldUpdates: false
});
let stopped = false;
process.once('SIGINT', () => { stopped = true; });
process.once('SIGTERM', () => { stopped = true; });
// On a fresh Mac, first run prompts for phone, code and optional 2FA.
await client.login();
const adapter = new TdlibUserTransport(client, expectedUserId, policy);
const db = new PrismaClient();
await db.$connect();
try {
  await adapter.health();
  const unsubscribe = adapter.subscribe(incoming =>
    handleTestText(db, policy, incoming, TDLIB_ROUTE));
  console.log('Integron TDLib USER started (1–2 opt-in test chats; no groups/cold outreach)');
  try {
    while (!stopped) {
      try {
        // Missed in-memory TDLib updates may be recovered by provider IDs.
        const pending = await db.textDelivery.findMany({
          where: { channel: TDLIB_ROUTE.channel, state: 'sent',
            expiresAt: { gt: new Date() },
            workflow: { state: 'waiting_external', step: 'await_external' } },
          take: 30
        });
        for (const delivery of pending) {
          if (!policy.allowedChatIds.has(delivery.chatId)) continue;
          for (const incoming of await adapter.reconcile(delivery.chatId, 100)) {
            await handleTestText(db, policy, incoming, TDLIB_ROUTE);
          }
        }
        if (!stopped) await flushTestTextOutbox(db, adapter, policy, 2, TDLIB_ROUTE);
        await new Promise(resolve => setTimeout(resolve, 2500));
      } catch (error) {
        // Never log secrets, chat IDs or message bodies.
        console.error('TDLib worker cycle failed:', error instanceof Error ? error.name : 'UnknownError');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  } finally {
    unsubscribe();
  }
} finally {
  await db.$disconnect();
  await adapter.close();
}

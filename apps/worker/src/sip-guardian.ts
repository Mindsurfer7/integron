import { PrismaClient } from '@prisma/client';
import { readCloudSipPolicy } from '../../../packages/voice/src/livekit-sip.ts';
import { processOneSipTermination, sweepSipDeadlines } from '../../../packages/storage/src/sip-termination.ts';

// Isolated stop-only guardian. It can NEVER initiate outbound calls.
// Explicit, test-account-only setup; no phone numbers or secrets in logs.
const env = process.env;
const policy = readCloudSipPolicy(env);
if (!policy.enabled || env.SIP_GUARDIAN_ENABLED !== 'true' ||
    !env.DATABASE_URL || !env.LIVEKIT_URL || !env.LIVEKIT_API_KEY ||
    !env.LIVEKIT_API_SECRET) {
  throw new Error('SIP_GUARDIAN_NOT_CONFIGURED');
}
const host = new URL(env.LIVEKIT_URL);
if (host.protocol !== 'https:' || !/^[a-z0-9-]+\.livekit\.cloud$/i.test(host.hostname) ||
    host.pathname !== '/' || host.username || host.password || host.search || host.hash) {
  throw new Error('INVALID_LIVEKIT_CLOUD_URL');
}
const { RoomServiceClient } = await import('livekit-server-sdk');
const provider = new RoomServiceClient(host.toString(), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
const db = new PrismaClient();
await db.$connect();

let shuttingDown = false;
process.once('SIGTERM', () => { shuttingDown = true; });
process.once('SIGINT', () => { shuttingDown = true; });
try {
  while (!shuttingDown) {
    try {
      await sweepSipDeadlines(db);
      // Each loop handles at most one one-shot termination and never redials.
      await processOneSipTermination(db, policy, provider);
    } catch {
      // Never log provider responses: they might contain sensitive contact info.
      console.error('SIP guardian sweep failed; requires inspection');
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
} finally {
  await db.$disconnect();
}

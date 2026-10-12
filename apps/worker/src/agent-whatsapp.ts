import { PrismaClient } from '@prisma/client';
import { chmod, mkdir, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readWhatsAppUserPolicy } from '../../../packages/transports/src/contracts.ts';
import { accountJid, WhatsAppUserTestAdapter } from '../../../packages/transports/src/whatsapp-user.ts';
import { flushTestTextOutbox, handleTestText, WHATSAPP_ROUTE } from '../../../packages/storage/src/text-gateway.ts';

/**
 * Experimental PERSONAL WhatsApp account test. Never launches via demo, API,
 * Telegram worker or standard orchestrator; requires two manual opt-ins.
 */
if (process.argv.length !== 3 || process.argv[2] !== '--connect-real-whatsapp' ||
    process.env.WHATSAPP_LIVE_CONNECT_ENABLED !== 'true') {
  throw new Error('Requires explicit --connect-real-whatsapp and WHATSAPP_LIVE_CONNECT_ENABLED=true');
}
if (process.env.OUTBOUND_ENABLED !== undefined && process.env.OUTBOUND_ENABLED !== 'false') {
  throw new Error('Global outbound remains disabled');
}
if (!process.env.DATABASE_URL) throw new Error('Local PostgreSQL DATABASE_URL required');
const policy = readWhatsAppUserPolicy(process.env);
if (!policy.enabled) throw new Error('TEST_WHATSAPP_USER_ENABLED=true and opt-in recipient allowlist required');
const expected = process.env.WHATSAPP_AGENT_JID!;
if (accountJid(expected) !== expected) throw new Error('Invalid expected agent identity');

// Keep auth key files outside Git with restrictive permissions; never print keys/QR in logs.
const originalUmask = process.umask(0o077);
const root = resolve(homedir(), '.integron', 'whatsapp-agent');
await mkdir(root, { recursive: true, mode: 0o700 });
await chmod(root, 0o700);
const session = join(root, 'session');
await mkdir(session, { recursive: true, mode: 0o700 });
await chmod(session, 0o700);
const lockPath = join(root, 'worker.lock');
let lock;
try {
  lock = await open(lockPath, 'wx', 0o600);
} catch {
  throw new Error('WhatsApp worker already locked: verify no process is running before removing ~/.integron/whatsapp-agent/worker.lock');
}
let stopped = false;
process.once('SIGTERM', () => { stopped = true; });
process.once('SIGINT', () => { stopped = true; });
let socket: any;
let adapter: WhatsAppUserTestAdapter | undefined;
const db = new PrismaClient();
try {
  // Optional dependency; no import or network call occurs without both opt-ins.
  const { default: makeWASocket, useMultiFileAuthState } = await import('@whiskeysockets/baileys');
  const { state, saveCreds } = await useMultiFileAuthState(session);
  socket = makeWASocket({
    auth: state,
    syncFullHistory: false, markOnlineOnConnect: false,
    // Never auto-send or auto-reply to arbitrary messages.
    printQRInTerminal: false
  });
  socket.ev.on('creds.update', saveCreds);
  const ready = new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error('WhatsApp pairing timed out')), 180_000);
    socket.ev.on('connection.update', async (update: any) => {
      if (update.qr) {
        // QR is an authentication secret; display on the user's own terminal ONLY.
        const qr = (await import('qrcode-terminal')).default;
        qr.generate(update.qr, { small: true });
      }
      if (update.connection === 'open') {
        clearTimeout(timer);
        if (accountJid(socket.user?.id) !== expected) {
          rej(new Error('WhatsApp agent account mismatch (identity not allowlisted)'));
        } else res();
      } else if (update.connection === 'close') {
        clearTimeout(timer);
        stopped = true;
        rej(new Error('WhatsApp disconnected; manual review/restart required'));
      }
    });
  });
  await ready;
  adapter = new WhatsAppUserTestAdapter(socket, expected, policy);
  await adapter.health();
  await db.$connect();
  const unsubscribe = adapter.subscribe(incoming =>
    handleTestText(db, policy, incoming, WHATSAPP_ROUTE));
  try {
    console.log('Integron WhatsApp USER experimental opt-in worker ready (no bulk or unknown contacts)');
    while (!stopped) {
      try {
        // No automatic retry on unknown send outcome; these remain for human review.
        await flushTestTextOutbox(db, adapter, policy, 1, WHATSAPP_ROUTE);
      } catch (error) {
        console.error('WhatsApp worker cycle failed:', error instanceof Error ? error.name : 'UnknownError');
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  } finally { unsubscribe(); }
} finally {
  await adapter?.close();
  try { socket?.ws?.close(); } catch { /* session already closed */ }
  await db.$disconnect();
  await lock.close();
  await rm(lockPath, { force: true });
  process.umask(originalUmask);
}

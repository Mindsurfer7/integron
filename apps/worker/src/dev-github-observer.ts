/**
 * Read-only Development Observer. No MCP/remote deployment and no GitHub writes.
 *
 * RUNTIME_PROFILE=postgres DATABASE_URL=... GITHUB_READ_TOKEN=... \
 *   node --experimental-strip-types apps/worker/src/dev-github-observer.ts --once
 *
 * --serve starts a LOOPBACK-ONLY signed webhook receiver plus periodic
 * reconciliation. GitHub delivery requires an explicitly configured local
 * reverse proxy; never expose the existing owner API/public MCP.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { GithubReadonlyClient } from '../../../packages/dev/src/github.ts';
import { repositoryTargets } from '../../../packages/dev/src/registry.ts';
import { DevGithubStore } from '../../../packages/dev/src/store.ts';
import { parseGithubWebhook } from '../../../packages/dev/src/webhooks.ts';

const mode = process.argv.includes('--once') ? 'once' :
  process.argv.includes('--serve') ? 'serve' : '';
if (!mode) throw new Error('Usage: --once or --serve');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
if (process.env.RUNTIME_PROFILE !== 'postgres') throw new Error('RUNTIME_PROFILE=postgres required');
if (!process.env.GITHUB_READ_TOKEN) throw new Error('GITHUB_READ_TOKEN required');

const db = new PrismaClient();
const observer = new DevGithubStore(db, new GithubReadonlyClient(process.env.GITHUB_READ_TOKEN));
const targets = repositoryTargets();
let closed = false;
let running: Promise<void> | null = null;

async function reconcile(): Promise<void> {
  if (running) return running;
  running = (async () => {
    const results = await observer.syncAll();
    const summary = {
      total: results.length,
      ok: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).map(r => ({ repo: r.repo, code: r.errorCode }))
    };
    console.log(JSON.stringify({ kind: 'github_reconciliation', ...summary }));
  })();
  try { await running; }
  finally { running = null; }
}
function send(response: ServerResponse, status: number, body: string) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(body);
}
async function receive(req: IncomingMessage, res: ServerResponse, secret: string) {
  if (req.method !== 'POST' || req.url !== '/webhooks/github') {
    return send(res, 404, 'not found');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 262_144) { send(res, 413, 'too large'); return; }
    chunks.push(bytes);
  }
  try {
    const payload = parseGithubWebhook(Buffer.concat(chunks), {
      'x-hub-signature-256': req.headers['x-hub-signature-256'] as string | undefined,
      'x-github-delivery': req.headers['x-github-delivery'] as string | undefined,
      'x-github-event': req.headers['x-github-event'] as string | undefined
    }, secret, targets);
    if (!payload) return send(res, 202, 'ignored');
    const created = await observer.recordWebhook(payload);
    send(res, 202, created ? 'accepted' : 'duplicate');
    // Durable receipt precedes refresh. Periodic polling handles crashes
    // between receipt and refresh; a duplicate delivery never causes a write.
    if (created) void reconcile().catch(() => {});
  } catch (error) {
    const code = error instanceof Error ? error.message : 'UNKNOWN';
    const status = code === 'WEBHOOK_TOO_LARGE' ? 413 :
      code === 'WEBHOOK_UNAUTHORIZED' ? 401 :
      code === 'WEBHOOK_DELIVERY_COLLISION' ? 409 : 400;
    send(res, status, 'rejected');
  }
}

try {
  await db.$connect();
  await observer.seed();
  await reconcile();
  if (mode === 'once') {
    await db.$disconnect();
  } else {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret || secret.length < 32) throw new Error('GITHUB_WEBHOOK_SECRET (>=32 chars) required');
    const port = Number(process.env.DEV_OBSERVER_PORT ?? 4327);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
    const server = createServer((req, res) => {
      void receive(req, res, secret).catch(() => {
        if (!res.headersSent) send(res, 500, 'error');
      });
    });
    const timer = setInterval(() => { void reconcile().catch(() => {}); }, 300_000);
    server.listen(port, '127.0.0.1');
    console.log('GitHub webhook receiver loopback 127.0.0.1:' + port);
    const stop = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      server.close(() => { void db.$disconnect().finally(() => process.exit(0)); });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
} catch (error) {
  await db.$disconnect();
  throw error;
}

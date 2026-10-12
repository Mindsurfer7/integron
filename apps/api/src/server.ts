import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { DemoTaskStore, DemoError } from '../../../packages/core/src/demo.ts';
import { SqliteDemoTaskRepository } from '../../../packages/storage/src/sqlite.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Both P0 profiles operate ONLY on mock contacts and fake transport. No live outbound.
const runtime = process.env.RUNTIME_PROFILE ?? 'demo';
if (runtime !== 'demo' && runtime !== 'local') {
  throw new Error('Supported runtime profiles: demo and local only.');
}
if (process.env.OUTBOUND_ENABLED !== undefined && process.env.OUTBOUND_ENABLED !== 'false') {
  throw new Error('Live outbound calls/messages are forbidden in P0. Set OUTBOUND_ENABLED=false.');
}
const db = runtime === 'local'
  ? new SqliteDemoTaskRepository(process.env.SQLITE_PATH ?? join(homedir(), '.integron', 'tasks.sqlite'))
  : undefined;
const store = new DemoTaskStore(db);
process.once('exit', () => db?.close());
const hostname = '127.0.0.1'; // never expose a no-auth demo to the network
const rawPort = Number(process.env.PORT ?? '4317');
if (!Number.isInteger(rawPort) || rawPort < 0 || rawPort > 65535) throw new Error('Invalid PORT');

function json(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'"
  });
  res.end(JSON.stringify(payload));
}
async function body(req: IncomingMessage): Promise<unknown> {
  let data = '';
  for await (const chunk of req) {
    data += String(chunk);
    if (data.length > 8_192) throw new DemoError(413, 'BODY_TOO_LARGE', 'Слишком большой запрос');
  }
  try { return JSON.parse(data); }
  catch { throw new DemoError(400, 'INVALID_JSON', 'Некорректный JSON'); }
}

const server = createServer(async (req, res) => {
  try {
    // Reject requests from arbitrary origins or DNS-rebinding hosts.
    const boundPort = (server.address() as { port: number }).port;
    const authority = req.headers.host;
    if (authority !== `127.0.0.1:${boundPort}` && authority !== `localhost:${boundPort}`) {
      return json(res, 403, { error: 'INVALID_HOST', message: 'Неверный адрес сервера' });
    }
    if (req.method === 'POST') {
      if (req.headers.origin && req.headers.origin !== `http://${authority}`) {
        return json(res, 403, { error: 'INVALID_ORIGIN', message: 'Внешние запросы запрещены' });
      }
      const pathWithoutBody = (req.url ?? '').endsWith('/stop');
      if (!pathWithoutBody && req.headers['content-type']?.split(';')[0] !== 'application/json') {
        return json(res, 415, { error: 'UNSUPPORTED_MEDIA', message: 'Требуется application/json' });
      }
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && (path === '/' || path === '/app.js')) {
      const file = path === '/' ? '../../web/index.html' : '../../web/app.js';
      const source = await readFile(new URL(file, import.meta.url));
      res.writeHead(200, {
        'Content-Type': path === '/' ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'",
        'Cache-Control': 'no-store'
      });
      res.end(source);
      return;
    }
    if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true, profile: runtime, outboundEnabled: false, persistence: runtime === 'local' ? 'sqlite' : 'memory' });
    if (req.method === 'GET' && path === '/api/tasks') return json(res, 200, { tasks: store.list() });
    if (req.method === 'POST' && path === '/api/tasks') {
      const data = await body(req) as { goal?: unknown };
      return json(res, 201, { task: store.create(data?.goal) });
    }
    const match = /^\/api\/tasks\/([0-9a-f-]+)(?:\/(answer|stop))?$/.exec(path);
    if (match) {
      const [, taskId, action] = match;
      if (req.method === 'GET' && !action) return json(res, 200, { task: store.get(taskId) });
      if (req.method === 'POST' && action === 'answer') {
        const data = await body(req) as { questionId?: unknown; choice?: unknown };
        return json(res, 200, { task: store.answer(taskId, data?.questionId, data?.choice) });
      }
      if (req.method === 'POST' && action === 'stop') return json(res, 200, { task: store.stop(taskId) });
    }
    return json(res, 404, { error: 'NOT_FOUND', message: 'Маршрут не существует' });
  } catch (err) {
    const status = err instanceof DemoError ? err.statusCode : 500;
    if (status === 500) console.error('Demo server error:', err);
    return json(res, status, { error: err instanceof DemoError ? err.code : 'INTERNAL_ERROR', message: err instanceof DemoError ? err.message : 'Внутренняя ошибка' });
  }
});
server.listen(rawPort, hostname, () => {
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : rawPort;
  console.log(`Integron ${runtime.toUpperCase()} running at http://${hostname}:${port} (no external messages/calls)`);
});

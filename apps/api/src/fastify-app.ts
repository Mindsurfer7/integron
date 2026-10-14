import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { DemoError, type DemoTask } from '../../../packages/core/src/demo.ts';
import { TextPolicyError } from '../../../packages/transports/src/contracts.ts';
import { type OwnerAuth } from './api-auth.ts';

export interface TaskService {
  list(): DemoTask[] | Promise<DemoTask[]>;
  get(id: string): DemoTask | Promise<DemoTask>;
  create(goal: unknown): DemoTask | Promise<DemoTask>;
  answer(taskId: string, questionId: unknown, choice: unknown): DemoTask | Promise<DemoTask>;
  stop(taskId: string): DemoTask | Promise<DemoTask>;
}

export interface WorkflowApi {
  list(): Promise<unknown>;
  get(id: string): Promise<unknown>;
  create(goal: unknown, options?: { transport?: string; targetChatId?: unknown }): Promise<unknown>;
  stop(id: string): Promise<unknown>;
  pause(id: string): Promise<unknown>;
  resume(id: string): Promise<unknown>;
  answerOwnerText(workflowId: string, questionId: string, text: unknown): Promise<unknown>;
  requestDemoApproval(workflowId: string): Promise<unknown>;
  consumeDemoApproval(workflowId: string, approvalId: string): Promise<unknown>;
}

export function buildFastifyApp(
  store: TaskService, profile: 'demo' | 'local' | 'postgres', workflows?: WorkflowApi,
  auth?: OwnerAuth
) {
  const app = Fastify({ logger: false, bodyLimit: 8_192, trustProxy: false });

  // Loopback and same-origin guards remain mandatory even with owner authentication.
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
      return reply.code(403).send({ error: 'INVALID_HOST', message: 'Неверный адрес сервера' });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const origin = request.headers.origin;
      if (origin && origin !== 'http://' + host) {
        return reply.code(403).send({ error: 'INVALID_ORIGIN', message: 'Внешние запросы запрещены' });
      }
    }
    if (auth && (request.url.startsWith('/api/') || request.url === '/auth/logout')) {
      const grant = auth.authorize(request.headers);
      if (!grant.allowed) {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Требуется вход владельца' });
      }
      // SameSite cookies + custom header prevent form-based CSRF.
      // Bearer clients do not rely on ambient browser credentials.
      if (!grant.bearer && request.method !== 'GET' && request.method !== 'HEAD' &&
          request.headers['x-integron-csrf'] !== '1') {
        return reply.code(403).send({ error: 'CSRF_REQUIRED', message: 'Отсутствует защитный заголовок' });
      }
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy',
      ['/', '/app.js', '/login', '/login.js', '/login.css'].includes(request.url)
        ? "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'"
        : "default-src 'none'");
    return payload;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DemoError || error instanceof TextPolicyError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode : 500;
    if (status === 500) app.log.error(error);
    return reply.code(status).send({
      error: status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST',
      message: status === 500 ? 'Внутренняя ошибка' : 'Некорректный запрос'
    });
  });
  app.get('/login', async (_request, reply) => {
    if (!auth) return reply.redirect('/');
    reply.type('text/html; charset=utf-8');
    return readFile(new URL('../../web/login.html', import.meta.url), 'utf8');
  });
  app.get('/login.js', async (_request, reply) => {
    if (!auth) return reply.code(404).send({ error: 'NOT_FOUND' });
    reply.type('application/javascript; charset=utf-8');
    return readFile(new URL('../../web/login.js', import.meta.url), 'utf8');
  });
  app.get('/login.css', async (_request, reply) => {
    if (!auth) return reply.code(404).send({ error: 'NOT_FOUND' });
    reply.type('text/css; charset=utf-8');
    return readFile(new URL('../../web/login.css', import.meta.url), 'utf8');
  });
  app.post<{ Body: { token?: unknown } }>('/auth/login', async (request, reply) => {
    if (!auth) return reply.code(404).send({ error: 'NOT_FOUND' });
    const result = auth.login(request.body?.token, request.ip);
    if (!result.ok) return reply.code(result.status).send({
      error: result.status === 429 ? 'RATE_LIMITED' : 'UNAUTHORIZED'
    });
    reply.header('Set-Cookie', result.cookie);
    return { ok: true };
  });
  app.post('/auth/logout', async (request, reply) => {
    if (!auth) return reply.code(404).send({ error: 'NOT_FOUND' });
    reply.header('Set-Cookie', auth.logout(request.headers.cookie));
    return { ok: true };
  });
  app.get('/', async (request, reply) => {
    if (auth && !auth.authorize(request.headers).allowed) return reply.redirect('/login');
    reply.type('text/html; charset=utf-8');
    return readFile(new URL('../../web/index.html', import.meta.url), 'utf8');
  });
  app.get('/app.js', async (request, reply) => {
    if (auth && !auth.authorize(request.headers).allowed) return reply.code(401).send({ error: 'UNAUTHORIZED' });
    reply.type('application/javascript; charset=utf-8');
    return readFile(new URL('../../web/app.js', import.meta.url), 'utf8');
  });
  app.get('/health', async () => ({
    ok: true, profile, outboundEnabled: false,
    persistence: profile === 'postgres' ? 'postgres' : profile === 'local' ? 'sqlite' : 'memory'
  }));
  app.get('/api/tasks', async () => ({ tasks: await store.list() }));
  app.post<{ Body: { goal?: unknown } }>('/api/tasks', async (request, reply) => {
    const task = await store.create(request.body?.goal);
    return reply.code(201).send({ task });
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async request => ({ task: await store.get(request.params.id) }));
  app.post<{ Params: { id: string }; Body: { questionId?: unknown; choice?: unknown } }>(
    '/api/tasks/:id/answer', async request => ({
      task: await store.answer(request.params.id, request.body?.questionId, request.body?.choice)
    })
  );
  app.post<{ Params: { id: string } }>('/api/tasks/:id/stop', async request => ({
    task: await store.stop(request.params.id)
  }));
  if (workflows) {
    app.get('/api/workflows', async () => ({ workflows: await workflows.list() }));
    app.post<{ Body: { goal?: unknown; transport?: string; targetChatId?: unknown } }>('/api/workflows', async (request, reply) => {
      const workflow = await workflows.create(request.body?.goal, {
        transport: request.body?.transport, targetChatId: request.body?.targetChatId
      });
      return reply.code(201).send({ workflow });
    });
    app.get<{ Params: { id: string } }>('/api/workflows/:id', async request => ({
      workflow: await workflows.get(request.params.id)
    }));
    app.post<{ Params: { id: string } }>('/api/workflows/:id/pause', async request => ({
      workflow: await workflows.pause(request.params.id)
    }));
    app.post<{ Params: { id: string } }>('/api/workflows/:id/resume', async request => ({
      workflow: await workflows.resume(request.params.id)
    }));
    // Loopback-only owner inbox fallback. This records clarification text but
    // NEVER approves payment, sends external messages, or changes contact policy.
    app.post<{ Params: { id: string; questionId: string }; Body: { text?: unknown } }>(
      '/api/workflows/:id/owner-questions/:questionId/answer', async request => ({
        question: await workflows.answerOwnerText(
          request.params.id, request.params.questionId, request.body?.text
        )
      })
    );
    // Only synthetic mock bookings. No external action or payment can occur.
    // Real approvals require a trusted server-side executor and stronger auth.
    app.post<{ Params: { id: string } }>('/api/workflows/:id/approvals/demo', async request => ({
      approval: await workflows.requestDemoApproval(request.params.id)
    }));
    app.post<{ Params: { id: string; approvalId: string } }>(
      '/api/workflows/:id/approvals/:approvalId/consume-demo', async request => ({
        result: await workflows.consumeDemoApproval(
          request.params.id, request.params.approvalId
        )
      })
    );
    app.post<{ Params: { id: string } }>('/api/workflows/:id/stop', async request => ({
      workflow: await workflows.stop(request.params.id)
    }));
  }
  return app;
}

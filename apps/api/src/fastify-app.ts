import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { DemoError, type DemoTask } from '../../../packages/core/src/demo.ts';
import { TextPolicyError } from '../../../packages/transports/src/contracts.ts';

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
}

export function buildFastifyApp(
  store: TaskService, profile: 'demo' | 'local' | 'postgres', workflows?: WorkflowApi
) {
  const app = Fastify({ logger: false, bodyLimit: 8_192, trustProxy: false });

  // No authentication exists yet. Bind to loopback and reject hostile Host/Origin.
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
  });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy',
      request.url === '/' || request.url === '/app.js'
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
  app.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    return readFile(new URL('../../web/index.html', import.meta.url), 'utf8');
  });
  app.get('/app.js', async (_request, reply) => {
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
    app.post<{ Params: { id: string } }>('/api/workflows/:id/stop', async request => ({
      workflow: await workflows.stop(request.params.id)
    }));
  }
  return app;
}

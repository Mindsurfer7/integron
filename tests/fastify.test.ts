import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DemoTaskStore } from '../packages/core/src/demo.ts';
import { buildFastifyApp } from '../apps/api/src/fastify-app.ts';

const host = '127.0.0.1:4317';
test('Fastify demo API preserves the existing task contract', async () => {
  const app = buildFastifyApp(new DemoTaskStore(), 'demo');
  try {
    const health = await app.inject({ method: 'GET', url: '/health', headers: { host } });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().persistence, 'memory');
    const create = await app.inject({
      method: 'POST', url: '/api/tasks', headers: { host, 'content-type': 'application/json' },
      payload: JSON.stringify({ goal: 'Узнай стоимость трёх услуг' })
    });
    assert.equal(create.statusCode, 201);
    const task = create.json().task;
    assert.equal(task.state, 'waiting_owner');
    assert.ok(task.results.every((result: { evidenceKind: string }) => result.evidenceKind === 'mock'));
    const listing = await app.inject({ method: 'GET', url: '/api/tasks', headers: { host } });
    assert.equal(listing.json().tasks.length, 1);
    const answer = await app.inject({
      method: 'POST', url: '/api/tasks/' + task.id + '/answer',
      headers: { host, 'content-type': 'application/json' },
      payload: JSON.stringify({ questionId: task.question.id, choice: 'cheapest' })
    });
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.json().task.state, 'completed');
    const stale = await app.inject({
      method: 'POST', url: '/api/tasks/' + task.id + '/answer',
      headers: { host, 'content-type': 'application/json' },
      payload: JSON.stringify({ questionId: task.question.id, choice: 'fastest' })
    });
    assert.equal(stale.statusCode, 409);
  } finally { await app.close(); }
});

test('Fastify rejects cross-origin and non-loopback Host requests', async () => {
  const app = buildFastifyApp(new DemoTaskStore(), 'demo');
  try {
    const hostRejected = await app.inject({
      method: 'GET', url: '/health', headers: { host: 'evil.example:4317' }
    });
    assert.equal(hostRejected.statusCode, 403);
    const originRejected = await app.inject({
      method: 'POST', url: '/api/tasks',
      headers: { host, origin: 'http://evil.example', 'content-type': 'application/json' },
      payload: JSON.stringify({ goal: 'Try forbidden origin' })
    });
    assert.equal(originRejected.statusCode, 403);
    const invalid = await app.inject({
      method: 'POST', url: '/api/tasks',
      headers: { host, 'content-type': 'application/json' },
      payload: '{bad json'
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/missing', headers: { host } })).statusCode, 404);
  } finally { await app.close(); }
});

test('Fastify can host the existing static browser UI', async () => {
  const app = buildFastifyApp(new DemoTaskStore(), 'demo');
  try {
    const page = await app.inject({ method: 'GET', url: '/', headers: { host } });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-type'] ?? '', /text\/html/);
    assert.match(page.body, /Integron/i);
    const script = await app.inject({ method: 'GET', url: '/app.js', headers: { host } });
    assert.equal(script.statusCode, 200);
    assert.match(script.headers['content-type'] ?? '', /javascript/);
  } finally { await app.close(); }
});

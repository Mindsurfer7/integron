import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOwnerAuth } from '../apps/api/src/api-auth.ts';
import { buildFastifyApp } from '../apps/api/src/fastify-app.ts';
import { DemoTaskStore } from '../packages/core/src/demo.ts';

const host = '127.0.0.1:4317';
const key = 'local-test-owner-access-key-1234567890';
const json = { host, 'content-type': 'application/json' };

test('owner session blocks reads and writes; cookie/CSRF and bearer allow access', async () => {
  const app = buildFastifyApp(new DemoTaskStore(), 'demo', undefined, createOwnerAuth(key));
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/health', headers: { host } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/', headers: { host } })).statusCode, 302);
    assert.equal((await app.inject({ method: 'GET', url: '/api/tasks', headers: { host } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/tasks', headers: json,
      payload: { goal: 'forbidden' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/login', headers: { host } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/auth/login', headers: json,
      payload: { token: 'not-a-key' } })).statusCode, 401);
    const loggedIn = await app.inject({ method: 'POST', url: '/auth/login', headers: json,
      payload: { token: key } });
    assert.equal(loggedIn.statusCode, 200);
    const cookie = String(loggedIn.headers['set-cookie']).split(';')[0];
    assert.match(String(loggedIn.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
    assert.equal((await app.inject({ method: 'GET', url: '/api/tasks',
      headers: { host, cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/tasks',
      headers: { ...json, cookie }, payload: { goal: 'csrf blocked' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/tasks',
      headers: { ...json, cookie, 'x-integron-csrf': '1' },
      payload: { goal: 'permitted via cookie' } })).statusCode, 201);
    assert.equal((await app.inject({ method: 'POST', url: '/api/tasks',
      headers: { ...json, authorization: 'Bearer ' + key },
      payload: { goal: 'permitted via bearer' } })).statusCode, 201);
    assert.equal((await app.inject({ method: 'POST', url: '/auth/logout',
      headers: { host, cookie, 'x-integron-csrf': '1' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/tasks',
      headers: { host, cookie } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/auth/login',
      headers: { ...json, origin: 'http://evil.example' },
      payload: { token: key } })).statusCode, 403);
  } finally { await app.close(); }
});

test('auth refuses invalid config, invalid bearer, duplicate cookies and honors Secure', () => {
  assert.throws(() => createOwnerAuth('short'));
  const auth = createOwnerAuth(key, true);
  assert.equal(auth.authorize({ authorization: 'Bearer wrong' }).allowed, false);
  const result = auth.login(key, 'loopback');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.cookie, /; Secure$/);
  const cookie = result.cookie.split(';')[0];
  assert.equal(auth.authorize({ cookie: cookie + '; ' + cookie }).allowed, false);
  assert.equal(auth.authorize({ cookie }).allowed, true);
  auth.logout(cookie);
  assert.equal(auth.authorize({ cookie }).allowed, false);
});

test('owner login throttles repeated invalid attempts', async () => {
  const app = buildFastifyApp(new DemoTaskStore(), 'demo', undefined, createOwnerAuth(key));
  try {
    for (let i = 0; i < 5; i++) {
      assert.equal((await app.inject({ method: 'POST', url: '/auth/login',
        headers: json, payload: { token: 'incorrect' } })).statusCode, 401);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/auth/login',
      headers: json, payload: { token: key } })).statusCode, 429);
  } finally { await app.close(); }
});

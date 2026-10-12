import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const serverPath = resolve('apps/api/src/server.ts');
function start(dbPath: string): Promise<{ child: ChildProcessWithoutNullStreams; url: string }> {
  return new Promise((ready, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--experimental-sqlite', serverPath], {
      env: { ...process.env, RUNTIME_PROFILE: 'local', OUTBOUND_ENABLED: 'false', SQLITE_PATH: dbPath, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Server start timeout: ' + stderr)); }, 5_000);
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('Server quit before ready ' + code + ': ' + stderr)); });
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match) { clearTimeout(timeout); ready({ child, url: 'http://127.0.0.1:' + match[1] }); }
    });
  });
}
function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise(done => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once('exit', () => done());
    child.kill('SIGTERM');
  });
}

test('real HTTP local mode retains pending and completed tasks over process restart', { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integron-http-'));
  const dbFile = join(directory, 'tasks.sqlite');
  let live: ChildProcessWithoutNullStreams | undefined;
  try {
    let started = await start(dbFile);
    live = started.child;
    let url = started.url;
    const health = await (await fetch(url + '/health')).json() as { persistence: string; outboundEnabled: boolean };
    assert.equal(health.persistence, 'sqlite');
    assert.equal(health.outboundEnabled, false);
    const created = await fetch(url + '/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'Узнай цены и условия' })
    });
    assert.equal(created.status, 201);
    const task = (await created.json() as { task: { id: string; question: { id: string } } }).task;

    await stop(live); live = undefined;
    started = await start(dbFile); live = started.child; url = started.url;
    const restored = await (await fetch(url + '/api/tasks/' + task.id)).json() as { task: { state: string } };
    assert.equal(restored.task.state, 'waiting_owner');
    const answer = await fetch(url + '/api/tasks/' + task.id + '/answer', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questionId: task.question.id, choice: 'cheapest' })
    });
    assert.equal(answer.status, 200);
    const duplicate = await fetch(url + '/api/tasks/' + task.id + '/answer', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questionId: task.question.id, choice: 'fastest' })
    });
    assert.equal(duplicate.status, 409);
    const blocked = await fetch(url + '/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ goal: 'injected' })
    });
    assert.equal(blocked.status, 403);

    await stop(live); live = undefined;
    started = await start(dbFile); live = started.child; url = started.url;
    const done = await (await fetch(url + '/api/tasks/' + task.id)).json() as { task: { state: string } };
    assert.equal(done.task.state, 'completed');
  } finally {
    if (live) await stop(live);
    rmSync(directory, { recursive: true, force: true });
  }
});

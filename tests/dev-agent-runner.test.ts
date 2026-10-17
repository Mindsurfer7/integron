import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRunnerError, createManualHandoff } from '../packages/dev/src/agent-runner.ts';
import { OpenCodeClient } from '../packages/dev/src/opencode-client.ts';
import { OpenCodeManagedRunner } from '../packages/dev/src/opencode-runner.ts';

const URL = 'http://127.0.0.1:4096';
const TASK = 'task_12345678';
const KEY = 'request_12345678';
const REPO = 'Mindsurfer7/integron';
const DIR = '/home/operator/integron';
const SESSION = 'ses_a123456789';
type RequestLog = { path: string; method: string; body: unknown; authorization: string | null };

function fixture(status: 'idle' | 'busy' | 'retry' = 'idle') {
  const requests: RequestLog[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    requests.push({ path, method, body, authorization: headers.get('authorization') });
    let result: unknown;
    let code = 200;
    if (path === '/global/health') result = { healthy: true, version: '1.0.0' };
    else if (path === '/path') result = { directory: DIR };
    else if (path === '/session' && method === 'POST') result = { id: SESSION };
    else if (path === '/session/' + SESSION && method === 'GET') result = { id: SESSION };
    else if (path === '/session/status') result = status === 'idle' ? {} : { [SESSION]: { type: status } };
    else if (path === '/session/' + SESSION + '/prompt_async') code = 204;
    else if (path === '/session/' + SESSION + '/abort') result = true;
    else if (path === '/session/' + SESSION + '/diff') {
      result = [{ file: 'src/index.ts', additions: 2, deletions: 1, patch: 'sensitive source' }];
    } else return new Response('', { status: 404 });
    return code === 204 ? new Response(null, { status: 204 }) :
      new Response(JSON.stringify(result), { status: code, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { requests, client: new OpenCodeClient({ baseUrl: URL, password: 'secret-not-in-logs', fetcher }) };
}
const session = {
  provider: 'opencode' as const, externalId: SESSION,
  taskId: TASK, repository: REPO, directory: DIR
};
function errorCode(code: string) {
  return (e: unknown) => e instanceof AgentRunnerError && e.code === code;
}

test('reject remote hosts, paths, credentials and missing server password', () => {
  for (const baseUrl of [
    'https://127.0.0.1:4096', 'http://localhost:4096',
    'http://127.0.0.2:4096', 'http://evil.test:4096',
    'http://127.0.0.1:4096/evil', 'http://127.0.0.1:4096/?x=y',
    'http://root:pass@127.0.0.1:4096'
  ]) {
    assert.throws(() => new OpenCodeClient({ baseUrl, password: 'secret' }),
      errorCode('OPENCODE_LOOPBACK_ONLY'));
  }
  assert.throws(() => new OpenCodeClient({ baseUrl: URL, password: '' }),
    errorCode('OPENCODE_AUTH_REQUIRED'));
});

test('low-level client uses OpenCode paths and Basic auth without leaking body', async () => {
  const { client, requests } = fixture();
  assert.deepEqual(await client.health(), { healthy: true, version: '1.0.0' });
  assert.equal(await client.createSession('D5 test'), SESSION);
  await client.startPrompt(SESSION, 'Implement task');
  assert.equal(await client.status(SESSION), 'idle');
  assert.deepEqual(await client.diffs(SESSION), [{
    path: 'src/index.ts', additions: 2, deletions: 1
  }]);
  await client.abort(SESSION);
  assert.equal(requests.find(x => x.path === '/session/' + SESSION + '/prompt_async')?.method, 'POST');
  assert.deepEqual(requests.find(x => x.path.endsWith('/prompt_async'))?.body, {
    parts: [{ type: 'text', text: 'Implement task' }]
  });
  for (const request of requests) assert.equal(request.authorization,
    'Basic ' + Buffer.from('opencode:secret-not-in-logs').toString('base64'));
  await assert.rejects(client.startPrompt('../other', 'x'), errorCode('INVALID_SESSION_ID'));
});

test('read fails closed and POST transport error means UNKNOWN, no retries', async () => {
  let calls = 0;
  const client = new OpenCodeClient({
    baseUrl: URL, password: 'secret',
    fetcher: (async () => { calls++; throw new Error('upstream secret'); }) as typeof fetch
  });
  await assert.rejects(client.getSession(SESSION), errorCode('OPENCODE_UNAVAILABLE'));
  await assert.rejects(client.startPrompt(SESSION, 'go'), errorCode('OPENCODE_OUTCOME_UNKNOWN'));
  assert.equal(calls, 2);
});

test('HTTP errors and oversized payloads are sanitized', async () => {
  const fail = new OpenCodeClient({
    baseUrl: URL, password: 'secret',
    fetcher: (async () => new Response('TOKEN SHOULD NOT LEAK', { status: 401 })) as typeof fetch
  });
  await assert.rejects(fail.health(), errorCode('OPENCODE_AUTH_FAILED'));
  const large = new OpenCodeClient({
    baseUrl: URL, password: 'secret',
    fetcher: (async () => new Response('x'.repeat(2_097_153))) as typeof fetch
  });
  await assert.rejects(large.health(), errorCode('OPENCODE_RESPONSE_TOO_LARGE'));
});

test('runner denies side effects by default even with a ready local OpenCode', async () => {
  const { client, requests } = fixture();
  const runner = new OpenCodeManagedRunner({ client, repository: REPO, directory: DIR });
  await assert.rejects(runner.createSession({
    taskId: TASK, repository: REPO, title: 'new', idempotencyKey: KEY
  }), errorCode('AGENT_ACTION_NOT_AUTHORIZED'));
  await assert.rejects(runner.startTask(session, {
    taskId: TASK, prompt: 'go', idempotencyKey: KEY
  }), errorCode('AGENT_ACTION_NOT_AUTHORIZED'));
  assert.equal(requests.filter(x => x.method === 'POST').length, 0);
});

test('authorized gate receives exact prompt digest; status never verifies task completion', async () => {
  const { client, requests } = fixture();
  const intents: unknown[] = [];
  const runner = new OpenCodeManagedRunner({
    client, repository: REPO, directory: DIR,
    authorize: async intent => { intents.push(intent); }
  });
  const created = await runner.createSession({
    taskId: TASK, repository: REPO, title: 'new', idempotencyKey: KEY
  });
  assert.deepEqual(created, session);
  await runner.startTask(created, { taskId: TASK, prompt: 'go', idempotencyKey: KEY });
  assert.equal((intents[1] as { action: string }).action, 'start_task');
  assert.match((intents[1] as { promptSha256: string }).promptSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(await runner.getStatus(created), {
    state: 'idle', externalId: SESSION, completionVerified: false
  });
  const artifacts = await runner.getArtifacts(created);
  assert.equal(artifacts.githubVerified, false);
  assert.equal(artifacts.diffs.length, 1);
  await runner.cancel(created);
  assert.equal(requests.filter(x => x.method === 'POST').length, 3);
});

test('runner refuses wrong workspace, wrong session task, busy session', async () => {
  const { client } = fixture('busy');
  const runner = new OpenCodeManagedRunner({
    client, repository: REPO, directory: DIR, authorize: async () => {}
  });
  await assert.rejects(runner.startTask(session, {
    taskId: TASK, prompt: 'go', idempotencyKey: KEY
  }), errorCode('AGENT_SESSION_NOT_IDLE'));
  await assert.rejects(runner.getStatus({ ...session, taskId: 'other_123456' }),
    errorCode('AGENT_SESSION_SCOPE_MISMATCH').bind(null));
  const wrong = new OpenCodeManagedRunner({
    client, repository: REPO, directory: '/other/repo', authorize: async () => {}
  });
  await assert.rejects(wrong.createSession({
    taskId: TASK, repository: REPO, title: 'x', idempotencyKey: KEY
  }), errorCode('OPENCODE_WORKSPACE_MISMATCH'));
  await assert.rejects(runner.startTask({ ...session, repository: 'wrong/repo' }, {
    taskId: TASK, prompt: 'go', idempotencyKey: KEY
  }), errorCode('AGENT_SESSION_SCOPE_MISMATCH'));
});

test('manual fallback creates handoff instructions, never dispatches work', () => {
  const h = createManualHandoff({
    taskId: TASK, repository: REPO, branch: 'feat/manual-d5',
    allowedPaths: ['packages/dev/**'], prompt: 'Review only'
  });
  assert.equal(h.kind, 'manual');
  assert.match(h.instructions, /Never merge/);
  assert.throws(() => createManualHandoff({
    taskId: TASK, repository: REPO, branch: '../unsafe',
    allowedPaths: ['../../secrets'], prompt: 'x'
  }), errorCode('INVALID_HANDOFF'));
});

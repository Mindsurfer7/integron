import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DevExecutionStore } from '../packages/dev/src/execution-store.ts';
import { OpenCodeClient } from '../packages/dev/src/opencode-client.ts';
import { dispatchApprovedLocalPrompt } from '../packages/dev/src/local-prompt.ts';
import { createManagedPromptIntent, digestManagedPromptIntent,
  promptSha256 } from '../packages/dev/src/prompt-intent.ts';

const prompt = 'Edit one safe file inside the approved worktree.';
const taskId = randomUUID(), sessionId = randomUUID();
const intent = createManagedPromptIntent({
  taskId, sessionId, repository: 'Qonbex/qonbaq',
  directory: '/tmp/d5d-local', branch: 'feat/d5d-local',
  baseSha: 'a'.repeat(40), externalId: 'ses_1234567',
  requestKey: 'prompt_request_123456',
  promptSha256: promptSha256(prompt),
  model: { providerID: 'ollama', modelID: 'coder-local' }, maxCostCents: 0
});
const digest = digestManagedPromptIntent(intent);
function fixture(options: { badPermissions?: boolean; ambiguousPost?: boolean } = {}) {
  const requests: Array<{ path: string; method: string | undefined; body: unknown }> = [];
  const settlements: unknown[] = [];
  let claims = 0;
  const db = {
    inspectPrompt: async () => ({
      id: 'execution_123', digest, state: 'approved',
      approvedBy: 'local-owner', intent
    }),
    claimPromptApproved: async () => {
      claims++;
      return { fence: 1, intent };
    },
    settlePromptAttempt: async (_id: string, _fence: number, outcome: unknown) => {
      settlements.push(outcome);
    }
  } as unknown as DevExecutionStore;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, body });
    if (path === '/config') return new Response(JSON.stringify({
      provider: { ollama: {
        options: { baseURL: 'http://127.0.0.1:11434/v1' },
        models: { 'coder-local': { name: 'Local coder' } }
      } },
      permission: {
        '*': 'deny', read: 'allow', edit: 'allow',
        external_directory: 'deny', bash: options.badPermissions ? 'allow' : 'deny'
      }
    }), { status: 200 });
    if (path === '/path') return new Response(JSON.stringify({
      directory: intent.directory
    }), { status: 200 });
    if (path === '/session/' + intent.externalId) return new Response(JSON.stringify({
      id: intent.externalId
    }), { status: 200 });
    if (path === '/session/status') return new Response('{}', { status: 200 });
    if (path.endsWith('/prompt_async')) {
      if (options.ambiguousPost) throw new Error('timeout after post');
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return {
    db, requests, settlements, getClaims: () => claims,
    client: new OpenCodeClient({
      baseUrl: 'http://127.0.0.1:4096', password: 'unit-secret', fetcher
    })
  };
}

test('D5d approved local prompt pins Ollama model and records an asynchronous ACK', async () => {
  const x = fixture();
  const result = await dispatchApprovedLocalPrompt(x.db, x.client, 'execution_123', digest, prompt);
  assert.deepEqual(result, { state: 'acknowledged', promptSha256: intent.promptSha256 });
  assert.equal(x.getClaims(), 1);
  assert.deepEqual(x.settlements, [{ outcome: 'acknowledged' }]);
  const outbound = x.requests.filter(r => r.path.endsWith('/prompt_async'));
  assert.equal(outbound.length, 1);
  assert.deepEqual((outbound[0].body as {model:unknown}).model,
    { providerID: 'ollama', modelID: 'coder-local' });
});

test('D5d rejects permissive OpenCode configuration before claiming execution', async () => {
  const x = fixture({ badPermissions: true });
  await assert.rejects(dispatchApprovedLocalPrompt(
    x.db, x.client, 'execution_123', digest, prompt
  ), /OPENCODE_RESTRICTED_CONFIG_REQUIRED/);
  assert.equal(x.getClaims(), 0);
  assert.equal(x.requests.some(r => r.path.endsWith('/prompt_async')), false);
});

test('D5d unknown async POST is persisted and NEVER automatically retried', async () => {
  const x = fixture({ ambiguousPost: true });
  await assert.rejects(dispatchApprovedLocalPrompt(
    x.db, x.client, 'execution_123', digest, prompt
  ), /OPENCODE_OUTCOME_UNKNOWN/);
  assert.equal(x.requests.filter(r => r.path.endsWith('/prompt_async')).length, 1);
  assert.deepEqual(x.settlements, [{
    outcome: 'unknown', errorCode: 'OPENCODE_OUTCOME_UNKNOWN'
  }]);
});

test('D5d rejects a changed exact prompt before any provider request', async () => {
  const x = fixture();
  await assert.rejects(dispatchApprovedLocalPrompt(
    x.db, x.client, 'execution_123', digest, 'unapproved revised prompt'
  ), /PROMPT_APPROVAL_MISMATCH/);
  assert.equal(x.getClaims(), 0);
  assert.equal(x.requests.length, 0);
});

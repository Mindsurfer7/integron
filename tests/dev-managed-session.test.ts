import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { OpenCodeClient } from '../packages/dev/src/opencode-client.ts';
import { dispatchApprovedSession } from '../packages/dev/src/managed-session.ts';
import { DevExecutionStore } from '../packages/dev/src/execution-store.ts';

const taskId = randomUUID();
const intent = {
  version: 1 as const, action: 'create_session' as const,
  taskId, repository: 'Qonbex/qonbaq',
  directory: '/tmp/integron-d5b-session',
  branch: 'feat/d5b-session',
  title: 'Safe session only', requestKey: 'request_123456789',
  maxCostCents: 0
};
function fixture(failPost = false, maxCostCents = 0) {
  const calls: string[] = [];
  const outcomes: unknown[] = [];
  const store = {
    claimApproved: async (id: string, digest: string) => {
      assert.equal(id, 'execution_uuid');
      assert.equal(digest, 'a'.repeat(64));
      return { fence: 1, sessionId: 'session_uuid',
        intent: { ...intent, maxCostCents } };
    },
    settleAttempt: async (id: string, fence: number, outcome: unknown) => {
      assert.equal(id, 'execution_uuid'); assert.equal(fence, 1);
      outcomes.push(outcome);
    }
  } as unknown as DevExecutionStore;
  const client = new OpenCodeClient({
    baseUrl: 'http://127.0.0.1:4321', password: 'fake-local-password',
    fetcher: (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path === '/path') {
        return new Response(JSON.stringify({ directory: intent.directory }), {
          status: 200, headers: { 'content-type': 'application/json' }
        });
      }
      if (path === '/session' && !failPost) {
        return new Response(JSON.stringify({ id: 'ses_known' }), {
          status: 200, headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error('ambiguous network response');
    }) as typeof fetch
  });
  return { store, client, calls, outcomes };
}

test('D5b local coordinator claims first, creates one session and records ack', async () => {
  const { store, client, calls, outcomes } = fixture();
  const result = await dispatchApprovedSession(store, client, 'execution_uuid', 'a'.repeat(64));
  assert.deepEqual(result, { externalId: 'ses_known', state: 'acknowledged' });
  assert.deepEqual(calls, ['/path', '/session']);
  assert.deepEqual(outcomes, [{ outcome: 'acknowledged', externalId: 'ses_known' }]);
});

test('ambiguous provider POST never retries; outcome remains unknown', async () => {
  const { store, client, calls, outcomes } = fixture(true);
  await assert.rejects(dispatchApprovedSession(store, client, 'execution_uuid', 'a'.repeat(64)),
    /OPENCODE_OUTCOME_UNKNOWN/);
  assert.deepEqual(calls, ['/path', '/session']);
  assert.deepEqual(outcomes, [{
    outcome: 'unknown', errorCode: 'OPENCODE_OUTCOME_UNKNOWN'
  }]);
});

test('unimplemented spending guard denies even a local session', async () => {
  const { store, client, calls, outcomes } = fixture(false, 100);
  await assert.rejects(dispatchApprovedSession(store, client, 'execution_uuid', 'a'.repeat(64)),
    /BUDGET_GATE_NOT_IMPLEMENTED/);
  assert.deepEqual(calls, []);
  assert.deepEqual(outcomes, [{
    outcome: 'unknown', errorCode: 'BUDGET_GATE_NOT_IMPLEMENTED'
  }]);
});

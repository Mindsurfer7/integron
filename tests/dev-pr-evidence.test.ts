import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GithubReadonlyClient } from '../packages/dev/src/github.ts';

const REPO = 'Qonbex/qonbaq', SHA = 'a'.repeat(40), PR = 42;
type Scenario = 'normal' | 'fork' | 'moved' | 'partial' | 'wrong-url';
function fixture(scenario: Scenario = 'normal') {
  const calls: { url: string; method: string | undefined; redirect: string | undefined }[] = [];
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, method: init?.method, redirect: init?.redirect });
    const path = new URL(url).pathname + new URL(url).search;
    let result: unknown;
    if (path.endsWith('/pulls/42')) {
      result = {
        number: PR,
        html_url: scenario === 'wrong-url' ? 'https://evil.example/fake' :
          'https://github.com/' + REPO + '/pull/42',
        state: 'open', draft: false, merged_at: null,
        head: {
          ref: 'feat/test', sha: SHA,
          repo: { full_name: scenario === 'fork' ? 'evil/fork' : REPO }
        }, base: { ref: 'dev' }
      };
    } else if (path.includes('/branches/feat%2Ftest')) {
      result = { commit: { sha: scenario === 'moved' ? 'b'.repeat(40) : SHA } };
    } else if (path.includes('/check-runs')) {
      result = {
        total_count: scenario === 'partial' ? 2 : 1,
        check_runs: [{
          name: 'unit', status: 'completed', conclusion: 'success',
          html_url: 'https://github.com/' + REPO + '/actions/runs/1'
        }]
      };
    } else if (path.endsWith('/status')) {
      result = { state: 'success' };
    } else return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(result), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  return { client: new GithubReadonlyClient('read-only-token', fetcher), calls };
}

test('D5c GitHub PR reader validates exact repo, branch SHA and bounded checks', async () => {
  const { client, calls } = fixture();
  const e = await client.managedPrEvidence(REPO, PR);
  assert.equal(e.repository, REPO);
  assert.equal(e.headRepo, REPO);
  assert.equal(e.headBranch, 'feat/test');
  assert.equal(e.baseBranch, 'dev');
  assert.equal(e.headSha, SHA);
  assert.equal(e.checksObserved, true);
  assert.equal(e.checkRuns[0].conclusion, 'success');
  assert.equal(e.commitStatus, 'success');
  assert.equal(calls.length, 4);
  assert.ok(calls.every(c => c.method === 'GET' && c.redirect === 'error'));
});

test('D5c rejects fork PRs, stale feature HEAD and mismatching PR origin', async () => {
  for (const [scenario, code] of [
    ['fork', 'GH_FORK_PR_UNSUPPORTED'],
    ['moved', 'GH_PR_HEAD_CHANGED'],
    ['wrong-url', 'GH_PR_REPOSITORY_MISMATCH']
  ] as const) {
    const { client } = fixture(scenario);
    await assert.rejects(() => client.managedPrEvidence(REPO, PR),
      (err: unknown) => err instanceof Error && err.message === code);
  }
});

test('D5c incomplete check coverage remains unknown rather than green', async () => {
  const { client } = fixture('partial');
  const observed = await client.managedPrEvidence(REPO, PR);
  assert.equal(observed.checksObserved, false);
  assert.equal(observed.checkRuns.length, 1);
  const { client: normal } = fixture();
  await assert.rejects(() => normal.managedPrEvidence(REPO, -1), /GH_INVALID_PR_REFERENCE/);
  await assert.rejects(() => normal.managedPrEvidence('../evil', PR), /INVALID_REPOSITORY/);
});

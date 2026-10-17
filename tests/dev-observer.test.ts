import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { GithubReadonlyClient, GithubObserverError, type HttpFetch } from '../packages/dev/src/github.ts';
import { repositoryTargets } from '../packages/dev/src/registry.ts';
import { parseGithubWebhook, verifyGithubSignature } from '../packages/dev/src/webhooks.ts';

const target = { project: 'flowboard', fullName: 'Qonbex/qonbaq-flowboard', integrationBranch: 'dev' };
const SHA = '0123456789012345678901234567890123456789';
function fixtureFetch(options: { missingBranch?: boolean; fail?: boolean; fullPage?: boolean } = {}) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const mock: HttpFetch = async (url, init) => {
    requests.push({ url, init });
    if (options.fail) return new Response('do not leak upstream error body', { status: 403 });
    const path = new URL(url).pathname + new URL(url).search;
    let response: unknown = {};
    if (path === '/repos/' + target.fullName) response = { default_branch: 'main' };
    else if (path === '/repos/' + target.fullName + '/branches/dev') {
      if (options.missingBranch) return new Response('{}', { status: 404 });
      response = { commit: { sha: SHA } };
    }
    else if (path.includes('/pulls?')) {
      response = path.includes('page=1')
        ? Array.from({ length: options.fullPage ? 100 : 1 }, (_, i) => ({
          number: i + 1, title: 'A PR: external untrusted text',
          html_url: 'https://github.com/Qonbex/qonbaq-flowboard/pull/' + (i + 1),
          state: i === 0 ? 'open' : 'closed', draft: false, merged_at: null,
          base: { ref: 'dev' }, head: { ref: 'feature', sha: SHA },
          updated_at: '2026-10-18T00:00:00Z'
        }))
        : [];
    }
    else if (path.endsWith('/check-runs?per_page=100')) {
      response = { total_count: 1, check_runs: [
        { name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://github.com/check' }
      ] };
    }
    else if (path.endsWith('/status')) response = { state: 'success' };
    else return new Response('unknown route', { status: 404 });
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { mock, requests };
}

test('observes target branch, open PR and CI checks using only GET', async () => {
  const { mock, requests } = fixtureFetch();
  const snapshot = await new GithubReadonlyClient('test-placeholder', mock)
    .snapshot(target, new Date('2026-10-18T12:00:00Z'));
  assert.equal(snapshot.repo, target.fullName);
  assert.equal(snapshot.defaultBranch, 'main');
  assert.equal(snapshot.integrationSha, SHA);
  assert.equal(snapshot.pullRequests.length, 1);
  assert.equal(snapshot.pullRequests[0].checkRuns[0].conclusion, 'success');
  assert.equal(snapshot.pullRequests[0].checksObserved, true);
  assert.equal(snapshot.partial, false);
  assert.equal(snapshot.checkCoverage, 1);
  assert.ok(requests.every(r => r.init?.method === 'GET'));
  assert.ok(requests.every(r => r.url.startsWith('https://api.github.com/repos/' + target.fullName)));
});

test('missing dev branch is represented as missing, never silently replaced by main', async () => {
  const { mock } = fixtureFetch({ missingBranch: true });
  const snapshot = await new GithubReadonlyClient('test-placeholder', mock).snapshot(target);
  assert.equal(snapshot.integrationSha, null);
});

test('bounded PR enumeration reports unindexed data honestly', async () => {
  const { mock } = fixtureFetch({ fullPage: true });
  const snapshot = await new GithubReadonlyClient('test-placeholder', mock).snapshot(target);
  assert.equal(snapshot.pullRequests.length, 200);
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.checkCoverage, 1);
});

test('transport failures do not surface upstream secrets', async () => {
  const { mock } = fixtureFetch({ fail: true });
  await assert.rejects(() => new GithubReadonlyClient('test-placeholder', mock).snapshot(target),
    (error: unknown) => error instanceof GithubObserverError &&
      error.code === 'GH_HTTP_403' && !error.message.includes('leak'));
});

test('rejects fake origins and unsafe repository/branch strings', async () => {
  assert.throws(() => new GithubReadonlyClient('token', fetch, 'https://example.com'),
    (error: unknown) => error instanceof GithubObserverError && error.code === 'INVALID_API_ORIGIN');
  const { mock } = fixtureFetch();
  await assert.rejects(
    () => new GithubReadonlyClient('token', mock).snapshot({ ...target, fullName: '../../secret' }),
    (error: unknown) => error instanceof GithubObserverError && error.code === 'INVALID_REPOSITORY'
  );
  await assert.rejects(
    () => new GithubReadonlyClient('token', mock).snapshot({ ...target, integrationBranch: '../main' }),
    (error: unknown) => error instanceof GithubObserverError && error.code === 'INVALID_BRANCH'
  );
});

test('HMAC validates raw bytes and parses only allowlisted repos', () => {
  const secret = 'a-test-secret-long-enough-for-local-signatures';
  const body = Buffer.from(JSON.stringify({ repository: { full_name: target.fullName }, action: 'opened' }));
  const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  const headers = {
    'x-hub-signature-256': signature,
    'x-github-event': 'pull_request',
    'x-github-delivery': '9c84a245-fd07-4c4a-b745-9df056779cad'
  };
  assert.equal(verifyGithubSignature(body, signature, secret), true);
  assert.equal(verifyGithubSignature(Buffer.concat([body, Buffer.from(' ')]), signature, secret), false);
  const event = parseGithubWebhook(body, headers, secret, repositoryTargets());
  assert.equal(event?.repository, target.fullName);
  assert.equal(event?.type, 'pull_request');
  assert.equal(event?.payloadSha256.length, 64);
  assert.throws(() => parseGithubWebhook(body, { ...headers, 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
    secret, repositoryTargets()), /WEBHOOK_UNAUTHORIZED/);
  const other = Buffer.from(JSON.stringify({ repository: { full_name: 'attacker/repo' } }));
  const otherSig = 'sha256=' + createHmac('sha256', secret).update(other).digest('hex');
  assert.throws(() => parseGithubWebhook(other, { ...headers, 'x-hub-signature-256': otherSig },
    secret, repositoryTargets()), /WEBHOOK_REPOSITORY_NOT_ALLOWED/);
  assert.equal(parseGithubWebhook(body, { ...headers, 'x-github-event': 'ping' }, secret,
    repositoryTargets()), null);
});

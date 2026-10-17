/**
 * D1 read-only GitHub REST observer.
 * No GitHub write methods exist in this adapter. Check summaries are evidence,
 * not permissions to merge. API text (e.g. PR title) is untrusted data.
 */
export interface RepositoryTarget {
  project: string;
  fullName: string;
  integrationBranch: string;
}
export interface GithubCheck {
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
}
export interface GithubPullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  mergedAt: string | null;
  base: string;
  head: string;
  headSha: string;
  updatedAt: string;
  checkRuns: GithubCheck[];
  commitStatus: string;
  checksObserved: boolean;
}
export interface GithubSnapshot {
  repo: string;
  defaultBranch: string;
  integrationBranch: string;
  integrationSha: string | null;
  observedAt: string;
  pullRequests: GithubPullRequest[];
  partial: boolean;
  checkCoverage: number;
}
export class GithubObserverError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'GithubObserverError';
  }
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GithubObserverError('GH_INVALID_RESPONSE');
  }
  return value as Record<string, unknown>;
}
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function optionalStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new GithubObserverError('GH_INVALID_RESPONSE');
  return value;
}
function validateRepo(repo: string): string {
  if (!/^[a-zA-Z0-9_.-]{1,100}\/[a-zA-Z0-9_.-]{1,100}$/.test(repo) ||
      repo.includes('..')) throw new GithubObserverError('INVALID_REPOSITORY');
  return repo;
}
function validateBranch(branch: string): string {
  if (!branch || branch.length > 200 || !/^[a-zA-Z0-9._/-]+$/.test(branch) ||
      branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) {
    throw new GithubObserverError('INVALID_BRANCH');
  }
  return branch;
}
export type HttpFetch = (input: string, init?: RequestInit) => Promise<Response>;

export class GithubReadonlyClient {
  constructor(
    private readonly token: string,
    private readonly http: HttpFetch = fetch,
    private readonly api = 'https://api.github.com'
  ) {
    if (!token) throw new GithubObserverError('GH_TOKEN_REQUIRED');
    // Strict origin allowlist prevents credentials being forwarded to another host.
    if (api !== 'https://api.github.com') throw new GithubObserverError('INVALID_API_ORIGIN');
  }

  private async read(path: string): Promise<unknown> {
    const response = await this.http(this.api + path, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + this.token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Integron-Dev-Observer'
      },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      // Do not leak request paths, tokens, upstream response bodies or private titles.
      throw new GithubObserverError('GH_HTTP_' + response.status);
    }
    try { return await response.json(); }
    catch { throw new GithubObserverError('GH_INVALID_JSON'); }
  }

  async snapshot(target: RepositoryTarget, now = new Date()): Promise<GithubSnapshot> {
    const fullName = validateRepo(target.fullName);
    const branch = validateBranch(target.integrationBranch);
    const root = '/repos/' + fullName;
    const metadata = record(await this.read(root));
    const defaultBranch = str(metadata.default_branch);
    if (!defaultBranch) throw new GithubObserverError('GH_INVALID_RESPONSE');
    let integrationSha: string | null = null;
    try {
      const branchData = record(await this.read(root + '/branches/' + encodeURIComponent(branch)));
      integrationSha = str(record(branchData.commit).sha) || null;
    } catch (error) {
      if (!(error instanceof GithubObserverError && error.code === 'GH_HTTP_404')) throw error;
      // Missing integration branch must not silently fall back to default.
    }

    const prs: GithubPullRequest[] = [];
    let partial = false;
    // Bounded recent-PR window. Older PRs are deliberately not reported as fully indexed.
    for (let page = 1; page <= 2; page++) {
      const rows = array(await this.read(root + '/pulls?state=all&sort=updated&direction=desc&per_page=100&page=' + page));
      for (const item of rows) {
        const pr = record(item);
        const head = record(pr.head), base = record(pr.base);
        if (typeof pr.number !== 'number' || !Number.isInteger(pr.number)) {
          throw new GithubObserverError('GH_INVALID_RESPONSE');
        }
        prs.push({
          number: pr.number,
          title: str(pr.title).slice(0, 300),
          url: str(pr.html_url),
          state: str(pr.state),
          draft: pr.draft === true,
          mergedAt: optionalStr(pr.merged_at),
          base: str(base.ref),
          head: str(head.ref),
          headSha: str(head.sha),
          updatedAt: str(pr.updated_at),
          checkRuns: [],
          commitStatus: 'unknown',
          checksObserved: false
        });
      }
      if (rows.length < 100) break;
      if (page === 2) partial = true;
    }

    // Limit API costs. A PR without an observed check remains UNKNOWN, never green.
    let checkCoverage = 0;
    const recent = prs.filter(pr => pr.state === 'open' && pr.headSha).slice(0, 12);
    for (const pr of recent) {
      const sha = encodeURIComponent(pr.headSha);
      const checks = record(await this.read(root + '/commits/' + sha + '/check-runs?per_page=100'));
      const rows = array(checks.check_runs);
      pr.checkRuns = rows.map(row => {
        const value = record(row);
        return {
          name: str(value.name).slice(0, 150),
          status: str(value.status),
          conclusion: optionalStr(value.conclusion),
          url: optionalStr(value.html_url)
        };
      });
      // total_count > 100 means there are checks that are not in this snapshot.
      const truncatedChecks = typeof checks.total_count === 'number' && checks.total_count > rows.length;
      const status = record(await this.read(root + '/commits/' + sha + '/status'));
      pr.commitStatus = str(status.state) || 'unknown';
      pr.checksObserved = !truncatedChecks;
      if (pr.checksObserved) checkCoverage++;
    }
    return {
      repo: fullName,
      defaultBranch,
      integrationBranch: branch,
      integrationSha,
      observedAt: now.toISOString(),
      pullRequests: prs,
      partial,
      checkCoverage
    };
  }
}

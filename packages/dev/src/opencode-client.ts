/**
 * Minimal official OpenCode serve REST adapter. No shell, generic URL fetch,
 * file writes, OpenCode permission responses, or GitHub write capabilities.
 * API reference: https://opencode.ai/docs/server/
 */
import { AgentRunnerError, type AgentDiff, type AgentState } from './agent-runner.ts';

type Fetcher = typeof fetch;
export interface OpenCodeClientOptions {
  baseUrl: string;
  username?: string;
  password: string;
  timeoutMs?: number;
  fetcher?: Fetcher;
}
type JsonObject = Record<string, unknown>;
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
const SESSION_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const safeSessionId = (id: string): string => {
  if (!SESSION_ID.test(id)) throw new AgentRunnerError('INVALID_SESSION_ID');
  return id;
};
const validText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value);

export class OpenCodeClient {
  private readonly baseUrl: string;
  private readonly authentication: string;
  private readonly timeoutMs: number;
  private readonly fetcher: Fetcher;

  constructor(options: OpenCodeClientOptions) {
    const url = new URL(options.baseUrl);
    // OpenCode can edit files/run commands. Do not turn this into an SSRF proxy.
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
        !url.port || Number(url.port) < 1 || Number(url.port) > 65535 ||
        url.username || url.password || url.pathname !== '/' ||
        url.search || url.hash) {
      throw new AgentRunnerError('OPENCODE_LOOPBACK_ONLY');
    }
    if (!validText(options.password, 256) ||
        !/^[\x21-\x7e]{1,256}$/.test(options.password) ||
        !validText(options.username ?? 'opencode', 128) ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(options.username ?? 'opencode')) {
      throw new AgentRunnerError('OPENCODE_AUTH_REQUIRED');
    }
    this.baseUrl = url.origin;
    this.authentication = 'Basic ' + Buffer.from(
      (options.username ?? 'opencode') + ':' + options.password
    ).toString('base64');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 ||
        this.timeoutMs > 120_000) throw new AgentRunnerError('INVALID_TIMEOUT');
    this.fetcher = options.fetcher ?? fetch;
  }

  private async request(path: string, method: 'GET'|'POST', body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(this.baseUrl + path, {
        method, redirect: 'error', signal: controller.signal,
        headers: {
          authorization: this.authentication,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch {
      // For POST, transport failures may occur AFTER server accepted the work.
      // Caller must reconcile; never retry an uncertain external side effect.
      throw new AgentRunnerError(method === 'POST'
        ? 'OPENCODE_OUTCOME_UNKNOWN' : 'OPENCODE_UNAVAILABLE');
    } finally { clearTimeout(timeout); }
    if (!response.ok) {
      // Do not echo response bodies, credentials, prompt contents or URLs.
      throw new AgentRunnerError(response.status === 401 || response.status === 403
        ? 'OPENCODE_AUTH_FAILED' : 'OPENCODE_HTTP_ERROR');
    }
    if (response.status === 204) return null;
    if (Number(response.headers.get('content-length') ?? '0') > MAX_REPLY_BYTES) {
      throw new AgentRunnerError('OPENCODE_RESPONSE_TOO_LARGE');
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_REPLY_BYTES) {
      throw new AgentRunnerError('OPENCODE_RESPONSE_TOO_LARGE');
    }
    try { return JSON.parse(raw) as unknown; }
    catch { throw new AgentRunnerError('OPENCODE_INVALID_RESPONSE'); }
  }

  async health(): Promise<{ healthy: boolean; version: string }> {
    const value = await this.request('/global/health', 'GET');
    if (!isObject(value) || value.healthy !== true ||
        !validText(value.version, 100)) {
      throw new AgentRunnerError('OPENCODE_INVALID_RESPONSE');
    }
    return { healthy: true, version: value.version };
  }

  async directory(): Promise<string> {
    const value = await this.request('/path', 'GET');
    if (!isObject(value) || !validText(value.directory, 2048)) {
      throw new AgentRunnerError('OPENCODE_INVALID_RESPONSE');
    }
    return value.directory;
  }

  async createSession(title: string): Promise<string> {
    if (!validText(title, 200)) throw new AgentRunnerError('INVALID_TITLE');
    const value = await this.request('/session', 'POST', { title });
    if (!isObject(value) || typeof value.id !== 'string' ||
        !SESSION_ID.test(value.id)) throw new AgentRunnerError('OPENCODE_INVALID_RESPONSE');
    return value.id;
  }

  async getSession(id: string): Promise<void> {
    const value = await this.request('/session/' + safeSessionId(id), 'GET');
    if (!isObject(value) || value.id !== id) {
      throw new AgentRunnerError('OPENCODE_INVALID_RESPONSE');
    }
  }

  async startPrompt(id: string, prompt: string): Promise<void> {
    safeSessionId(id);
    if (!typeofStringPrompt(prompt)) throw new AgentRunnerError('INVALID_PROMPT');
    const result = await this.request('/session/' + id + '/prompt_async', 'POST', {
      parts: [{ type: 'text', text: prompt }]
    });
    if (result !== null) throw new AgentRunnerError('OPENCODE_INVALID_RESPONSE');
  }

  async status(id: string): Promise<AgentState> {
    safeSessionId(id);
    // Confirm identity before interpreting absence from status map as idle.
    await this.getSession(id);
    const result = await this.request('/session/status', 'GET');
    if (!isObject(result)) throw new AgentRunnerError('OPENCODE_INVALID_RESPONSE');
    const current = result[id];
    if (current === undefined) return 'idle';
    if (!isObject(current) || !['idle', 'busy', 'retry'].includes(String(current.type))) {
      return 'unknown';
    }
    return current.type as AgentState;
  }

  async abort(id: string): Promise<void> {
    const result = await this.request('/session/' + safeSessionId(id) + '/abort', 'POST');
    if (result !== true) throw new AgentRunnerError('OPENCODE_INVALID_RESPONSE');
  }

  async diffs(id: string): Promise<AgentDiff[]> {
    const value = await this.request('/session/' + safeSessionId(id) + '/diff', 'GET');
    if (!Array.isArray(value) || value.length > 500) {
      throw new AgentRunnerError('OPENCODE_INVALID_RESPONSE');
    }
    return value.map((item: unknown) => {
      if (!isObject(item) || !validText(item.file, 2048)) {
        throw new AgentRunnerError('OPENCODE_INVALID_RESPONSE');
      }
      const numberOrNull = (v: unknown): number | null =>
        typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
      return {
        path: item.file as string, additions: numberOrNull(item.additions),
        deletions: numberOrNull(item.deletions)
      };
    });
  }
}

function typeofStringPrompt(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 &&
    value.length <= 32_000 && !value.includes('\u0000');
}

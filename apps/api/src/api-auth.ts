import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = 'integron_session';
const SESSION_MS = 8 * 60 * 60 * 1_000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1_000;

function digest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Volatile, single-owner authentication for the localhost API. */
export function createOwnerAuth(secret: string, secureCookie = false) {
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 256 ||
      !/^[\x21-\x7e]+$/.test(secret)) {
    throw new Error('INTEGRON_API_TOKEN must be 32-256 printable ASCII characters');
  }
  const expected = digest(secret);
  const sessions = new Map<string, number>();
  const failures = new Map<string, { count: number; until: number }>();

  function tokenValid(value: unknown): boolean {
    if (typeof value !== 'string' || value.length > 256) return false;
    return timingSafeEqual(expected, digest(value));
  }
  function readSession(cookie: unknown): string | undefined {
    if (typeof cookie !== 'string' || cookie.length > 4096) return;
    const matches = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith(COOKIE + '='));
    if (matches.length !== 1) return;
    const id = matches[0].slice(COOKIE.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return;
    if ((sessions.get(id) ?? 0) <= Date.now()) { sessions.delete(id); return; }
    return id;
  }
  function authorize(headers: { authorization?: unknown; cookie?: unknown }) {
    const bearer = typeof headers.authorization === 'string'
      ? /^Bearer ([^\s]+)$/.exec(headers.authorization)?.[1] : undefined;
    if (bearer && tokenValid(bearer)) return { allowed: true, bearer: true };
    return { allowed: !!readSession(headers.cookie), bearer: false };
  }
  function login(token: unknown, source: string):
    | { ok: true; cookie: string }
    | { ok: false; status: number } {
    const now = Date.now();
    const prior = failures.get(source);
    if (prior && prior.until > now && prior.count >= MAX_FAILURES) return { ok: false, status: 429 };
    if (!tokenValid(token)) {
      if (failures.size > 128) failures.clear();
      failures.set(source, { count: prior && prior.until > now ? prior.count + 1 : 1,
        until: now + FAILURE_WINDOW_MS });
      return { ok: false, status: 401 };
    }
    failures.delete(source);
    for (const [id, expires] of sessions) if (expires <= now) sessions.delete(id);
    if (sessions.size >= 64) {
      const first = sessions.keys().next().value;
      if (first) sessions.delete(first);
    }
    const id = randomBytes(32).toString('base64url');
    sessions.set(id, now + SESSION_MS);
    return { ok: true, cookie: COOKIE + '=' + id +
      '; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800' + (secureCookie ? '; Secure' : '') };
  }
  function logout(cookie: unknown) {
    const id = readSession(cookie);
    if (id) sessions.delete(id);
    return COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' +
      (secureCookie ? '; Secure' : '');
  }
  return { authorize, login, logout };
}

export type OwnerAuth = ReturnType<typeof createOwnerAuth>;

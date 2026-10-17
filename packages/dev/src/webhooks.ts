import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { type RepositoryTarget } from './github.ts';

export const SUPPORTED_GITHUB_EVENTS = new Set([
  'push', 'pull_request', 'check_run', 'check_suite', 'workflow_run', 'status'
]);

/** HMAC over original raw bytes; never over reserialized JSON. */
export function verifyGithubSignature(
  body: Buffer, signature: string | undefined, secret: string
): boolean {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = Buffer.from(
    'sha256=' + createHmac('sha256', secret).update(body).digest('hex'), 'ascii'
  );
  const provided = Buffer.from(signature, 'ascii');
  return provided.length === expected.length && timingSafeEqual(expected, provided);
}
export interface GithubEvent {
  repository: string;
  deliveryId: string;
  type: string;
  payloadSha256: string;
}
export function parseGithubWebhook(
  body: Buffer, headers: Record<string, string | undefined>,
  secret: string, allowed: RepositoryTarget[]
): GithubEvent | null {
  if (body.length > 262_144) throw new Error('WEBHOOK_TOO_LARGE');
  if (!verifyGithubSignature(body, headers['x-hub-signature-256'], secret)) {
    throw new Error('WEBHOOK_UNAUTHORIZED');
  }
  const type = headers['x-github-event'] ?? '';
  // Ping and unrelated events are verified, then acknowledged without side effects.
  if (!SUPPORTED_GITHUB_EVENTS.has(type)) return null;
  const deliveryId = headers['x-github-delivery'] ?? '';
  if (!/^[a-fA-F0-9-]{36}$/.test(deliveryId)) throw new Error('WEBHOOK_INVALID_DELIVERY');
  let data: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    data = value as Record<string, unknown>;
  } catch { throw new Error('WEBHOOK_INVALID_JSON'); }
  const repository = data.repository;
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) {
    throw new Error('WEBHOOK_INVALID_REPOSITORY');
  }
  const fullName = (repository as Record<string, unknown>).full_name;
  if (typeof fullName !== 'string' || !allowed.some(target => target.fullName === fullName)) {
    throw new Error('WEBHOOK_REPOSITORY_NOT_ALLOWED');
  }
  return {
    repository: fullName, deliveryId, type,
    payloadSha256: createHash('sha256').update(body).digest('hex')
  };
}

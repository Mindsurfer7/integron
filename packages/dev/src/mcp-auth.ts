import { createHash, timingSafeEqual } from 'node:crypto';
import { DEVELOPMENT_PROJECTS } from './registry.ts';

export interface DevMcpPrincipal {
  actorId: string;
  role: 'read' | 'write';
  allowedProjects: readonly string[];
}
export interface DevMcpTokens {
  readToken: string;
  writeToken: string;
  allowedProjects?: string;
}
const ALLOWED = new Set(DEVELOPMENT_PROJECTS.map(p => p.slug));
function fingerprint(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}
function requireToken(token: string, label: string): Buffer {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256 ||
      !/^[\x21-\x7e]+$/.test(token)) {
    throw new Error(label + ' must be 32–256 printable ASCII characters');
  }
  return fingerprint(token);
}
export function parseDevAllowedProjects(value?: string): readonly string[] {
  const names = value ? value.split(',').map(x => x.trim()) : [...ALLOWED];
  if (!names.length || new Set(names).size !== names.length ||
      names.some(name => !ALLOWED.has(name))) {
    throw new Error('Invalid INTEGRON_DEV_MCP_ALLOWED_PROJECTS');
  }
  return Object.freeze([...names]);
}
/** Two separate local-only credentials; never use the outreach API cookie. */
export function createDevMcpAuth(options: DevMcpTokens) {
  const read = requireToken(options.readToken, 'INTEGRON_DEV_MCP_READ_TOKEN');
  const write = requireToken(options.writeToken, 'INTEGRON_DEV_MCP_WRITE_TOKEN');
  if (timingSafeEqual(read, write)) throw new Error('D3 read/write credentials must differ');
  const allowedProjects = parseDevAllowedProjects(options.allowedProjects);

  function authorize(header: unknown): DevMcpPrincipal | null {
    if (typeof header !== 'string' || header.length > 300) return null;
    const match = /^Bearer ([\x21-\x7e]+)$/.exec(header);
    if (!match) return null;
    const digest = fingerprint(match[1]);
    const isRead = timingSafeEqual(read, digest);
    const isWrite = timingSafeEqual(write, digest);
    if (!isRead && !isWrite) return null;
    return Object.freeze({
      actorId: 'local-owner', role: isWrite ? 'write' : 'read', allowedProjects
    }) as DevMcpPrincipal;
  }
  return { authorize };
}
/** Enforce scoped access in every tool, independently of schemas or UI hints. */
export function requireDevScope(principal: DevMcpPrincipal, projectSlug: string, write = false) {
  if (!principal.allowedProjects.includes(projectSlug)) {
    throw new DevMcpAuthError('PROJECT_FORBIDDEN');
  }
  if (write && principal.role !== 'write') {
    throw new DevMcpAuthError('WRITE_FORBIDDEN');
  }
}
export class DevMcpAuthError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'DevMcpAuthError';
  }
}
/** Additional defense for browser-origin and DNS rebinding. */
export function localMcpHostAllowed(host: unknown, origin: unknown): boolean {
  if (typeof host !== 'string' || !/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host)) {
    return false;
  }
  if (origin === undefined) return true;
  return typeof origin === 'string' && origin === 'http://' + host;
}

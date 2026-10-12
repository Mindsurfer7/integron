#!/usr/bin/env node
// Offline preflight only: no login, network calls, personal data or real sends.
import { existsSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { execFileSync } from 'node:child_process';

const mode = process.argv[2] || 'local';
if (!['local', 'tdlib'].includes(mode)) {
  console.error('Usage: node scripts/local-preflight.mjs [local|tdlib]');
  process.exit(2);
}
let errors = 0;
const check = (ok, description) => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${description}`);
  if (!ok) errors++;
};
const warn = description => console.log(`INFO ${description}`);
const version = process.versions.node.split('.').map(Number);
const validNode = version[0] > 22 || version[0] === 22 && version[1] >= 16;
check(validNode, 'Node.js >= 22.16');
warn(`runtime: ${platform()} / ${arch()}`);
if (platform() !== 'darwin' && platform() !== 'linux') warn('Mac/Linux are the documented targets');
try {
  execFileSync('docker', ['--version'], { stdio: 'ignore', timeout: 5000 });
  warn('Docker CLI available (PostgreSQL container not verified)');
} catch { warn('Docker CLI absent; it is optional for demo, required for Docker PostgreSQL'); }
if (mode === 'tdlib') {
  const env = process.env;
  const ids = (env.TDLIB_ALLOWED_CHAT_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  const validId = id => /^[1-9][0-9]{0,15}$/.test(id) && Number.isSafeInteger(Number(id));
  check(env.OUTBOUND_ENABLED === undefined || env.OUTBOUND_ENABLED === 'false',
    'global outbound remains disabled');
  check(env.TEST_TDLIB_ENABLED === 'true', 'TDLib test explicitly enabled');
  check(ids.length >= 1 && ids.length <= 2 && ids.every(validId) &&
    new Set(ids).size === ids.length, '1–2 unique valid allowlisted test IDs');
  check(Boolean(env.DATABASE_URL?.startsWith('postgresql://') ||
    env.DATABASE_URL?.startsWith('postgres://')), 'DATABASE_URL configured');
  check(/^[1-9][0-9]*$/.test(env.TDLIB_API_ID || '') &&
    Number.isSafeInteger(Number(env.TDLIB_API_ID)), 'TDLIB_API_ID configured');
  check(/^[0-9a-f]{32}$/i.test(env.TDLIB_API_HASH || ''), 'TDLIB_API_HASH format');
  check(validId(env.TDLIB_AGENT_USER_ID || '') &&
    !ids.includes(env.TDLIB_AGENT_USER_ID) &&
    env.TDLIB_AGENT_USER_ID !== env.OWNER_TELEGRAM_USER_ID,
    'separate expected TDLib agent identity');
  check(!env.TDJSON_PATH || env.TDJSON_PATH.startsWith('/') && existsSync(env.TDJSON_PATH),
    'optional TDJSON_PATH points to existing absolute library');
  warn('No native login, DB connection, TDLib load, contact consent or send verified');
} else {
  warn('Offline demo command: pnpm dev:demo');
  warn('Local PostgreSQL: docker compose -f infra/compose/local-postgres.yml up -d');
  warn('TDLib opt-in preflight: pnpm preflight:tdlib (with local secrets set)');
}
if (errors) {
  console.error(`${errors} preflight check(s) failed. No outbound actions attempted.`);
  process.exitCode = 1;
} else {
  console.log('Offline preflight passed. No outbound actions attempted.');
}

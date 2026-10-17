/** D5c operator-only PR observation. Uses read-only GitHub credentials. */
import { PrismaClient } from '@prisma/client';
import { GithubReadonlyClient } from '../../../packages/dev/src/github.ts';
import { DevPrEvidenceStore } from '../../../packages/dev/src/pr-evidence.ts';

if (process.env.RUNTIME_PROFILE !== 'postgres' || !process.env.DATABASE_URL ||
    process.env.OUTBOUND_ENABLED !== 'false') {
  throw new Error('D5c needs local PostgreSQL and OUTBOUND_ENABLED=false');
}
if (!process.env.GITHUB_READ_TOKEN) throw new Error('GITHUB_READ_TOKEN_REQUIRED');
const [action, sessionId, prText, ...extra] = process.argv.slice(2);
if (action !== '--observe' || !sessionId || !/^[1-9][0-9]{0,6}$/.test(prText ?? '') ||
    extra.length) {
  throw new Error('Usage: dev:agent:pr --observe <session-uuid> <pr-number>');
}
const db = new PrismaClient();
try {
  await db.$connect();
  const service = new DevPrEvidenceStore(db,
    new GithubReadonlyClient(process.env.GITHUB_READ_TOKEN));
  const result = await service.observe(sessionId, Number(prText));
  console.log(JSON.stringify(result, null, 2));
  console.log('GitHub PR evidence observed. This did NOT accept the task, merge PR or trigger CI.');
} finally {
  await db.$disconnect();
}

/**
 * Human-only D3 approval. Never exposed as MCP tool.
 * Usage: pnpm dev:mcp:approve --inspect <id>
 *        pnpm dev:mcp:approve --approve <id> <digest>
 *        pnpm dev:mcp:approve --reject <id> <digest>
 */
import { createInterface } from 'node:readline/promises';
import { PrismaClient } from '@prisma/client';
import { DevMcpService } from '../../../packages/dev/src/mcp-service.ts';

const [command, id, claimedDigest, ...extra] = process.argv.slice(2);
if (!process.env.DATABASE_URL || process.env.RUNTIME_PROFILE !== 'postgres') {
  throw new Error('Local Postgres environment required');
}
if (!['--inspect', '--approve', '--reject'].includes(command ?? '') ||
    !id || extra.length || (command !== '--inspect' && !claimedDigest)) {
  throw new Error('Usage: --inspect <id> | --approve <id> <digest> | --reject <id> <digest>');
}
if (command !== '--inspect' && (!process.stdin.isTTY || !process.stdout.isTTY)) {
  throw new Error('Out-of-band owner approval requires an interactive terminal');
}
const db = new PrismaClient();
try {
  await db.$connect();
  const service = new DevMcpService(db);
  const details = await service.inspectLocalDecision(id);
  console.log(JSON.stringify(details, null, 2));
  if (command !== '--inspect') {
    if (claimedDigest !== details.digest) throw new Error('DIGEST_MISMATCH');
    if (details.state !== 'pending') throw new Error('DECISION_NOT_PENDING');
    if (Date.parse(details.expiresAt) <= Date.now()) throw new Error('DECISION_EXPIRED');
    const confirmWord = command === '--approve' ? 'APPROVE' : 'REJECT';
    const prompt = confirmWord + ' ' + details.digest.slice(0, 12);
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const entered = await terminal.question('Type "' + prompt + '" to confirm: ');
      if (entered !== prompt) throw new Error('OWNER_CONFIRMATION_MISMATCH');
    } finally { terminal.close(); }
    const choice = command === '--approve' ? 'approve' : 'reject';
    const result = await service.localDecision(id, claimedDigest!, choice);
    console.log(JSON.stringify(result));
  }
} finally {
  await db.$disconnect();
}

/**
 * Operator-only D5b CLI. This is NOT a remote MCP or HTTP API.
 *
 * Usage:
 *   pnpm dev:agent:local --prepare /path/to/reviewed-intent.json
 *   pnpm dev:agent:local --inspect <execution-uuid>
 *   pnpm dev:agent:local --approve <execution-uuid> <digest>
 *   pnpm dev:agent:local --run <execution-uuid> <digest>
 *   pnpm dev:agent:local --expire <execution-uuid>
 *   pnpm dev:agent:local --reconcile
 */
import { readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { PrismaClient } from '@prisma/client';
import { DevExecutionStore } from '../../../packages/dev/src/execution-store.ts';
import { dispatchApprovedSession } from '../../../packages/dev/src/managed-session.ts';
import { OpenCodeClient } from '../../../packages/dev/src/opencode-client.ts';
import { verifyManagedWorktree } from '../../../packages/dev/src/worktree-guard.ts';

if (process.env.RUNTIME_PROFILE !== 'postgres' || !process.env.DATABASE_URL) {
  throw new Error('D5b requires RUNTIME_PROFILE=postgres and DATABASE_URL');
}
if (process.env.OUTBOUND_ENABLED !== 'false') {
  throw new Error('D5b local operation requires OUTBOUND_ENABLED=false');
}

const [command, ...args] = process.argv.slice(2);
const usages: Record<string, number> = {
  '--prepare': 1, '--inspect': 1, '--approve': 2,
  '--run': 2, '--expire': 1, '--reconcile': 0
};
if (!command || usages[command] === undefined || args.length !== usages[command]) {
  throw new Error('Usage: --prepare <json> | --inspect <id> | --approve <id> <digest> | --run <id> <digest> | --expire <id> | --reconcile');
}

async function confirmHuman(action: 'APPROVE' | 'RUN', digest: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('LOCAL_OWNER_TTY_REQUIRED');
  }
  const prompt = action + ' ' + digest.slice(0, 12);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const entered = await terminal.question('Type "' + prompt + '" to confirm: ');
    if (entered !== prompt) throw new Error('LOCAL_OWNER_CONFIRMATION_MISMATCH');
  } finally {
    terminal.close();
  }
}

const db = new PrismaClient();
try {
  await db.$connect();
  const store = new DevExecutionStore(db);
  if (command === '--prepare') {
    const stats = await stat(args[0]);
    if (!stats.isFile() || stats.size > 8192) throw new Error('INTENT_FILE_INVALID');
    const raw: unknown = JSON.parse(await readFile(args[0], 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INTENT_FILE_INVALID');
    const input = raw as Record<string, unknown>;
    // Fail closed if file attempts to smuggle an action, approval, or credentials.
    const permitted = new Set(['taskId', 'repository', 'directory', 'branch',
      'baseSha', 'title', 'requestKey', 'maxCostCents']);
    if (Object.keys(input).some(k => !permitted.has(k))) throw new Error('INTENT_FILE_INVALID');
    const prepared = await store.prepareCreate(input as never);
    console.log(JSON.stringify(prepared, null, 2));
    console.log('Only a pending reservation exists. No OpenCode operation was run.');
  } else if (command === '--inspect') {
    const inspected = await store.inspect(args[0]);
    console.log(JSON.stringify(inspected, null, 2));
  } else if (command === '--approve') {
    const inspected = await store.inspect(args[0]);
    if (inspected.digest !== args[1] || inspected.state !== 'pending' ||
        new Date(inspected.expiresAt).getTime() <= Date.now()) {
      throw new Error('INVALID_OR_EXPIRED_APPROVAL');
    }
    console.log(JSON.stringify(inspected, null, 2));
    await confirmHuman('APPROVE', inspected.digest);
    console.log(JSON.stringify(await store.approveLocal(args[0], args[1], 'local-owner')));
  } else if (command === '--run') {
    const inspected = await store.inspect(args[0]);
    if (inspected.digest !== args[1] || inspected.state !== 'approved' ||
        inspected.approvedBy !== 'local-owner' ||
        new Date(inspected.expiresAt).getTime() <= Date.now()) {
      throw new Error('INVALID_OR_EXPIRED_EXECUTION');
    }
    if (inspected.intent.maxCostCents !== 0) {
      throw new Error('COST_GUARD_REQUIRES_ZERO_BUDGET_FOR_SESSION_CREATE');
    }
    if (!process.env.OPENCODE_SERVER_PASSWORD || !process.env.OPENCODE_SERVER_URL) {
      throw new Error('LOCAL_OPENCODE_CONFIGURATION_REQUIRED');
    }
    console.log(JSON.stringify(inspected, null, 2));
    await confirmHuman('RUN', inspected.digest);
    if (!process.env.OPENCODE_ALLOWED_WORKTREE_ROOT) {
      throw new Error('OPENCODE_ALLOWED_WORKTREE_ROOT_REQUIRED');
    }
    await verifyManagedWorktree(inspected.intent, process.env.OPENCODE_ALLOWED_WORKTREE_ROOT);
    const client = new OpenCodeClient({
      baseUrl: process.env.OPENCODE_SERVER_URL,
      password: process.env.OPENCODE_SERVER_PASSWORD,
      username: process.env.OPENCODE_SERVER_USERNAME ?? 'opencode'
    });
    console.log(JSON.stringify(await dispatchApprovedSession(
      store, client, inspected.id, inspected.digest
    )));
  } else if (command === '--expire') {
    console.log(JSON.stringify({ expired: await store.expireUnattempted(args[0]) }));
  } else if (command === '--reconcile') {
    console.log(JSON.stringify(await store.listReconciliationNeeded(), null, 2));
  }
} finally {
  await db.$disconnect();
}

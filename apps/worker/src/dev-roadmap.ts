/**
 * D2 local operator CLI. Reads PostgreSQL; the optional manifest import
 * changes only roadmap registry records, never GitHub or an agent session.
 */
import { stat, readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { DevRoadmapStore } from '../../../packages/dev/src/roadmap-store.ts';

if (process.env.RUNTIME_PROFILE !== 'postgres' || !process.env.DATABASE_URL) {
  throw new Error('D2 CLI requires RUNTIME_PROFILE=postgres and DATABASE_URL');
}
const [mode, ...args] = process.argv.slice(2);
if (!['--plan', '--import'].includes(mode) ||
    (mode === '--plan' && args.length !== 0) ||
    (mode === '--import' && (args.length !== 1 || !args[0]))) {
  throw new Error('Usage: dev:roadmap --plan | --import <local-manifest.json>');
}
const db = new PrismaClient();
try {
  await db.$connect();
  const store = new DevRoadmapStore(db);
  if (mode === '--import') {
    const filename = args[0];
    const info = await stat(filename);
    if (!info.isFile() || info.size > 262_144) throw new Error('MANIFEST_TOO_LARGE');
    const parsed: unknown = JSON.parse(await readFile(filename, 'utf8'));
    const summary = await store.importManifest(parsed);
    console.log(JSON.stringify({ action: 'import', ...summary }));
  } else {
    const plan = await store.plan();
    console.log(JSON.stringify({ action: 'plan', ...plan }, null, 2));
  }
} finally {
  await db.$disconnect();
}

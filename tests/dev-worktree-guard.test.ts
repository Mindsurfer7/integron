import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { verifyManagedWorktree } from '../packages/dev/src/worktree-guard.ts';
import { createManagedIntent } from '../packages/dev/src/execution-intent.ts';

test('D5b preflight rejects wrong root, branch, HEAD, remote and dirty checkout', async () => {
  const base = await mkdtemp(join(tmpdir(), 'integron-d5-worktree-'));
  const dir = join(base, 'approved-worktree');
  await mkdir(dir);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-b', 'feat/approved-worktree');
    git('config', 'user.name', 'CI Test');
    git('config', 'user.email', 'ci@example.invalid');
    await writeFile(join(dir, 'README.md'), 'fresh worktree\n');
    git('add', 'README.md');
    git('commit', '-m', 'base');
    git('remote', 'add', 'origin', 'https://github.com/Qonbex/qonbaq.git');
    const intent = createManagedIntent({
      taskId: randomUUID(), repository: 'Qonbex/qonbaq', directory: dir,
      branch: 'feat/approved-worktree', baseSha: git('rev-parse', 'HEAD'),
      requestKey: 'd5b_worktree_1234', title: 'Local preflight', maxCostCents: 0
    });
    await verifyManagedWorktree(intent, base);
    await assert.rejects(verifyManagedWorktree(intent, dir), /WORKTREE_OUT_OF_SCOPE/);
    await assert.rejects(verifyManagedWorktree({
      ...intent, branch: 'feat/other'
    }, base), /WORKTREE_BRANCH_MISMATCH/);
    await assert.rejects(verifyManagedWorktree({
      ...intent, baseSha: 'b'.repeat(40)
    }, base), /WORKTREE_BASE_SHA_MISMATCH/);
    git('remote', 'set-url', 'origin', 'https://github.com/attacker/other.git');
    await assert.rejects(verifyManagedWorktree(intent, base), /WORKTREE_REPOSITORY_MISMATCH/);
    git('remote', 'set-url', 'origin', 'https://github.com/Qonbex/qonbaq.git');
    await writeFile(join(dir, 'UNTRACKED.md'), 'should block');
    await assert.rejects(verifyManagedWorktree(intent, base), /WORKTREE_NOT_CLEAN/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

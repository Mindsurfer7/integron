/**
 * Read-only preflight for local D5b OpenCode session creation.
 * Checks worktree identity; NOT an OS sandbox or execution authorization.
 */
import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { relative, isAbsolute, sep } from 'node:path';
import { AgentRunnerError } from './agent-runner.ts';
import { type ManagedCreateIntent } from './execution-intent.ts';

const exec = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
function safeRemote(remote: string, repository: string): boolean {
  return remote === 'https://github.com/' + repository + '.git' ||
    remote === 'https://github.com/' + repository ||
    remote === 'git@github.com:' + repository + '.git' ||
    remote === 'ssh://git@github.com/' + repository + '.git';
}
async function git(directory: string, ...args: string[]): Promise<string> {
  try {
    const output = await exec('git', args, {
      cwd: directory, timeout: 5000, maxBuffer: 65536,
      env: {
        ...process.env, GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_GLOBAL: '/dev/null'
      }
    });
    return output.stdout.trim();
  } catch {
    throw new AgentRunnerError('WORKTREE_PREFLIGHT_FAILED');
  }
}

/**
 * Fail closed unless an exact clean, existing feature worktree is inside
 * the owner's explicitly trusted root, on the reviewed SHA and repository.
 */
export async function verifyManagedWorktree(
  intent: ManagedCreateIntent, allowedRoot: string
): Promise<void> {
  if (!isAbsolute(allowedRoot) || allowedRoot === '/' ||
      !SHA.test(intent.baseSha)) throw new AgentRunnerError('INVALID_WORKTREE_ROOT');
  let root: string, directory: string;
  try {
    root = await realpath(allowedRoot);
    directory = await realpath(intent.directory);
  } catch { throw new AgentRunnerError('WORKTREE_NOT_FOUND'); }
  const delta = relative(root, directory);
  if (!delta || delta === '..' || delta.startsWith('..' + sep) ||
      isAbsolute(delta)) throw new AgentRunnerError('WORKTREE_OUT_OF_SCOPE');
  if (await git(directory, 'rev-parse', '--is-inside-work-tree') !== 'true' ||
      await realpath(await git(directory, 'rev-parse', '--show-toplevel')) !== directory) {
    throw new AgentRunnerError('WORKTREE_NOT_ROOT');
  }
  if (await git(directory, 'branch', '--show-current') !== intent.branch) {
    throw new AgentRunnerError('WORKTREE_BRANCH_MISMATCH');
  }
  if (await git(directory, 'rev-parse', 'HEAD') !== intent.baseSha) {
    throw new AgentRunnerError('WORKTREE_BASE_SHA_MISMATCH');
  }
  if (!safeRemote(await git(directory, 'remote', 'get-url', 'origin'),
      intent.repository)) throw new AgentRunnerError('WORKTREE_REPOSITORY_MISMATCH');
  if (await git(directory, 'status', '--porcelain=v1', '--untracked-files=all')) {
    throw new AgentRunnerError('WORKTREE_NOT_CLEAN');
  }
}

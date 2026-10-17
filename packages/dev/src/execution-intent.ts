/** Immutable metadata; do not persist raw prompts, API keys or cookies. */
import { createHash } from 'node:crypto';
import { AgentRunnerError } from './agent-runner.ts';
import { DEVELOPMENT_PROJECTS } from './registry.ts';

export interface ManagedCreateIntent {
  version: 1;
  action: 'create_session';
  taskId: string;
  repository: string;
  directory: string;
  branch: string;
  baseSha: string;
  title: string;
  requestKey: string;
  maxCostCents: number;
}
export const uuidFormat = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyFormat = /^[a-zA-Z0-9_-]{12,80}$/;
export function createManagedIntent(input: Omit<ManagedCreateIntent, 'version'|'action'>): ManagedCreateIntent {
  if (!uuidFormat.test(input.taskId) || !keyFormat.test(input.requestKey)) {
    throw new AgentRunnerError('INVALID_EXECUTION_IDENTITY');
  }
  if (!DEVELOPMENT_PROJECTS.some(p => p.repos.some(r => r.fullName === input.repository))) {
    throw new AgentRunnerError('UNRECOGNIZED_REPOSITORY');
  }
  if (typeof input.directory !== 'string' || !/^\/[a-zA-Z0-9_./+-]{1,2047}$/.test(input.directory) ||
      input.directory.endsWith('/') || input.directory.includes('//') ||
      input.directory.split('/').some(p => p === '.' || p === '..')) {
    throw new AgentRunnerError('INVALID_WORKSPACE');
  }
  if (typeof input.branch !== 'string' || !/^feat\/[a-zA-Z0-9][a-zA-Z0-9._/-]{1,127}$/.test(input.branch) ||
      input.branch.includes('..') || input.branch.includes('//') || input.branch.endsWith('/') ||
      input.branch.endsWith('.lock') || input.branch.split('/').some(p => p.startsWith('.'))) {
    throw new AgentRunnerError('INVALID_BRANCH');
  }
  if (typeof input.baseSha !== 'string' || !/^[0-9a-f]{40}$/.test(input.baseSha)) {
    throw new AgentRunnerError('INVALID_INTEGRATION_SHA');
  }
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(input.title)) {
    throw new AgentRunnerError('INVALID_EXECUTION_TITLE');
  }
  if (!Number.isInteger(input.maxCostCents) || input.maxCostCents < 0 ||
      input.maxCostCents > 100_000) throw new AgentRunnerError('INVALID_EXECUTION_BUDGET');
  return Object.freeze({
    version: 1, action: 'create_session', taskId: input.taskId,
    repository: input.repository, directory: input.directory,
    branch: input.branch, baseSha: input.baseSha, title: input.title, requestKey: input.requestKey,
    maxCostCents: input.maxCostCents
  });
}
export function digestManagedIntent(intent: ManagedCreateIntent): string {
  return createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}
export type ExecutionState =
  'pending' | 'approved' | 'attempting' | 'acknowledged' |
  'unknown' | 'rejected' | 'expired';
export type AgentSessionState = 'reserved' | 'creating' | 'active' | 'unknown' | 'closed';
export function canTransitionExecution(from: ExecutionState, to: ExecutionState): boolean {
  const edges: Record<ExecutionState, readonly ExecutionState[]> = {
    pending: ['approved', 'rejected', 'expired'],
    approved: ['attempting', 'expired'],
    attempting: ['acknowledged', 'unknown'],
    acknowledged: [], unknown: [], rejected: [], expired: []
  };
  return edges[from]?.includes(to) ?? false;
}

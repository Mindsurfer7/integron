/** D5d approved prompt metadata. Never persist the raw user prompt. */
import { createHash } from 'node:crypto';
import { AgentRunnerError } from './agent-runner.ts';
import { createManagedIntent, uuidFormat } from './execution-intent.ts';

export interface ManagedPromptIntent {
  version: 1;
  action: 'start_task';
  taskId: string;
  sessionId: string;
  repository: string;
  directory: string;
  branch: string;
  baseSha: string;
  externalId: string;
  requestKey: string;
  promptSha256: string;
  model: { providerID: 'ollama'; modelID: string };
  maxCostCents: 0;
}
export function createManagedPromptIntent(
  input: Omit<ManagedPromptIntent, 'version' | 'action'>
): ManagedPromptIntent {
  if (!uuidFormat.test(input.sessionId) ||
      typeof input.externalId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.externalId) ||
      typeof input.promptSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.promptSha256) ||
      input.maxCostCents !== 0 ||
      !input.model || input.model.providerID !== 'ollama' ||
      typeof input.model.modelID !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{1,100}$/.test(input.model.modelID)) {
    throw new AgentRunnerError('INVALID_LOCAL_PROMPT_INTENT');
  }
  // Reuse all D5b repository/worktree/branch/identity constraints.
  const create = createManagedIntent({
    taskId: input.taskId, repository: input.repository,
    directory: input.directory, branch: input.branch,
    baseSha: input.baseSha, requestKey: input.requestKey,
    title: 'Local agent prompt', maxCostCents: 0
  });
  return Object.freeze({
    version: 1, action: 'start_task', taskId: create.taskId,
    sessionId: input.sessionId, repository: create.repository,
    directory: create.directory, branch: create.branch, baseSha: create.baseSha,
    externalId: input.externalId, requestKey: create.requestKey,
    promptSha256: input.promptSha256,
    model: { providerID: 'ollama', modelID: input.model.modelID },
    maxCostCents: 0
  });
}
export function digestManagedPromptIntent(intent: ManagedPromptIntent): string {
  return createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}
export function promptSha256(prompt: string): string {
  if (typeof prompt !== 'string' || !prompt.trim() ||
      prompt.length > 32_000 || prompt.includes('\u0000')) {
    throw new AgentRunnerError('INVALID_TASK_PROMPT');
  }
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

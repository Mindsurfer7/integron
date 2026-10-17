/**
 * D5d: locally owner-approved first coding prompt via pinned LOCAL Ollama.
 * Never submits without durable approval, model/config gates and fencing.
 */
import { AgentRunnerError, type AgentSession } from './agent-runner.ts';
import { DevExecutionStore } from './execution-store.ts';
import { OpenCodeClient } from './opencode-client.ts';
import { OpenCodeManagedRunner } from './opencode-runner.ts';
import { promptSha256 } from './prompt-intent.ts';

export async function dispatchApprovedLocalPrompt(
  store: DevExecutionStore, client: OpenCodeClient,
  executionId: string, digest: string, prompt: string
): Promise<{ state: 'acknowledged'; promptSha256: string }> {
  const viewed = await store.inspectPrompt(executionId);
  if (viewed.digest !== digest || viewed.state !== 'approved' ||
      viewed.approvedBy !== 'local-owner' ||
      promptSha256(prompt) !== viewed.intent.promptSha256) {
    throw new AgentRunnerError('PROMPT_APPROVAL_MISMATCH');
  }
  // Read-only preflight before consuming approval: no network/paid model,
  // no implicit default model, deny-all permissions except local edits/reads.
  await client.assertRestrictedLocalModel(viewed.intent.model.modelID);
  const claimed = await store.claimPromptApproved(executionId, digest);
  const intent = claimed.intent;
  const session: AgentSession = {
    provider: 'opencode', taskId: intent.taskId,
    externalId: intent.externalId, repository: intent.repository,
    directory: intent.directory
  };
  const runner = new OpenCodeManagedRunner({
    client, repository: intent.repository, directory: intent.directory,
    authorize: async action => {
      if (action.action !== 'start_task' ||
          action.taskId !== intent.taskId ||
          action.externalId !== intent.externalId ||
          action.repository !== intent.repository ||
          action.directory !== intent.directory ||
          action.idempotencyKey !== intent.requestKey ||
          action.promptSha256 !== intent.promptSha256 ||
          action.modelProviderId !== 'ollama' ||
          action.modelId !== intent.model.modelID) {
        throw new AgentRunnerError('PROMPT_AUTHORIZATION_MISMATCH');
      }
    }
  });
  try {
    // Repeat permission guard after durable claim; a changed configuration
    // remains UNKNOWN after claim, never a permission to switch to paid default.
    await client.assertRestrictedLocalModel(intent.model.modelID);
    await runner.startTask(session, {
      taskId: intent.taskId, prompt, idempotencyKey: intent.requestKey,
      model: intent.model
    });
    await store.settlePromptAttempt(executionId, claimed.fence, {
      outcome: 'acknowledged'
    });
    return { state: 'acknowledged', promptSha256: intent.promptSha256 };
  } catch (error) {
    try {
      await store.settlePromptAttempt(executionId, claimed.fence, {
        outcome: 'unknown',
        errorCode: error instanceof AgentRunnerError ?
          error.code : 'OPENCODE_OUTCOME_UNKNOWN'
      });
    } catch {
      throw new AgentRunnerError('EXECUTION_RECONCILIATION_REQUIRED');
    }
    throw error instanceof AgentRunnerError
      ? error : new AgentRunnerError('OPENCODE_OUTCOME_UNKNOWN');
  }
}

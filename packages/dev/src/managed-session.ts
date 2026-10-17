/**
 * D5b one-shot LOCAL session creation. Never starts a prompt, creates PRs,
 * runs shell commands or acts on unauthenticated MCP requests.
 */
import { AgentRunnerError } from './agent-runner.ts';
import { DevExecutionStore } from './execution-store.ts';
import { OpenCodeClient } from './opencode-client.ts';
import { OpenCodeManagedRunner } from './opencode-runner.ts';

export async function dispatchApprovedSession(
  store: DevExecutionStore,
  client: OpenCodeClient,
  executionId: string,
  digest: string
): Promise<{ externalId: string; state: 'acknowledged' }> {
  // Record a fenced attempt BEFORE any provider side effect. A crash leaves
  // 'attempting' in the DB. There is deliberately no retry from that state.
  const claimed = await store.claimApproved(executionId, digest);
  const { intent } = claimed;
  if (intent.maxCostCents !== 0) {
    // The create-session call is restricted to $0; ongoing provider spending
    // needs a separate metered budget enforcement mechanism.
    await store.settleAttempt(executionId, claimed.fence, {
      outcome: 'unknown', errorCode: 'BUDGET_GATE_NOT_IMPLEMENTED'
    });
    throw new AgentRunnerError('BUDGET_GATE_NOT_IMPLEMENTED');
  }
  const runner = new OpenCodeManagedRunner({
    client, repository: intent.repository, directory: intent.directory,
    authorize: async action => {
      if (action.action !== 'create_session' || action.taskId !== intent.taskId ||
          action.repository !== intent.repository || action.directory !== intent.directory ||
          action.idempotencyKey !== intent.requestKey) {
        throw new AgentRunnerError('EXECUTION_AUTHORIZATION_MISMATCH');
      }
      // This callback is only built AFTER durable claimApproved validated
      // a one-shot, owner-confirmed action. It never signs future actions.
    }
  });
  try {
    const session = await runner.createSession({
      taskId: intent.taskId, repository: intent.repository,
      title: intent.title, idempotencyKey: intent.requestKey
    });
    await store.settleAttempt(executionId, claimed.fence, {
      outcome: 'acknowledged', externalId: session.externalId
    });
    return { externalId: session.externalId, state: 'acknowledged' };
  } catch (error) {
    // This may be a timeout AFTER OpenCode accepted the work; fail closed.
    // A DB failure to settle also stays 'attempting' and must be reconciled.
    try {
      await store.settleAttempt(executionId, claimed.fence, {
        outcome: 'unknown', errorCode: error instanceof AgentRunnerError ?
          error.code : 'OPENCODE_UNEXPECTED_ERROR'
      });
    } catch {
      throw new AgentRunnerError('EXECUTION_RECONCILIATION_REQUIRED');
    }
    throw error instanceof AgentRunnerError
      ? error : new AgentRunnerError('OPENCODE_OUTCOME_UNKNOWN');
  }
}

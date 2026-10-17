/** D5a: provider adaptation only. No MCP endpoints or automatic dispatch. */
import { createHash } from 'node:crypto';
import {
  AgentRunnerError, denyAgentActions,
  type AgentAuthorizationGateway, type AgentSession, type AgentStatus,
  type AgentArtifacts, type AgentTaskPrompt, type CreateAgentSession,
  type ManagedAgentRunner
} from './agent-runner.ts';
import { OpenCodeClient } from './opencode-client.ts';

function assertIdentifier(value: string): void {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(value)) {
    throw new AgentRunnerError('INVALID_TASK_REFERENCE');
  }
}
function assertDirectory(value: string): void {
  if (typeof value !== 'string' || !value.startsWith('/') ||
      value.includes('\u0000') || value.includes('..') || value.length > 2048) {
    throw new AgentRunnerError('INVALID_WORKSPACE');
  }
}
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface OpenCodeRunnerOptions {
  client: OpenCodeClient;
  /** Exact allowlisted local workspace root for this one runner instance. */
  directory: string;
  repository: string;
  /**
   * Required external policy for EVERY mutation. Omitting it denies writes.
   * In D5b this must be a DB-backed, one-shot approved lease/fencing check.
   * Mock grants are for unit tests only, never production.
   */
  authorize?: AgentAuthorizationGateway;
}

export class OpenCodeManagedRunner implements ManagedAgentRunner {
  private readonly client: OpenCodeClient;
  private readonly directory: string;
  private readonly repository: string;
  private readonly authorize: AgentAuthorizationGateway;

  constructor(options: OpenCodeRunnerOptions) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository)) {
      throw new AgentRunnerError('INVALID_REPOSITORY');
    }
    assertDirectory(options.directory);
    this.client = options.client;
    this.directory = options.directory.replace(/\/$/, '');
    this.repository = options.repository;
    this.authorize = options.authorize ?? denyAgentActions;
  }

  private async assertWorkspace(): Promise<void> {
    if (await this.client.directory() !== this.directory) {
      throw new AgentRunnerError('OPENCODE_WORKSPACE_MISMATCH');
    }
  }
  private session(session: AgentSession): void {
    if (session.provider !== 'opencode' ||
        session.repository !== this.repository ||
        session.directory !== this.directory) {
      throw new AgentRunnerError('AGENT_SESSION_SCOPE_MISMATCH');
    }
    assertIdentifier(session.taskId);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(session.externalId)) {
      throw new AgentRunnerError('INVALID_SESSION_ID');
    }
  }

  async createSession(request: CreateAgentSession): Promise<AgentSession> {
    assertIdentifier(request.taskId);
    assertIdentifier(request.idempotencyKey);
    if (request.repository !== this.repository) {
      throw new AgentRunnerError('AGENT_SESSION_SCOPE_MISMATCH');
    }
    await this.assertWorkspace();
    await this.authorize({
      action: 'create_session', taskId: request.taskId,
      repository: this.repository, directory: this.directory,
      idempotencyKey: request.idempotencyKey
    });
    const externalId = await this.client.createSession(request.title);
    return {
      provider: 'opencode', externalId, taskId: request.taskId,
      repository: this.repository, directory: this.directory
    };
  }

  private async prompt(
    action: 'start_task' | 'resume',
    session: AgentSession, request: AgentTaskPrompt
  ): Promise<void> {
    this.session(session);
    assertIdentifier(request.idempotencyKey);
    if (request.taskId !== session.taskId ||
        typeof request.prompt !== 'string' || !request.prompt.trim() ||
        request.prompt.length > 32_000 || request.prompt.includes('\u0000')) {
      throw new AgentRunnerError('INVALID_TASK_PROMPT');
    }
    await this.assertWorkspace();
    await this.client.getSession(session.externalId);
    // External authorization must bind the full prompt digest, task, session,
    // workspace and nonce. A D2 ready suggestion is not authorization.
    await this.authorize({
      action, taskId: session.taskId, repository: this.repository,
      directory: this.directory, externalId: session.externalId,
      idempotencyKey: request.idempotencyKey,
      promptSha256: sha256(request.prompt),
      ...(request.model ? {
        modelProviderId: request.model.providerID, modelId: request.model.modelID
      } : {})
    });
    const status = await this.client.status(session.externalId);
    if (status !== 'idle') throw new AgentRunnerError('AGENT_SESSION_NOT_IDLE');
    // One outbound side effect only. After a timeout, caller must reconcile.
    await this.client.startPrompt(session.externalId, request.prompt, request.model);
  }

  async startTask(session: AgentSession, request: AgentTaskPrompt): Promise<void> {
    await this.prompt('start_task', session, request);
  }

  async resume(session: AgentSession, request: AgentTaskPrompt): Promise<void> {
    await this.prompt('resume', session, request);
  }

  async getStatus(session: AgentSession): Promise<AgentStatus> {
    this.session(session);
    await this.assertWorkspace();
    return {
      state: await this.client.status(session.externalId),
      externalId: session.externalId, completionVerified: false
    };
  }

  async cancel(session: AgentSession): Promise<void> {
    this.session(session);
    await this.assertWorkspace();
    await this.authorize({
      action: 'cancel', taskId: session.taskId, repository: this.repository,
      directory: this.directory, externalId: session.externalId
    });
    // An acknowledged abort is NOT confirmation that all file effects stopped.
    await this.client.abort(session.externalId);
  }

  async getArtifacts(session: AgentSession): Promise<AgentArtifacts> {
    this.session(session);
    await this.assertWorkspace();
    return {
      provider: 'opencode', externalId: session.externalId,
      diffs: await this.client.diffs(session.externalId),
      githubVerified: false
    };
  }
}

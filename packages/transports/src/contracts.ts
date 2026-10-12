/**
 * P2.1: transport-neutral contract and deterministic policy, separate from LLM.
 * No transport can infer consent, authority, or a destination from an LLM reply.
 */
export type Capability = 'tested' | 'experimental' | 'unavailable';
export interface TransportCapabilities {
  channel: string;
  identityKind: 'owner' | 'agent';
  privateText: Capability;
  initiateUnknownChat: Capability;
  inboundReply: Capability;
  voice: Capability;
  runtime: ('macos' | 'linux')[];
}
export const TRANSPORT_CAPABILITIES: readonly TransportCapabilities[] = [
  { channel: 'telegram_bot_test', identityKind: 'agent', privateText: 'experimental',
    initiateUnknownChat: 'unavailable', inboundReply: 'experimental',
    voice: 'unavailable', runtime: ['macos', 'linux'] }
];

export interface TextSendIntent {
  workflowId: string;
  chatId: string;
  body: string;
}
export interface TextSendReceipt {
  providerMessageId: string;
}
export interface IncomingText {
  updateId: number;
  providerMessageId: string;
  chatId: string;
  senderId: string;
  chatType: string;
  body: string;
  replyToProviderId?: string;
}
export interface TransportUpdate { updateId: number; incoming?: IncomingText }
export interface TextTransportAdapter {
  readonly capabilities: TransportCapabilities;
  send(intent: TextSendIntent): Promise<TextSendReceipt>;
  receive(afterUpdateId: number): Promise<TransportUpdate[]>;
}
export interface TestTextPolicy {
  enabled: boolean;
  allowedChatIds: ReadonlySet<string>;
}
const CHAT_ID = /^[1-9][0-9]{0,15}$/;

/** Private opt-in testing only. A separate feature flag cannot enable demo outbound. */
export function readTestTextPolicy(env: Record<string, string | undefined>): TestTextPolicy {
  if (env.TEST_TELEGRAM_ENABLED !== undefined &&
      !['true', 'false'].includes(env.TEST_TELEGRAM_ENABLED)) {
    throw new Error('TEST_TELEGRAM_ENABLED must be true or false');
  }
  const enabled = env.TEST_TELEGRAM_ENABLED === 'true';
  const ids = (env.AGENT_TELEGRAM_ALLOWED_CHAT_IDS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (ids.some(id => !CHAT_ID.test(id)) || new Set(ids).size !== ids.length || ids.length > 2) {
    throw new Error('Only 1-2 unique private Telegram numeric chat IDs may be allowlisted');
  }
  if (enabled && ids.length === 0) throw new Error('Enable test transport only with explicit allowlisted chat ID');
  return { enabled, allowedChatIds: new Set(ids) };
}
export function authorizeTestText(policy: TestTextPolicy, chatId: unknown): string {
  if (!policy.enabled) throw new TextPolicyError('TEST_CHANNEL_DISABLED');
  if (typeof chatId !== 'string' || !CHAT_ID.test(chatId) || !policy.allowedChatIds.has(chatId)) {
    throw new TextPolicyError('CHAT_NOT_ALLOWLISTED');
  }
  return chatId;
}
export class TextPolicyError extends Error {
  readonly statusCode = 403;
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

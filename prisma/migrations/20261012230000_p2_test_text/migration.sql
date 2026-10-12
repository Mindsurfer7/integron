ALTER TABLE "WorkflowRun"
  ADD COLUMN "transport" TEXT NOT NULL DEFAULT 'mock',
  ADD COLUMN "targetChatId" TEXT;

CREATE TABLE "TextDelivery" (
  "id" UUID NOT NULL,
  "workflowId" UUID NOT NULL,
  "channel" TEXT NOT NULL DEFAULT 'telegram_bot_test',
  "chatId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'queued',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "leasedUntil" TIMESTAMP(3),
  "providerId" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TextDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TextDelivery_workflowId_key" ON "TextDelivery"("workflowId");
CREATE INDEX "TextDelivery_state_createdAt_idx" ON "TextDelivery"("state","createdAt");
CREATE INDEX "TextDelivery_chatId_providerId_idx" ON "TextDelivery"("chatId","providerId");
ALTER TABLE "TextDelivery" ADD CONSTRAINT "TextDelivery_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TextMessage" (
  "id" UUID NOT NULL,
  "workflowId" UUID NOT NULL,
  "channel" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "providerMessageId" TEXT NOT NULL,
  "replyToProviderId" TEXT,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TextMessage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TextMessage_channel_chatId_providerMessageId_direction_key"
 ON "TextMessage"("channel","chatId","providerMessageId","direction");
CREATE INDEX "TextMessage_workflowId_createdAt_idx" ON "TextMessage"("workflowId","createdAt");
ALTER TABLE "TextMessage" ADD CONSTRAINT "TextMessage_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AgentTelegramCursor" (
  "id" INTEGER NOT NULL,
  "lastUpdateId" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "AgentTelegramCursor_pkey" PRIMARY KEY ("id")
);

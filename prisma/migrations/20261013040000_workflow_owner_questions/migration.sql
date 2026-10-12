-- P1 source-conflict human review. Independent of legacy DemoTask questions.
-- No approval/call permissions are created by this migration.
CREATE TABLE "WorkflowOwnerQuestion" (
  "id" UUID NOT NULL,
  "workflowId" UUID NOT NULL,
  "requestKey" TEXT NOT NULL,
  "sourceMessageId" UUID,
  "prompt" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'free_text',
  "ownerUserId" TEXT,
  "ownerChatId" TEXT,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "answer" TEXT,
  "answeredVia" TEXT,
  "answeredAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkflowOwnerQuestion_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WorkflowOwnerNotification" (
  "id" UUID NOT NULL,
  "questionId" UUID NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'queued',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "leasedUntil" TIMESTAMP(3),
  "messageId" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkflowOwnerNotification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkflowOwnerQuestion_workflowId_requestKey_key"
  ON "WorkflowOwnerQuestion"("workflowId", "requestKey");
CREATE INDEX "WorkflowOwnerQuestion_workflowId_state_idx"
  ON "WorkflowOwnerQuestion"("workflowId", "state");
CREATE INDEX "WorkflowOwnerQuestion_state_expiresAt_idx"
  ON "WorkflowOwnerQuestion"("state", "expiresAt");
CREATE UNIQUE INDEX "WorkflowOwnerNotification_questionId_key"
  ON "WorkflowOwnerNotification"("questionId");
CREATE INDEX "WorkflowOwnerNotification_state_createdAt_idx"
  ON "WorkflowOwnerNotification"("state", "createdAt");
CREATE INDEX "WorkflowOwnerNotification_messageId_idx"
  ON "WorkflowOwnerNotification"("messageId");
ALTER TABLE "WorkflowOwnerQuestion" ADD CONSTRAINT "WorkflowOwnerQuestion_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkflowOwnerNotification" ADD CONSTRAINT "WorkflowOwnerNotification_questionId_fkey"
  FOREIGN KEY ("questionId") REFERENCES "WorkflowOwnerQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

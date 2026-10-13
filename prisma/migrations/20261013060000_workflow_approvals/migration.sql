-- P1 simulation-only approvals. No migration touches existing owner clarifications.
CREATE TABLE "WorkflowApproval" (
  "id" UUID NOT NULL,
  "workflowId" UUID NOT NULL,
  "requestKey" TEXT NOT NULL,
  "mode" TEXT NOT NULL DEFAULT 'simulation_only',
  "actionType" TEXT NOT NULL,
  "recipientRef" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "amountMinor" INTEGER,
  "currency" TEXT,
  "intentDigest" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "ownerChatId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "decisionVia" TEXT,
  "decidedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkflowApproval_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WorkflowApprovalNotification" (
  "id" UUID NOT NULL,
  "approvalId" UUID NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'queued',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "leasedUntil" TIMESTAMP(3),
  "messageId" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkflowApprovalNotification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkflowApproval_workflowId_requestKey_key"
  ON "WorkflowApproval"("workflowId", "requestKey");
CREATE INDEX "WorkflowApproval_workflowId_state_idx" ON "WorkflowApproval"("workflowId", "state");
CREATE INDEX "WorkflowApproval_state_expiresAt_idx" ON "WorkflowApproval"("state", "expiresAt");
CREATE UNIQUE INDEX "WorkflowApprovalNotification_approvalId_key" ON "WorkflowApprovalNotification"("approvalId");
CREATE INDEX "WorkflowApprovalNotification_state_createdAt_idx"
  ON "WorkflowApprovalNotification"("state", "createdAt");
CREATE INDEX "WorkflowApprovalNotification_messageId_idx"
  ON "WorkflowApprovalNotification"("messageId");
ALTER TABLE "WorkflowApproval" ADD CONSTRAINT "WorkflowApproval_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkflowApprovalNotification" ADD CONSTRAINT "WorkflowApprovalNotification_approvalId_fkey"
  FOREIGN KEY ("approvalId") REFERENCES "WorkflowApproval"("id") ON DELETE CASCADE ON UPDATE CASCADE;

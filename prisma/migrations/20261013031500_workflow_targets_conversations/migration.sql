-- P1 durable targets/conversations. No automatic discovery and no live outreach.
CREATE TABLE "WorkflowTarget" (
  "id" UUID NOT NULL,
  "workflowId" UUID NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "recipientId" TEXT,
  "origin" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkflowTarget_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WorkflowConversation" (
  "id" UUID NOT NULL,
  "workflowId" UUID NOT NULL,
  "targetId" UUID NOT NULL,
  "channel" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'planned',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkflowConversation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkflowTarget_workflowId_sourceKey_key"
  ON "WorkflowTarget"("workflowId", "sourceKey");
CREATE INDEX "WorkflowTarget_workflowId_createdAt_idx"
  ON "WorkflowTarget"("workflowId", "createdAt");
CREATE UNIQUE INDEX "WorkflowConversation_workflowId_targetId_key"
  ON "WorkflowConversation"("workflowId", "targetId");
CREATE INDEX "WorkflowConversation_workflowId_state_idx"
  ON "WorkflowConversation"("workflowId", "state");
ALTER TABLE "WorkflowTarget" ADD CONSTRAINT "WorkflowTarget_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkflowConversation" ADD CONSTRAINT "WorkflowConversation_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkflowConversation" ADD CONSTRAINT "WorkflowConversation_targetId_fkey"
  FOREIGN KEY ("targetId") REFERENCES "WorkflowTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

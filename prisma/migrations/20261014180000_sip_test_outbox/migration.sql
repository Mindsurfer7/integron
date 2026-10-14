CREATE TABLE "WorkflowSipCall" (
  "id" UUID NOT NULL,
  "workflowId" UUID NOT NULL,
  "actionKey" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "budgetReservationKey" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'prepared',
  "roomName" TEXT,
  "participantIdentity" TEXT,
  "providerCallId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkflowSipCall_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkflowSipCall_workflowId_actionKey_key" ON "WorkflowSipCall"("workflowId","actionKey");
CREATE INDEX "WorkflowSipCall_state_createdAt_idx" ON "WorkflowSipCall"("state","createdAt");
ALTER TABLE "WorkflowSipCall" ADD CONSTRAINT "WorkflowSipCall_workflowId_fkey"
FOREIGN KEY ("workflowId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Separate durable workflow queue; old mock tasks remain unchanged.
CREATE TABLE "WorkflowRun" (
  "id" UUID NOT NULL,
  "goal" TEXT NOT NULL,
  "clarificationId" UUID NOT NULL,
  "demoTaskId" UUID,
  "state" TEXT NOT NULL DEFAULT 'queued',
  "step" TEXT NOT NULL DEFAULT 'plan',
  "plan" JSONB,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leasedUntil" TIMESTAMP(3),
  "failures" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkflowRun_state_availableAt_idx" ON "WorkflowRun"("state", "availableAt");
CREATE INDEX "WorkflowRun_leasedUntil_idx" ON "WorkflowRun"("leasedUntil");

CREATE TABLE "WorkflowEvent" (
  "id" UUID NOT NULL,
  "workflowId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkflowEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkflowEvent_workflowId_createdAt_idx" ON "WorkflowEvent"("workflowId", "createdAt");
ALTER TABLE "WorkflowEvent" ADD CONSTRAINT "WorkflowEvent_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

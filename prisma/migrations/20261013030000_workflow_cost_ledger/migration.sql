-- P1 idempotent cost accounting. Existing workflows start with zero recorded cost.
ALTER TABLE "WorkflowRun"
  ADD COLUMN "maxCostCents" INTEGER NOT NULL DEFAULT 500,
  ADD COLUMN "spentCents" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "WorkflowCostEntry" (
  "id" UUID NOT NULL,
  "workflowId" UUID NOT NULL,
  "eventKey" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkflowCostEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkflowCostEntry_workflowId_eventKey_key"
  ON "WorkflowCostEntry"("workflowId", "eventKey");
CREATE INDEX "WorkflowCostEntry_workflowId_createdAt_idx"
  ON "WorkflowCostEntry"("workflowId", "createdAt");

ALTER TABLE "WorkflowCostEntry"
  ADD CONSTRAINT "WorkflowCostEntry_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "WorkflowRun"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

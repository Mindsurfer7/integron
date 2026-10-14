ALTER TABLE "WorkflowRun" ADD COLUMN "reservedCents" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "WorkflowCostReservation" (
  "id" UUID NOT NULL,
  "workflowId" UUID NOT NULL,
  "eventKey" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "maxAmountCents" INTEGER NOT NULL,
  "actualAmountCents" INTEGER,
  "state" TEXT NOT NULL DEFAULT 'reserved',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "WorkflowCostReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkflowCostReservation_workflowId_eventKey_key"
ON "WorkflowCostReservation"("workflowId","eventKey");
CREATE INDEX "WorkflowCostReservation_workflowId_state_idx"
ON "WorkflowCostReservation"("workflowId","state");
ALTER TABLE "WorkflowCostReservation"
ADD CONSTRAINT "WorkflowCostReservation_workflowId_fkey"
FOREIGN KEY ("workflowId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkflowSipCall"
  ADD COLUMN "deadlineAt" TIMESTAMP(3),
  ADD COLUMN "stopRequestedAt" TIMESTAMP(3),
  ADD COLUMN "stopReason" TEXT,
  ADD COLUMN "terminationState" TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN "terminationAt" TIMESTAMP(3);
CREATE INDEX "WorkflowSipCall_deadlineAt_stopRequestedAt_idx"
  ON "WorkflowSipCall"("deadlineAt", "stopRequestedAt");
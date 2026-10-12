CREATE TABLE "WorkflowFact" (
  "id" UUID NOT NULL,
  "workflowId" UUID NOT NULL,
  "messageId" UUID NOT NULL,
  "field" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "quote" TEXT NOT NULL,
  "startOffset" INTEGER NOT NULL,
  "endOffset" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'tentative',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkflowFact_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkflowFact_messageId_field_startOffset_endOffset_key"
 ON "WorkflowFact"("messageId","field","startOffset","endOffset");
CREATE INDEX "WorkflowFact_workflowId_field_idx" ON "WorkflowFact"("workflowId","field");
ALTER TABLE "WorkflowFact" ADD CONSTRAINT "WorkflowFact_workflowId_fkey"
 FOREIGN KEY ("workflowId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkflowFact" ADD CONSTRAINT "WorkflowFact_messageId_fkey"
 FOREIGN KEY ("messageId") REFERENCES "TextMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

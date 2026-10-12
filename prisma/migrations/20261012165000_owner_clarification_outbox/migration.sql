-- Durable owner clarifications and a notification outbox, initially for simulated tasks.
-- Queue processing must never automatically repeat an uncertain Telegram send.
CREATE TABLE "OwnerClarification" (
  "id" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "answeredAt" TIMESTAMP(3),
  "choice" TEXT,
  CONSTRAINT "OwnerClarification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OwnerClarification_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "DemoTask"("id") ON DELETE CASCADE
);
CREATE INDEX "OwnerClarification_state_expiresAt_idx" ON "OwnerClarification"("state", "expiresAt");
CREATE INDEX "OwnerClarification_taskId_idx" ON "OwnerClarification"("taskId");

CREATE TABLE "OwnerNotification" (
  "id" UUID NOT NULL,
  "clarificationId" UUID NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'queued',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "leasedUntil" TIMESTAMP(3),
  "messageId" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OwnerNotification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OwnerNotification_clarificationId_key" UNIQUE ("clarificationId"),
  CONSTRAINT "OwnerNotification_clarificationId_fkey" FOREIGN KEY ("clarificationId") REFERENCES "OwnerClarification"("id") ON DELETE CASCADE
);
CREATE INDEX "OwnerNotification_state_createdAt_idx" ON "OwnerNotification"("state", "createdAt");
CREATE TABLE "TelegramPollingCursor" (
  "id" INTEGER NOT NULL,
  "lastUpdateId" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "TelegramPollingCursor_pkey" PRIMARY KEY ("id")
);

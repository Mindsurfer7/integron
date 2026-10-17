-- D5b independent additive persistence. This migration deliberately does not
-- modify D3 DevDecision/DevEvent or any MCP endpoint.
CREATE TABLE "DevAgentSession" (
  "id" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "repositoryId" UUID NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'opencode',
  "directory" TEXT NOT NULL,
  "branch" TEXT NOT NULL,
  "externalId" TEXT,
  "state" TEXT NOT NULL DEFAULT 'reserved',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DevAgentSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DevAgentSession_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "DevTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DevAgentSession_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "DevRepository"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DevAgentSession_state_check" CHECK ("state" IN ('reserved','creating','active','unknown','closed')),
  CONSTRAINT "DevAgentSession_provider_check" CHECK ("provider" = 'opencode')
);
CREATE UNIQUE INDEX "DevAgentSession_provider_externalId_key" ON "DevAgentSession"("provider","externalId");
CREATE INDEX "DevAgentSession_taskId_state_idx" ON "DevAgentSession"("taskId","state");
CREATE INDEX "DevAgentSession_repositoryId_state_idx" ON "DevAgentSession"("repositoryId","state");
-- Even if two processes race, only one held/active agent may own a task.
CREATE UNIQUE INDEX "DevAgentSession_taskId_active_key"
  ON "DevAgentSession"("taskId") WHERE "state" IN ('reserved','creating','active','unknown');

CREATE TABLE "DevExecution" (
  "id" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "requestKey" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "intentDigest" TEXT NOT NULL,
  "promptSha256" TEXT,
  "maxCostCents" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "fence" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "approvedAt" TIMESTAMP(3),
  "approvedBy" TEXT,
  "claimedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DevExecution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DevExecution_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "DevTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DevExecution_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DevAgentSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DevExecution_action_check" CHECK ("action" IN ('create_session','start_task','resume','cancel')),
  CONSTRAINT "DevExecution_state_check" CHECK ("state" IN ('pending','approved','attempting','acknowledged','unknown','rejected','expired')),
  CONSTRAINT "DevExecution_digest_check" CHECK ("intentDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "DevExecution_prompt_check" CHECK ("promptSha256" IS NULL OR "promptSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "DevExecution_budget_check" CHECK ("maxCostCents" >= 0 AND "maxCostCents" <= 100000),
  CONSTRAINT "DevExecution_fence_check" CHECK ("fence" >= 0)
);
CREATE UNIQUE INDEX "DevExecution_taskId_requestKey_key" ON "DevExecution"("taskId","requestKey");
CREATE INDEX "DevExecution_state_expiresAt_idx" ON "DevExecution"("state","expiresAt");
CREATE INDEX "DevExecution_sessionId_state_idx" ON "DevExecution"("sessionId","state");
-- Unknown is held, not retried. No overlapping pending or attempted actions.
CREATE UNIQUE INDEX "DevExecution_session_inflight_key"
  ON "DevExecution"("sessionId") WHERE "state" IN ('pending','approved','attempting','unknown');

CREATE TABLE "DevArtifact" (
  "id" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "executionId" UUID NOT NULL,
  "source" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "repository" TEXT NOT NULL,
  "sha" TEXT,
  "reference" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,
  CONSTRAINT "DevArtifact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DevArtifact_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DevAgentSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DevArtifact_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "DevExecution"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DevArtifact_source_check" CHECK ("source" IN ('opencode','github_observer')),
  CONSTRAINT "DevArtifact_kind_check" CHECK ("kind" IN ('diff','commit','pull_request','check')),
  CONSTRAINT "DevArtifact_verified_check" CHECK ("verifiedAt" IS NULL OR ("source" = 'github_observer' AND "sha" ~ '^[0-9a-f]{40}$'))
);
CREATE INDEX "DevArtifact_sessionId_observedAt_idx" ON "DevArtifact"("sessionId","observedAt");
CREATE INDEX "DevArtifact_repository_sha_idx" ON "DevArtifact"("repository","sha");

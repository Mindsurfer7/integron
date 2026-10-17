-- D2 additive phase DAG, tasks and manual blockers.
-- No automatic stage acceptance or GitHub write permissions.
CREATE TABLE "DevPhase" (
  "id" UUID NOT NULL,
  "projectSlug" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "workstream" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "state" TEXT NOT NULL DEFAULT 'planned',
  "acceptanceCriteria" JSONB NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "acceptanceEvidence" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DevPhase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DevPhase_projectSlug_fkey"
    FOREIGN KEY ("projectSlug") REFERENCES "DevProject"("slug") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DevPhase_state_check"
    CHECK ("state" IN ('planned','active','accepted','cancelled')),
  CONSTRAINT "DevPhase_accepted_evidence_check"
    CHECK ("state" <> 'accepted' OR ("acceptedAt" IS NOT NULL AND "acceptanceEvidence" IS NOT NULL))
);
CREATE UNIQUE INDEX "DevPhase_projectSlug_code_key" ON "DevPhase"("projectSlug", "code");
CREATE INDEX "DevPhase_projectSlug_workstream_idx" ON "DevPhase"("projectSlug", "workstream");

CREATE TABLE "DevDependency" (
  "phaseId" UUID NOT NULL,
  "requiresPhaseId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DevDependency_pkey" PRIMARY KEY ("phaseId","requiresPhaseId"),
  CONSTRAINT "DevDependency_not_self_check" CHECK ("phaseId" <> "requiresPhaseId"),
  CONSTRAINT "DevDependency_phaseId_fkey"
    FOREIGN KEY ("phaseId") REFERENCES "DevPhase"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DevDependency_requiresPhaseId_fkey"
    FOREIGN KEY ("requiresPhaseId") REFERENCES "DevPhase"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "DevDependency_requiresPhaseId_idx" ON "DevDependency"("requiresPhaseId");

CREATE TABLE "DevTask" (
  "id" UUID NOT NULL,
  "phaseId" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "priority" INTEGER NOT NULL DEFAULT 100,
  "state" TEXT NOT NULL DEFAULT 'planned',
  "scopes" JSONB NOT NULL,
  "coordinationKeys" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DevTask_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DevTask_phaseId_fkey"
    FOREIGN KEY ("phaseId") REFERENCES "DevPhase"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DevTask_state_check"
    CHECK ("state" IN ('planned','running','paused','pr_open','ci_pending','review','verified','completed','failed','cancelled'))
);
CREATE UNIQUE INDEX "DevTask_phaseId_key_key" ON "DevTask"("phaseId", "key");
CREATE INDEX "DevTask_state_priority_idx" ON "DevTask"("state", "priority");

CREATE TABLE "DevBlocker" (
  "id" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "detail" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'open',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "DevBlocker_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DevBlocker_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "DevTask"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DevBlocker_state_check" CHECK ("state" IN ('open','resolved'))
);
CREATE INDEX "DevBlocker_taskId_state_idx" ON "DevBlocker"("taskId","state");

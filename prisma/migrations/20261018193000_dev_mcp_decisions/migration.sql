-- D3 controlled local MCP write intents and append-only audit.
-- Approval is a local operator decision; an approved intent is not a GitHub action.
CREATE TABLE "DevDecision" (
  "id" UUID NOT NULL,
  "projectSlug" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "actionType" TEXT NOT NULL,
  "intent" JSONB NOT NULL,
  "intentDigest" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "result" JSONB,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "approvedAt" TIMESTAMP(3),
  "approvedBy" TEXT,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DevDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DevDecision_projectSlug_fkey" FOREIGN KEY ("projectSlug") REFERENCES "DevProject"("slug") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DevDecision_state_check" CHECK ("state" IN ('pending','approved','rejected','consumed','expired')),
  CONSTRAINT "DevDecision_action_check" CHECK ("actionType" IN ('add_blocker','resolve_blocker'))
);
CREATE UNIQUE INDEX "DevDecision_actorId_requestKey_key" ON "DevDecision"("actorId", "requestKey");
CREATE INDEX "DevDecision_projectSlug_state_idx" ON "DevDecision"("projectSlug", "state");
CREATE INDEX "DevDecision_state_expiresAt_idx" ON "DevDecision"("state", "expiresAt");
CREATE TABLE "DevEvent" (
  "id" UUID NOT NULL,
  "projectSlug" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "decisionId" UUID,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DevEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DevEvent_projectSlug_fkey" FOREIGN KEY ("projectSlug") REFERENCES "DevProject"("slug") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DevEvent_eventKey_key" ON "DevEvent"("eventKey");
CREATE INDEX "DevEvent_projectSlug_createdAt_idx" ON "DevEvent"("projectSlug", "createdAt");
CREATE INDEX "DevEvent_decisionId_idx" ON "DevEvent"("decisionId");

-- Prevent edits and deletion of previously committed audit entries even via
-- application ORM; DBA/superuser controls and backups are still required.
CREATE FUNCTION "dev_event_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'DevEvent is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "dev_event_immutable_update"
  BEFORE UPDATE OR DELETE ON "DevEvent" FOR EACH ROW
  EXECUTE FUNCTION "dev_event_immutable"();

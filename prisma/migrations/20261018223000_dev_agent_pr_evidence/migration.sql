-- D5c: one persisted observation per execution, kind and immutable SHA.
-- This deduplicates re-observing a PR and keeps newer SHA evidence separate.
-- Verified timestamps describe source authenticity, NEVER phase acceptance.
CREATE UNIQUE INDEX "DevArtifact_executionId_source_kind_sha_key"
  ON "DevArtifact" ("executionId", "source", "kind", "sha");

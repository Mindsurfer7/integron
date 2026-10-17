-- Read-only Development Orchestrator D1 registry and GitHub evidence.
CREATE TABLE "DevProject" (
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  CONSTRAINT "DevProject_pkey" PRIMARY KEY ("slug")
);
CREATE TABLE "DevRepository" (
  "id" UUID NOT NULL,
  "projectSlug" TEXT NOT NULL,
  "fullName" TEXT NOT NULL,
  "integrationBranch" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DevRepository_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "DevGithubSnapshot" (
  "repositoryId" UUID NOT NULL,
  "payload" JSONB NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "stale" BOOLEAN NOT NULL DEFAULT false,
  "errorCode" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DevGithubSnapshot_pkey" PRIMARY KEY ("repositoryId")
);
CREATE TABLE "DevGithubDelivery" (
  "id" UUID NOT NULL,
  "repositoryId" UUID NOT NULL,
  "deliveryId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payloadSha256" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DevGithubDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DevRepository_fullName_key" ON "DevRepository"("fullName");
CREATE INDEX "DevRepository_projectSlug_idx" ON "DevRepository"("projectSlug");
CREATE INDEX "DevGithubSnapshot_stale_observedAt_idx" ON "DevGithubSnapshot"("stale", "observedAt");
CREATE UNIQUE INDEX "DevGithubDelivery_deliveryId_key" ON "DevGithubDelivery"("deliveryId");
CREATE INDEX "DevGithubDelivery_repositoryId_receivedAt_idx" ON "DevGithubDelivery"("repositoryId", "receivedAt");
ALTER TABLE "DevRepository" ADD CONSTRAINT "DevRepository_projectSlug_fkey"
  FOREIGN KEY ("projectSlug") REFERENCES "DevProject"("slug") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DevGithubSnapshot" ADD CONSTRAINT "DevGithubSnapshot_repositoryId_fkey"
  FOREIGN KEY ("repositoryId") REFERENCES "DevRepository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DevGithubDelivery" ADD CONSTRAINT "DevGithubDelivery_repositoryId_fkey"
  FOREIGN KEY ("repositoryId") REFERENCES "DevRepository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

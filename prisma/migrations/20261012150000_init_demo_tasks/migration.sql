-- P0-only persistent mock tasks. Real platform communications remain disabled.
CREATE TABLE "DemoTask" (
  "id" UUID NOT NULL,
  "payload" JSONB NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DemoTask_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DemoTask_createdAt_idx" ON "DemoTask"("createdAt");

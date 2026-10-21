-- T35 (ADR-106, ADR-107): Meta Lead Ads backfill runs, and the CampaignAction outcome columns
-- (configured status before the change, failure reason, the effective status read back after it).
-- AlterTable
ALTER TABLE "CampaignAction" ADD COLUMN "previousStatus" TEXT;
ALTER TABLE "CampaignAction" ADD COLUMN "readBackAt" DATETIME;
ALTER TABLE "CampaignAction" ADD COLUMN "readBackStatus" TEXT;
ALTER TABLE "CampaignAction" ADD COLUMN "reasonCode" TEXT;

-- CreateTable
CREATE TABLE "MetaLeadBackfill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "since" DATETIME NOT NULL,
    "requestKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "requestedBy" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "jobId" TEXT,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "counts" JSONB,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "errorCode" TEXT,
    "errorRedacted" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "MetaLeadBackfill_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MetaLeadBackfill_workspaceId_integrationId_fkey" FOREIGN KEY ("workspaceId", "integrationId") REFERENCES "Integration" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateIndex
CREATE INDEX "MetaLeadBackfill_workspaceId_createdAt_idx" ON "MetaLeadBackfill"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MetaLeadBackfill_workspaceId_id_key" ON "MetaLeadBackfill"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MetaLeadBackfill_workspaceId_requestKey_key" ON "MetaLeadBackfill"("workspaceId", "requestKey");

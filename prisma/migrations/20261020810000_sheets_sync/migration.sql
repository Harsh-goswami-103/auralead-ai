-- T34 (ADR-103, ADR-104): Google Sheets mapping drift and "Sync now" runs.
-- SheetMapping keeps the header names its fingerprint was taken from (column diff on drift) and the
-- submission-time column; SheetSyncRun records each manual sync (cursor, counts, drift, errors).
-- AlterTable
ALTER TABLE "SheetMapping" ADD COLUMN "headerColumns" JSONB;
ALTER TABLE "SheetMapping" ADD COLUMN "submittedAtColumn" TEXT;

-- CreateTable
CREATE TABLE "SheetSyncRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "mappingVersion" INTEGER,
    "requestedBy" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "jobId" TEXT,
    "fromRow" INTEGER,
    "cursorRow" INTEGER,
    "rowsRead" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "duplicate" INTEGER NOT NULL DEFAULT 0,
    "review" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "weakIdRows" INTEGER NOT NULL DEFAULT 0,
    "importBatchId" TEXT,
    "detail" JSONB,
    "errorCode" TEXT,
    "errorRedacted" TEXT,
    "createdAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "SheetSyncRun_workspaceId_integrationId_fkey" FOREIGN KEY ("workspaceId", "integrationId") REFERENCES "Integration" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateIndex
CREATE INDEX "SheetSyncRun_workspaceId_integrationId_createdAt_idx" ON "SheetSyncRun"("workspaceId", "integrationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SheetSyncRun_workspaceId_id_key" ON "SheetSyncRun"("workspaceId", "id");

-- PARTIAL UNIQUE (declared in schema.prisma via the partialIndexes preview feature, ADR-47)
-- At most one open (QUEUED or RUNNING) sync run per integration.
-- CreateIndex
CREATE UNIQUE INDEX "SheetSyncRun_one_open_per_integration" ON "SheetSyncRun"("integrationId") WHERE "status" IN ('QUEUED', 'RUNNING');

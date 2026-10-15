-- T23 (ADR-61): persisted bulk runs (one row per bulk action, per-row results).
-- CreateTable
CREATE TABLE "BulkRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "requestKey" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "leadIds" JSONB NOT NULL,
    "selectedCount" INTEGER NOT NULL,
    "queuedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "results" JSONB NOT NULL,
    "preflight" JSONB NOT NULL,
    "jobId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "BulkRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BulkRun_workspaceId_createdAt_idx" ON "BulkRun"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BulkRun_workspaceId_id_key" ON "BulkRun"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BulkRun_workspaceId_requestKey_key" ON "BulkRun"("workspaceId", "requestKey");


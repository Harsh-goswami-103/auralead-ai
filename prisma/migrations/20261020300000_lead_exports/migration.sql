-- T26 (ADR-70): CSV exports of a workspace's leads (one row per export request; the file lives
-- under STORAGE_DIR/exports and is deleted by `leads.exportPurge` when the export expires).
-- CreateTable
CREATE TABLE "LeadExport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "filters" JSONB NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "jobId" TEXT,
    "rowCount" INTEGER,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "path" TEXT,
    "sha256" TEXT,
    "bytes" INTEGER,
    "errorCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "expiresAt" DATETIME,
    "purgedAt" DATETIME,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "lastDownloadedAt" DATETIME,
    CONSTRAINT "LeadExport_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "LeadExport_workspaceId_requestedBy_createdAt_idx" ON "LeadExport"("workspaceId", "requestedBy", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeadExport_workspaceId_id_key" ON "LeadExport"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LeadExport_workspaceId_requestKey_key" ON "LeadExport"("workspaceId", "requestKey");

-- Lead-gen suite foundation (ADR-117 .. ADR-126): Lead Finder runs and results, file imports,
-- lead handoffs and media assets (new tenant tables); Lead handoff, pincode and Places columns;
-- Conversation.escalatedAt; WorkspaceSettings opt-in notice and privacy contact; LeadExport.format;
-- WhatsAppTemplate authoring columns with a nullable syncedAt. Enum additions (LeadSource
-- GOOGLE_PLACES and FILE_IMPORT, WebsiteStatus NOT_LISTED, IntegrationKind GOOGLE_PLACES,
-- ConsentSource FILE_IMPORT) need no SQL: enums are TEXT columns without CHECK constraints.
-- No partial unique index is added.
-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "escalatedAt" DATETIME;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN "contactConfirmedAt" DATETIME;
ALTER TABLE "Lead" ADD COLUMN "contactConfirmedVia" TEXT;
ALTER TABLE "Lead" ADD COLUMN "handedOverAt" DATETIME;
ALTER TABLE "Lead" ADD COLUMN "pincode" TEXT;
ALTER TABLE "Lead" ADD COLUMN "placeId" TEXT;
ALTER TABLE "Lead" ADD COLUMN "placesContentExpiresAt" DATETIME;

-- AlterTable
ALTER TABLE "WorkspaceSettings" ADD COLUMN "privacyContact" TEXT;
ALTER TABLE "WorkspaceSettings" ADD COLUMN "whatsappOptInNotice" TEXT;

-- CreateTable
CREATE TABLE "LeadFinderRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "keywords" JSONB NOT NULL,
    "locations" JSONB NOT NULL,
    "maxPerQuery" INTEGER NOT NULL,
    "extractEmails" BOOLEAN NOT NULL DEFAULT false,
    "emailBlacklist" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "cellsTotal" INTEGER NOT NULL DEFAULT 0,
    "cellsDone" INTEGER NOT NULL DEFAULT 0,
    "resultsFound" INTEGER NOT NULL DEFAULT 0,
    "emailsFound" INTEGER NOT NULL DEFAULT 0,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "errorCode" TEXT,
    "createdAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "cancelledAt" DATETIME,
    CONSTRAINT "LeadFinderRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LeadFinderResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "name" TEXT,
    "category" TEXT,
    "phoneRaw" TEXT,
    "hasPhone" BOOLEAN NOT NULL,
    "website" TEXT,
    "websiteListed" BOOLEAN NOT NULL,
    "ratingX10" INTEGER,
    "reviewCount" INTEGER,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "attributions" JSONB,
    "emails" JSONB NOT NULL,
    "emailCount" INTEGER NOT NULL DEFAULT 0,
    "emailStatus" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "contentExpiresAt" DATETIME,
    "importedLeadId" TEXT,
    "importedAt" DATETIME,
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "LeadFinderResult_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LeadFinderResult_workspaceId_runId_fkey" FOREIGN KEY ("workspaceId", "runId") REFERENCES "LeadFinderRun" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "LeadImport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sheetName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "header" JSONB NOT NULL,
    "mapping" JSONB,
    "dataSource" TEXT,
    "consentAttested" BOOLEAN NOT NULL DEFAULT false,
    "consentAttestedBy" TEXT,
    "consentNoticeText" TEXT,
    "consentNoticeHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PREVIEW',
    "accepted" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "review" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "consentRecorded" INTEGER NOT NULL DEFAULT 0,
    "rejections" JSONB NOT NULL,
    "storagePath" TEXT,
    "createdAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    CONSTRAINT "LeadImport_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LeadHandoff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "note" TEXT,
    "summary" TEXT,
    "summaryGeneratorLabel" TEXT,
    "summaryStatus" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'HANDED_OVER',
    "acknowledgedBy" TEXT,
    "acknowledgedAt" DATETIME,
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "LeadHandoff_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LeadHandoff_workspaceId_leadId_fkey" FOREIGN KEY ("workspaceId", "leadId") REFERENCES "Lead" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "providerHandle" TEXT,
    "providerHandleAt" DATETIME,
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "MediaAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
-- LeadExport gains a NOT NULL column (format, default csv) and WhatsAppTemplate a composite foreign
-- key and a nullable syncedAt, so SQLite rebuilds both tables. Every row is copied; new columns take
-- their defaults (format csv, origin SYNCED). Message rows keep referencing WhatsAppTemplate by
-- (workspaceId, id), which the copy preserves; tests/integration/db/lead-gen-migration.test.ts
-- applies this migration to a populated database and checks the counts and Message.templateId.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LeadExport" (
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
    "format" TEXT NOT NULL DEFAULT 'csv',
    CONSTRAINT "LeadExport_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_LeadExport" ("bytes", "completedAt", "correlationId", "createdAt", "downloadCount", "errorCode", "expiresAt", "filters", "id", "jobId", "lastDownloadedAt", "path", "purgedAt", "requestKey", "requestedBy", "rowCount", "sha256", "status", "truncated", "workspaceId") SELECT "bytes", "completedAt", "correlationId", "createdAt", "downloadCount", "errorCode", "expiresAt", "filters", "id", "jobId", "lastDownloadedAt", "path", "purgedAt", "requestKey", "requestedBy", "rowCount", "sha256", "status", "truncated", "workspaceId" FROM "LeadExport";
DROP TABLE "LeadExport";
ALTER TABLE "new_LeadExport" RENAME TO "LeadExport";
CREATE INDEX "LeadExport_workspaceId_requestedBy_createdAt_idx" ON "LeadExport"("workspaceId", "requestedBy", "createdAt");
CREATE UNIQUE INDEX "LeadExport_workspaceId_id_key" ON "LeadExport"("workspaceId", "id");
CREATE UNIQUE INDEX "LeadExport_workspaceId_requestKey_key" ON "LeadExport"("workspaceId", "requestKey");
CREATE TABLE "new_WhatsAppTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "components" JSONB NOT NULL,
    "variableSchema" JSONB NOT NULL,
    "intent" TEXT,
    "variableMap" JSONB NOT NULL,
    "categoryHistory" JSONB NOT NULL,
    "syncedAt" DATETIME,
    "origin" TEXT NOT NULL DEFAULT 'SYNCED',
    "providerTemplateId" TEXT,
    "rejectedReason" TEXT,
    "submittedBy" TEXT,
    "submittedAt" DATETIME,
    "headerMediaId" TEXT,
    "copyGeneratorLabel" TEXT,
    "utilityTrigger" TEXT,
    CONSTRAINT "WhatsAppTemplate_workspaceId_integrationId_fkey" FOREIGN KEY ("workspaceId", "integrationId") REFERENCES "Integration" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "WhatsAppTemplate_workspaceId_headerMediaId_fkey" FOREIGN KEY ("workspaceId", "headerMediaId") REFERENCES "MediaAsset" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
INSERT INTO "new_WhatsAppTemplate" ("category", "categoryHistory", "components", "id", "integrationId", "intent", "language", "name", "status", "syncedAt", "variableMap", "variableSchema", "workspaceId") SELECT "category", "categoryHistory", "components", "id", "integrationId", "intent", "language", "name", "status", "syncedAt", "variableMap", "variableSchema", "workspaceId" FROM "WhatsAppTemplate";
DROP TABLE "WhatsAppTemplate";
ALTER TABLE "new_WhatsAppTemplate" RENAME TO "WhatsAppTemplate";
CREATE UNIQUE INDEX "WhatsAppTemplate_workspaceId_id_key" ON "WhatsAppTemplate"("workspaceId", "id");
CREATE UNIQUE INDEX "WhatsAppTemplate_integrationId_name_language_key" ON "WhatsAppTemplate"("integrationId", "name", "language");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "LeadFinderRun_workspaceId_createdAt_idx" ON "LeadFinderRun"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeadFinderRun_workspaceId_id_key" ON "LeadFinderRun"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LeadFinderRun_workspaceId_requestKey_key" ON "LeadFinderRun"("workspaceId", "requestKey");

-- CreateIndex
CREATE INDEX "LeadFinderResult_workspaceId_runId_idx" ON "LeadFinderResult"("workspaceId", "runId");

-- CreateIndex
CREATE INDEX "LeadFinderResult_workspaceId_importedLeadId_idx" ON "LeadFinderResult"("workspaceId", "importedLeadId");

-- CreateIndex
CREATE INDEX "LeadFinderResult_workspaceId_contentExpiresAt_idx" ON "LeadFinderResult"("workspaceId", "contentExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeadFinderResult_workspaceId_id_key" ON "LeadFinderResult"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LeadFinderResult_workspaceId_runId_placeId_key" ON "LeadFinderResult"("workspaceId", "runId", "placeId");

-- CreateIndex
CREATE INDEX "LeadImport_workspaceId_createdAt_idx" ON "LeadImport"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeadImport_workspaceId_id_key" ON "LeadImport"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LeadImport_workspaceId_requestKey_key" ON "LeadImport"("workspaceId", "requestKey");

-- CreateIndex
CREATE INDEX "LeadHandoff_workspaceId_status_createdAt_idx" ON "LeadHandoff"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeadHandoff_workspaceId_id_key" ON "LeadHandoff"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LeadHandoff_workspaceId_leadId_key" ON "LeadHandoff"("workspaceId", "leadId");

-- CreateIndex
CREATE INDEX "MediaAsset_workspaceId_createdAt_idx" ON "MediaAsset"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_workspaceId_id_key" ON "MediaAsset"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_handedOverAt_idx" ON "Lead"("workspaceId", "handedOverAt");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_placeId_idx" ON "Lead"("workspaceId", "placeId");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_placesContentExpiresAt_idx" ON "Lead"("workspaceId", "placesContentExpiresAt");

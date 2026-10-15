-- T14 (ADR-55): AI draft bundles, one per pipeline execution.
-- CreateTable
CREATE TABLE "AiDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "executionId" TEXT,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "generatorLabel" TEXT NOT NULL,
    "modelId" TEXT,
    "inputHash" TEXT NOT NULL,
    "templateVariables" JSONB NOT NULL,
    "followUpText" TEXT,
    "emailSubject" TEXT,
    "emailBody" TEXT,
    "proposal" JSONB,
    "pricingPreview" JSONB,
    "aiPolicyFlags" JSONB NOT NULL,
    "reviewReasons" JSONB NOT NULL,
    "policyViolations" JSONB NOT NULL,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "errorCode" TEXT,
    "errorRedacted" TEXT,
    "requestedBy" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiDraft_workspaceId_leadId_fkey" FOREIGN KEY ("workspaceId", "leadId") REFERENCES "Lead" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AiDraft_workspaceId_executionId_fkey" FOREIGN KEY ("workspaceId", "executionId") REFERENCES "PipelineExecution" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateIndex
CREATE UNIQUE INDEX "AiDraft_executionId_key" ON "AiDraft"("executionId");

-- CreateIndex
CREATE INDEX "AiDraft_workspaceId_leadId_createdAt_idx" ON "AiDraft"("workspaceId", "leadId", "createdAt");

-- CreateIndex
CREATE INDEX "AiDraft_workspaceId_status_createdAt_idx" ON "AiDraft"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiDraft_workspaceId_id_key" ON "AiDraft"("workspaceId", "id");


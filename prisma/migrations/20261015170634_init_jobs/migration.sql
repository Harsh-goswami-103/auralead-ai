-- CreateTable
CREATE TABLE "SystemSetting" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "outboundPaused" BOOLEAN NOT NULL DEFAULT false,
    "outboundPausedAt" DATETIME,
    "outboundPausedBy" TEXT,
    "outboundPauseReason" TEXT
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "runAt" DATETIME NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "claimToken" TEXT,
    "leaseUntil" DATETIME,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "serialKey" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "cancelRequestedAt" DATETIME,
    "deadReason" TEXT,
    "lastErrorCode" TEXT,
    "lastErrorRedacted" TEXT,
    "retrySafe" BOOLEAN NOT NULL DEFAULT false,
    "correlationId" TEXT NOT NULL,
    "causationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "JobAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT,
    "jobId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "outcome" TEXT,
    "errorCode" TEXT,
    "errorRedacted" TEXT,
    "providerHttpStatus" INTEGER,
    "providerRequestId" TEXT,
    "durationMs" INTEGER,
    "correlationId" TEXT NOT NULL,
    CONSTRAINT "JobAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "workerId" TEXT NOT NULL PRIMARY KEY,
    "pid" INTEGER NOT NULL,
    "hostname" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "lastBeatAt" DATETIME NOT NULL,
    "currentJobId" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "Job_idempotencyKey_key" ON "Job"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Job_status_runAt_priority_idx" ON "Job"("status", "runAt", "priority");

-- CreateIndex
CREATE INDEX "Job_workspaceId_status_idx" ON "Job"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Job_serialKey_status_idx" ON "Job"("serialKey", "status");

-- CreateIndex
CREATE INDEX "JobAttempt_workspaceId_startedAt_idx" ON "JobAttempt"("workspaceId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobAttempt_jobId_attemptNo_key" ON "JobAttempt"("jobId", "attemptNo");

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "planLabel" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "automationPaused" BOOLEAN NOT NULL DEFAULT false,
    "automationPauseReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WorkspaceSettings" (
    "workspaceId" TEXT NOT NULL PRIMARY KEY,
    "autoSendEnabled" BOOLEAN NOT NULL DEFAULT false,
    "emailB2bAttestationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "emailFallbackEnabled" BOOLEAN NOT NULL DEFAULT false,
    "taxLabel" TEXT,
    "taxBps" INTEGER,
    "taxMode" TEXT NOT NULL DEFAULT 'NONE',
    "maxDiscountBps" INTEGER NOT NULL,
    "quoteValidityDays" INTEGER NOT NULL DEFAULT 15,
    "gstin" TEXT,
    "brandColor" TEXT NOT NULL,
    "logoPath" TEXT,
    "termsText" TEXT NOT NULL,
    "bookingUrl" TEXT,
    "internalWaDailyCap" INTEGER,
    "internalEmailDailyCap" INTEGER,
    "currencyDisplay" TEXT NOT NULL DEFAULT 'INR',
    "updatedAt" DATETIME NOT NULL,
    "updatedBy" TEXT,
    CONSTRAINT "WorkspaceSettings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "globalRole" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "passwordHash" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" DATETIME
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "activeWorkspaceId" TEXT,
    "mode" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL,
    "idleExpiresAt" DATETIME NOT NULL,
    "absoluteExpiresAt" DATETIME NOT NULL,
    "ipHash" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL,
    "revokedAt" DATETIME,
    "reauthAt" DATETIME,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "globalRole" TEXT NOT NULL,
    "workspaceId" TEXT,
    "membershipRole" TEXT,
    "createdBy" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "redeemedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Membership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EmployeeAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeUserId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL,
    "maxDiscountBps" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmployeeAssignment_employeeUserId_fkey" FOREIGN KEY ("employeeUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EmployeeAssignment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TestClock" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "offsetMs" BIGINT NOT NULL DEFAULT 0,
    "frozenAt" DATETIME
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "nameNormalized" TEXT NOT NULL,
    "category" TEXT,
    "phoneE164" TEXT,
    "phoneRaw" TEXT,
    "alternatePhones" JSONB NOT NULL,
    "emailNormalized" TEXT,
    "website" TEXT,
    "websiteStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "address" TEXT,
    "city" TEXT,
    "rating" INTEGER,
    "reviewCount" INTEGER,
    "salesStage" TEXT NOT NULL DEFAULT 'NEW',
    "stageVersion" INTEGER NOT NULL DEFAULT 0,
    "score" INTEGER,
    "scoreReasons" JSONB NOT NULL,
    "unknownInputs" JSONB NOT NULL,
    "scoreConfigVersionId" TEXT,
    "pipelineConfigVersionId" TEXT,
    "firstSource" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "mergedIntoLeadId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Lead_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Lead_workspaceId_scoreConfigVersionId_fkey" FOREIGN KEY ("workspaceId", "scoreConfigVersionId") REFERENCES "ScoringConfigVersion" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "Lead_workspaceId_pipelineConfigVersionId_fkey" FOREIGN KEY ("workspaceId", "pipelineConfigVersionId") REFERENCES "PipelineConfigVersion" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "Lead_workspaceId_mergedIntoLeadId_fkey" FOREIGN KEY ("workspaceId", "mergedIntoLeadId") REFERENCES "Lead" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "LeadContactKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    CONSTRAINT "LeadContactKey_workspaceId_leadId_fkey" FOREIGN KEY ("workspaceId", "leadId") REFERENCES "Lead" ("workspaceId", "id") ON DELETE CASCADE ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "LeadSourceRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "leadId" TEXT,
    "importBatchId" TEXT,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reasonCode" TEXT,
    "rawPayloadRedacted" JSONB NOT NULL,
    "mappingVersion" INTEGER,
    "attribution" JSONB NOT NULL,
    "extractedAt" DATETIME,
    "receivedAt" DATETIME NOT NULL,
    CONSTRAINT "LeadSourceRecord_workspaceId_leadId_fkey" FOREIGN KEY ("workspaceId", "leadId") REFERENCES "Lead" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "LeadSourceRecord_workspaceId_importBatchId_fkey" FOREIGN KEY ("workspaceId", "importBatchId") REFERENCES "ImportBatch" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalBatchId" TEXT NOT NULL,
    "extensionTokenId" TEXT,
    "bodyHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "counts" JSONB NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "ImportBatch_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ImportBatch_workspaceId_extensionTokenId_fkey" FOREIGN KEY ("workspaceId", "extensionTokenId") REFERENCES "ExtensionToken" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "MergeReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "candidateLeadIds" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedBy" TEXT,
    "resolvedAt" DATETIME,
    "resolution" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MergeReview_workspaceId_sourceRecordId_fkey" FOREIGN KEY ("workspaceId", "sourceRecordId") REFERENCES "LeadSourceRecord" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "contactKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "noticeTextHash" TEXT,
    "noticeVersion" TEXT,
    "collectedAt" DATETIME NOT NULL,
    "recordedAt" DATETIME NOT NULL,
    "recordedBy" TEXT,
    "withdrawnAt" DATETIME,
    "withdrawalMethod" TEXT,
    CONSTRAINT "ConsentRecord_workspaceId_leadId_fkey" FOREIGN KEY ("workspaceId", "leadId") REFERENCES "Lead" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "contactKey" TEXT NOT NULL,
    "contactPlain" TEXT,
    "reason" TEXT NOT NULL,
    "sourceEventId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" DATETIME,
    "clearedByConsentId" TEXT,
    "journaledAt" DATETIME,
    "clearJournaledAt" DATETIME,
    CONSTRAINT "Suppression_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScoringConfigVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "weights" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScoringConfigVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SheetMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "headerFingerprint" TEXT NOT NULL,
    "fieldMap" JSONB NOT NULL,
    "consentMapping" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "SheetMapping_workspaceId_integrationId_fkey" FOREIGN KEY ("workspaceId", "integrationId") REFERENCES "Integration" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "MetaFormMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "fieldMap" JSONB NOT NULL,
    "consentMapping" JSONB,
    CONSTRAINT "MetaFormMapping_workspaceId_integrationId_fkey" FOREIGN KEY ("workspaceId", "integrationId") REFERENCES "Integration" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "unitLabel" TEXT NOT NULL,
    "defaultTimelineDays" INTEGER,
    "maxDiscountBps" INTEGER,
    "archivedAt" DATETIME,
    CONSTRAINT "Service_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PricingVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PricingVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PriceEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "pricingVersionId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "unitPricePaise" BIGINT NOT NULL,
    "minQty" INTEGER NOT NULL DEFAULT 1,
    "maxQty" INTEGER NOT NULL DEFAULT 10000,
    CONSTRAINT "PriceEntry_workspaceId_pricingVersionId_fkey" FOREIGN KEY ("workspaceId", "pricingVersionId") REFERENCES "PricingVersion" ("workspaceId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT "PriceEntry_workspaceId_serviceId_fkey" FOREIGN KEY ("workspaceId", "serviceId") REFERENCES "Service" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currentVersionId" TEXT,
    "currentVersionNo" INTEGER NOT NULL DEFAULT 0,
    "needsPricingReview" BOOLEAN NOT NULL DEFAULT false,
    "sentVia" TEXT,
    "validUntil" DATETIME,
    "acceptedVersionId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Quote_workspaceId_leadId_fkey" FOREIGN KEY ("workspaceId", "leadId") REFERENCES "Lead" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "Quote_workspaceId_currentVersionId_fkey" FOREIGN KEY ("workspaceId", "currentVersionId") REFERENCES "QuoteVersion" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "Quote_workspaceId_acceptedVersionId_fkey" FOREIGN KEY ("workspaceId", "acceptedVersionId") REFERENCES "QuoteVersion" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "QuoteVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "pricingVersionId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "scopeText" TEXT NOT NULL,
    "timelineText" TEXT NOT NULL,
    "discountKind" TEXT NOT NULL DEFAULT 'NONE',
    "discountValue" BIGINT NOT NULL DEFAULT 0,
    "taxLabel" TEXT,
    "taxBps" INTEGER,
    "subtotalPaise" BIGINT NOT NULL,
    "discountPaise" BIGINT NOT NULL,
    "taxablePaise" BIGINT NOT NULL,
    "taxPaise" BIGINT NOT NULL,
    "totalPaise" BIGINT NOT NULL,
    "validUntil" DATETIME NOT NULL,
    "sentAt" DATETIME,
    "aiPolicyFlags" JSONB NOT NULL,
    "reviewReasons" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QuoteVersion_workspaceId_quoteId_fkey" FOREIGN KEY ("workspaceId", "quoteId") REFERENCES "Quote" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "QuoteVersion_workspaceId_pricingVersionId_fkey" FOREIGN KEY ("workspaceId", "pricingVersionId") REFERENCES "PricingVersion" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "QuoteItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "quoteVersionId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "serviceNameSnapshot" TEXT NOT NULL,
    "unitLabel" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitPricePaise" BIGINT NOT NULL,
    "lineTotalPaise" BIGINT NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "QuoteItem_workspaceId_quoteVersionId_fkey" FOREIGN KEY ("workspaceId", "quoteVersionId") REFERENCES "QuoteVersion" ("workspaceId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT "QuoteItem_workspaceId_serviceId_fkey" FOREIGN KEY ("workspaceId", "serviceId") REFERENCES "Service" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "QuoteShare" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "quoteVersionId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "supersededAt" DATETIME,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QuoteShare_workspaceId_quoteId_fkey" FOREIGN KEY ("workspaceId", "quoteId") REFERENCES "Quote" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "QuoteShare_workspaceId_quoteVersionId_fkey" FOREIGN KEY ("workspaceId", "quoteVersionId") REFERENCES "QuoteVersion" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "QuoteViewEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "quoteShareId" TEXT NOT NULL,
    "quoteVersionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "uaClass" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QuoteViewEvent_workspaceId_quoteShareId_fkey" FOREIGN KEY ("workspaceId", "quoteShareId") REFERENCES "QuoteShare" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "QuoteViewEvent_workspaceId_quoteVersionId_fkey" FOREIGN KEY ("workspaceId", "quoteVersionId") REFERENCES "QuoteVersion" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "QuoteAcceptance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "quoteVersionId" TEXT NOT NULL,
    "acceptorName" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL,
    "acceptedAt" DATETIME NOT NULL,
    CONSTRAINT "QuoteAcceptance_workspaceId_quoteId_fkey" FOREIGN KEY ("workspaceId", "quoteId") REFERENCES "Quote" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "QuoteAcceptance_workspaceId_quoteVersionId_fkey" FOREIGN KEY ("workspaceId", "quoteVersionId") REFERENCES "QuoteVersion" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "QuoteArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "quoteVersionId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "renderedAt" DATETIME NOT NULL,
    CONSTRAINT "QuoteArtifact_workspaceId_quoteVersionId_fkey" FOREIGN KEY ("workspaceId", "quoteVersionId") REFERENCES "QuoteVersion" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "quoteId" TEXT,
    "quoteVersionId" TEXT,
    "messageId" TEXT,
    "payloadHash" TEXT,
    "flags" JSONB NOT NULL,
    "requestedAt" DATETIME NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" DATETIME,
    "invalidatedAt" DATETIME,
    "invalidationReason" TEXT,
    CONSTRAINT "Approval_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Approval_workspaceId_quoteId_fkey" FOREIGN KEY ("workspaceId", "quoteId") REFERENCES "Quote" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "Approval_workspaceId_quoteVersionId_fkey" FOREIGN KEY ("workspaceId", "quoteVersionId") REFERENCES "QuoteVersion" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "Approval_workspaceId_messageId_fkey" FOREIGN KEY ("workspaceId", "messageId") REFERENCES "Message" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "contactKey" TEXT NOT NULL,
    "aiMode" TEXT NOT NULL DEFAULT 'DRAFT',
    "humanTakeover" BOOLEAN NOT NULL DEFAULT false,
    "modeVersion" INTEGER NOT NULL DEFAULT 0,
    "lastInboundProviderAt" DATETIME,
    "lastInboundMessageId" TEXT,
    "unansweredOutboundCount" INTEGER NOT NULL DEFAULT 0,
    "emailThreadToken" TEXT,
    "closedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Conversation_workspaceId_leadId_fkey" FOREIGN KEY ("workspaceId", "leadId") REFERENCES "Lead" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT,
    "subject" TEXT,
    "templateId" TEXT,
    "variables" JSONB,
    "quoteVersionId" TEXT,
    "status" TEXT NOT NULL,
    "statusRank" INTEGER NOT NULL DEFAULT 0,
    "providerMessageId" TEXT,
    "providerTs" DATETIME,
    "generatorLabel" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "replyToInboundId" TEXT,
    "modeVersionAtCreate" INTEGER,
    "sendIntent" TEXT,
    "initiatedBy" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_workspaceId_conversationId_fkey" FOREIGN KEY ("workspaceId", "conversationId") REFERENCES "Conversation" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "Message_workspaceId_templateId_fkey" FOREIGN KEY ("workspaceId", "templateId") REFERENCES "WhatsAppTemplate" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "Message_workspaceId_quoteVersionId_fkey" FOREIGN KEY ("workspaceId", "quoteVersionId") REFERENCES "QuoteVersion" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "Message_workspaceId_replyToInboundId_fkey" FOREIGN KEY ("workspaceId", "replyToInboundId") REFERENCES "Message" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "MessageStatusEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "messageId" TEXT,
    "providerMessageId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "providerTs" DATETIME NOT NULL,
    "errorCode" TEXT,
    "anomaly" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" DATETIME NOT NULL,
    CONSTRAINT "MessageStatusEvent_workspaceId_messageId_fkey" FOREIGN KEY ("workspaceId", "messageId") REFERENCES "Message" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "DispatchAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "quoteVersionId" TEXT,
    "approvalId" TEXT,
    "channel" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "sendIntent" TEXT NOT NULL,
    "initiatedBy" TEXT NOT NULL,
    "failureClass" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "reasonCode" TEXT,
    "errorRedacted" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" DATETIME,
    "resolutionNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DispatchAttempt_workspaceId_messageId_fkey" FOREIGN KEY ("workspaceId", "messageId") REFERENCES "Message" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "DispatchAttempt_workspaceId_quoteVersionId_fkey" FOREIGN KEY ("workspaceId", "quoteVersionId") REFERENCES "QuoteVersion" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "DispatchAttempt_workspaceId_approvalId_fkey" FOREIGN KEY ("workspaceId", "approvalId") REFERENCES "Approval" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "DispatchAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CallRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "conversationId" TEXT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "requestedAt" DATETIME NOT NULL,
    "handledBy" TEXT,
    "handledAt" DATETIME,
    "sourceEventId" TEXT,
    CONSTRAINT "CallRequest_workspaceId_leadId_fkey" FOREIGN KEY ("workspaceId", "leadId") REFERENCES "Lead" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CallRequest_workspaceId_conversationId_fkey" FOREIGN KEY ("workspaceId", "conversationId") REFERENCES "Conversation" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "WhatsAppTemplate" (
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
    "syncedAt" DATETIME NOT NULL,
    CONSTRAINT "WhatsAppTemplate_workspaceId_integrationId_fkey" FOREIGN KEY ("workspaceId", "integrationId") REFERENCES "Integration" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "integrationId" TEXT,
    "providerCampaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "configuredStatus" TEXT NOT NULL,
    "effectiveStatus" TEXT NOT NULL,
    "lastSyncedAt" DATETIME,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Campaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Campaign_workspaceId_integrationId_fkey" FOREIGN KEY ("workspaceId", "integrationId") REFERENCES "Integration" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "CampaignMetricSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "dateStart" DATETIME NOT NULL,
    "dateStop" DATETIME NOT NULL,
    "spendMinor" BIGINT NOT NULL,
    "leads" INTEGER NOT NULL,
    "cplMinor" BIGINT,
    "attributionSetting" TEXT,
    "asOf" DATETIME NOT NULL,
    CONSTRAINT "CampaignMetricSnapshot_workspaceId_campaignId_fkey" FOREIGN KEY ("workspaceId", "campaignId") REFERENCES "Campaign" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "CampaignAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "targetStatus" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "providerResultRedacted" TEXT,
    "requestedBy" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    CONSTRAINT "CampaignAction_workspaceId_campaignId_fkey" FOREIGN KEY ("workspaceId", "campaignId") REFERENCES "Campaign" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "config" JSONB NOT NULL,
    "routingKey" TEXT,
    "secrets" JSONB,
    "secretLast4" JSONB,
    "lastCheckedAt" DATETIME,
    "lastErrorCode" TEXT,
    "lastErrorRedacted" TEXT,
    "qualityRaw" TEXT,
    "messagingLimitRaw" TEXT,
    "limitsCheckedAt" DATETIME,
    "verifiedAt" DATETIME,
    CONSTRAINT "Integration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExtensionToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopes" JSONB NOT NULL,
    "allowedExtensionId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    CONSTRAINT "ExtensionToken_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT,
    "provider" TEXT NOT NULL,
    "integrationId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "externalKey" TEXT NOT NULL,
    "bodySha256" TEXT NOT NULL,
    "payloadRedacted" JSONB NOT NULL,
    "processingPayload" TEXT,
    "processingPurgedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" DATETIME NOT NULL,
    "processedAt" DATETIME
);

-- CreateTable
CREATE TABLE "WebhookRejection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT,
    "provider" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "day" DATETIME NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT,
    "actorUserId" TEXT,
    "actorKind" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "crossWorkspace" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "correlationId" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PipelineConfigVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "graph" JSONB NOT NULL,
    "approvalMode" TEXT NOT NULL DEFAULT 'HUMAN',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PipelineConfigVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PipelineExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "pipelineConfigVersionId" TEXT NOT NULL,
    "currentStage" TEXT NOT NULL DEFAULT 'INGESTION',
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PipelineExecution_workspaceId_leadId_fkey" FOREIGN KEY ("workspaceId", "leadId") REFERENCES "Lead" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "PipelineExecution_workspaceId_pipelineConfigVersionId_fkey" FOREIGN KEY ("workspaceId", "pipelineConfigVersionId") REFERENCES "PipelineConfigVersion" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "PipelineStageRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "outputRef" JSONB,
    "jobId" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "reasonCode" TEXT,
    CONSTRAINT "PipelineStageRun_workspaceId_executionId_fkey" FOREIGN KEY ("workspaceId", "executionId") REFERENCES "PipelineExecution" ("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE INDEX "Invite_workspaceId_createdAt_idx" ON "Invite"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Membership_workspaceId_idx" ON "Membership"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_workspaceId_key" ON "Membership"("userId", "workspaceId");

-- CreateIndex
CREATE INDEX "EmployeeAssignment_workspaceId_active_idx" ON "EmployeeAssignment"("workspaceId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeAssignment_employeeUserId_workspaceId_key" ON "EmployeeAssignment"("employeeUserId", "workspaceId");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_salesStage_createdAt_idx" ON "Lead"("workspaceId", "salesStage", "createdAt");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_score_idx" ON "Lead"("workspaceId", "score");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_nameNormalized_idx" ON "Lead"("workspaceId", "nameNormalized");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_phoneE164_idx" ON "Lead"("workspaceId", "phoneE164");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_emailNormalized_idx" ON "Lead"("workspaceId", "emailNormalized");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_createdAt_id_idx" ON "Lead"("workspaceId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_workspaceId_id_key" ON "Lead"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "LeadContactKey_leadId_idx" ON "LeadContactKey"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadContactKey_workspaceId_kind_value_key" ON "LeadContactKey"("workspaceId", "kind", "value");

-- CreateIndex
CREATE INDEX "LeadSourceRecord_importBatchId_idx" ON "LeadSourceRecord"("importBatchId");

-- CreateIndex
CREATE INDEX "LeadSourceRecord_leadId_idx" ON "LeadSourceRecord"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadSourceRecord_workspaceId_id_key" ON "LeadSourceRecord"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LeadSourceRecord_workspaceId_source_externalId_key" ON "LeadSourceRecord"("workspaceId", "source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatch_workspaceId_id_key" ON "ImportBatch"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatch_workspaceId_source_externalBatchId_key" ON "ImportBatch"("workspaceId", "source", "externalBatchId");

-- CreateIndex
CREATE INDEX "MergeReview_workspaceId_status_createdAt_idx" ON "MergeReview"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ConsentRecord_workspaceId_leadId_channel_collectedAt_idx" ON "ConsentRecord"("workspaceId", "leadId", "channel", "collectedAt");

-- CreateIndex
CREATE INDEX "ConsentRecord_workspaceId_contactKey_channel_idx" ON "ConsentRecord"("workspaceId", "contactKey", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentRecord_workspaceId_id_key" ON "ConsentRecord"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "Suppression_workspaceId_channel_contactKey_createdAt_idx" ON "Suppression"("workspaceId", "channel", "contactKey", "createdAt");

-- CreateIndex
-- PARTIAL UNIQUE (declared in schema.prisma via the partialIndexes preview feature, ADR-47)
CREATE UNIQUE INDEX "Suppression_active_contact_key" ON "Suppression"("workspaceId", "channel", "contactKey") WHERE "clearedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ScoringConfigVersion_workspaceId_id_key" ON "ScoringConfigVersion"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ScoringConfigVersion_workspaceId_version_key" ON "ScoringConfigVersion"("workspaceId", "version");

-- CreateIndex
-- PARTIAL UNIQUE (declared in schema.prisma via the partialIndexes preview feature, ADR-47)
CREATE UNIQUE INDEX "ScoringConfigVersion_one_active" ON "ScoringConfigVersion"("workspaceId") WHERE "active";

-- CreateIndex
CREATE INDEX "SheetMapping_workspaceId_integrationId_idx" ON "SheetMapping"("workspaceId", "integrationId");

-- CreateIndex
CREATE UNIQUE INDEX "SheetMapping_integrationId_version_key" ON "SheetMapping"("integrationId", "version");

-- CreateIndex
CREATE INDEX "MetaFormMapping_workspaceId_integrationId_idx" ON "MetaFormMapping"("workspaceId", "integrationId");

-- CreateIndex
CREATE UNIQUE INDEX "MetaFormMapping_integrationId_formId_key" ON "MetaFormMapping"("integrationId", "formId");

-- CreateIndex
CREATE UNIQUE INDEX "Service_workspaceId_id_key" ON "Service"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Service_workspaceId_code_key" ON "Service"("workspaceId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PricingVersion_workspaceId_id_key" ON "PricingVersion"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PricingVersion_workspaceId_version_key" ON "PricingVersion"("workspaceId", "version");

-- CreateIndex
-- PARTIAL UNIQUE (declared in schema.prisma via the partialIndexes preview feature, ADR-47)
CREATE UNIQUE INDEX "PricingVersion_one_active" ON "PricingVersion"("workspaceId") WHERE "active";

-- CreateIndex
CREATE INDEX "PriceEntry_workspaceId_idx" ON "PriceEntry"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceEntry_pricingVersionId_serviceId_key" ON "PriceEntry"("pricingVersionId", "serviceId");

-- CreateIndex
CREATE INDEX "Quote_workspaceId_status_updatedAt_idx" ON "Quote"("workspaceId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "Quote_leadId_idx" ON "Quote"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_workspaceId_id_key" ON "Quote"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_workspaceId_number_key" ON "Quote"("workspaceId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteVersion_workspaceId_id_key" ON "QuoteVersion"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteVersion_quoteId_versionNo_key" ON "QuoteVersion"("quoteId", "versionNo");

-- CreateIndex
CREATE INDEX "QuoteItem_workspaceId_idx" ON "QuoteItem"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteItem_quoteVersionId_position_key" ON "QuoteItem"("quoteVersionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteShare_tokenHash_key" ON "QuoteShare"("tokenHash");

-- CreateIndex
CREATE INDEX "QuoteShare_quoteVersionId_idx" ON "QuoteShare"("quoteVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteShare_workspaceId_id_key" ON "QuoteShare"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "QuoteViewEvent_quoteShareId_createdAt_idx" ON "QuoteViewEvent"("quoteShareId", "createdAt");

-- CreateIndex
CREATE INDEX "QuoteViewEvent_workspaceId_createdAt_idx" ON "QuoteViewEvent"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteAcceptance_quoteVersionId_key" ON "QuoteAcceptance"("quoteVersionId");

-- CreateIndex
CREATE INDEX "QuoteAcceptance_workspaceId_acceptedAt_idx" ON "QuoteAcceptance"("workspaceId", "acceptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteArtifact_quoteVersionId_key" ON "QuoteArtifact"("quoteVersionId");

-- CreateIndex
CREATE INDEX "QuoteArtifact_workspaceId_renderedAt_idx" ON "QuoteArtifact"("workspaceId", "renderedAt");

-- CreateIndex
CREATE INDEX "Approval_workspaceId_status_requestedAt_idx" ON "Approval"("workspaceId", "status", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_workspaceId_id_key" ON "Approval"("workspaceId", "id");

-- CreateIndex
-- PARTIAL UNIQUE (declared in schema.prisma via the partialIndexes preview feature, ADR-47)
CREATE UNIQUE INDEX "Approval_one_approved_per_quote_version" ON "Approval"("quoteVersionId") WHERE "kind" = 'QUOTE_VERSION' AND "status" = 'APPROVED';

-- CreateIndex
-- PARTIAL UNIQUE (declared in schema.prisma via the partialIndexes preview feature, ADR-47)
CREATE UNIQUE INDEX "Approval_one_open_per_message" ON "Approval"("messageId") WHERE "status" IN ('PENDING', 'APPROVED');

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_lastInboundProviderAt_idx" ON "Conversation"("workspaceId", "lastInboundProviderAt");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_leadId_channel_idx" ON "Conversation"("workspaceId", "leadId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_workspaceId_id_key" ON "Conversation"("workspaceId", "id");

-- CreateIndex
-- PARTIAL UNIQUE (declared in schema.prisma via the partialIndexes preview feature, ADR-47)
CREATE UNIQUE INDEX "Conversation_one_open_per_lead_channel" ON "Conversation"("workspaceId", "leadId", "channel") WHERE "closedAt" IS NULL;

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_workspaceId_id_key" ON "Message"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Message_channel_providerMessageId_key" ON "Message"("channel", "providerMessageId");

-- CreateIndex
CREATE INDEX "MessageStatusEvent_workspaceId_receivedAt_idx" ON "MessageStatusEvent"("workspaceId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageStatusEvent_providerMessageId_status_key" ON "MessageStatusEvent"("providerMessageId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchAttempt_idempotencyKey_key" ON "DispatchAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "DispatchAttempt_workspaceId_state_idx" ON "DispatchAttempt"("workspaceId", "state");

-- CreateIndex
CREATE INDEX "DispatchAttempt_jobId_idx" ON "DispatchAttempt"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchAttempt_messageId_attemptNo_key" ON "DispatchAttempt"("messageId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchAttempt_channel_providerMessageId_key" ON "DispatchAttempt"("channel", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "CallRequest_sourceEventId_key" ON "CallRequest"("sourceEventId");

-- CreateIndex
CREATE INDEX "CallRequest_workspaceId_status_requestedAt_idx" ON "CallRequest"("workspaceId", "status", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppTemplate_workspaceId_id_key" ON "WhatsAppTemplate"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppTemplate_integrationId_name_language_key" ON "WhatsAppTemplate"("integrationId", "name", "language");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_workspaceId_id_key" ON "Campaign"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_workspaceId_providerCampaignId_key" ON "Campaign"("workspaceId", "providerCampaignId");

-- CreateIndex
CREATE INDEX "CampaignMetricSnapshot_workspaceId_dateStart_idx" ON "CampaignMetricSnapshot"("workspaceId", "dateStart");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignMetricSnapshot_campaignId_dateStart_dateStop_key" ON "CampaignMetricSnapshot"("campaignId", "dateStart", "dateStop");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignAction_idempotencyKey_key" ON "CampaignAction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CampaignAction_workspaceId_createdAt_idx" ON "CampaignAction"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_routingKey_key" ON "Integration"("routingKey");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_workspaceId_id_key" ON "Integration"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_workspaceId_kind_key" ON "Integration"("workspaceId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionToken_prefix_key" ON "ExtensionToken"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionToken_workspaceId_id_key" ON "ExtensionToken"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_receivedAt_idx" ON "WebhookEvent"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_workspaceId_receivedAt_idx" ON "WebhookEvent"("workspaceId", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_processingPurgedAt_processedAt_idx" ON "WebhookEvent"("processingPurgedAt", "processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_scopeKey_externalKey_key" ON "WebhookEvent"("provider", "scopeKey", "externalKey");

-- CreateIndex
CREATE INDEX "WebhookRejection_workspaceId_day_idx" ON "WebhookRejection"("workspaceId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookRejection_provider_workspaceId_reason_day_key" ON "WebhookRejection"("provider", "workspaceId", "reason", "day");

-- CreateIndex
-- PARTIAL UNIQUE (declared in schema.prisma via the partialIndexes preview feature, ADR-47)
CREATE UNIQUE INDEX "WebhookRejection_unrouted_day" ON "WebhookRejection"("provider", "reason", "day") WHERE "workspaceId" IS NULL;

-- CreateIndex
CREATE INDEX "AuditEvent_workspaceId_createdAt_idx" ON "AuditEvent"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_createdAt_idx" ON "AuditEvent"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_targetType_targetId_idx" ON "AuditEvent"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditEvent_action_createdAt_idx" ON "AuditEvent"("action", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineConfigVersion_workspaceId_id_key" ON "PipelineConfigVersion"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineConfigVersion_workspaceId_version_key" ON "PipelineConfigVersion"("workspaceId", "version");

-- CreateIndex
-- PARTIAL UNIQUE (declared in schema.prisma via the partialIndexes preview feature, ADR-47)
CREATE UNIQUE INDEX "PipelineConfigVersion_one_active" ON "PipelineConfigVersion"("workspaceId") WHERE "active";

-- CreateIndex
CREATE UNIQUE INDEX "PipelineExecution_leadId_key" ON "PipelineExecution"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineExecution_workspaceId_id_key" ON "PipelineExecution"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "PipelineStageRun_workspaceId_status_idx" ON "PipelineStageRun"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineStageRun_executionId_stage_key" ON "PipelineStageRun"("executionId", "stage");

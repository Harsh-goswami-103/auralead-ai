/**
 * Fixture time columns that `demo:refresh` re-bases (P20). A refresh shifts every listed column
 * by (new anchor - previous anchor), so relative ages ("created 90 days ago", later: "window
 * closes in 3 hours", "quote expires tomorrow") stay true while every id stays the same. Audit
 * rows are history and are never re-based. Tasks that seed new time-dependent fixtures append
 * their table and columns here (T24 adds the window and expiry fixtures).
 *
 * ADR-126: the presentation pack (fixtures/presentation.ts) seeds chats, consents and an import
 * batch, so their time columns are here too: `Conversation.lastInboundProviderAt` and the message
 * times keep the seeded 24-hour windows open after a refresh.
 */
export const REBASE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  Workspace: ['createdAt'],
  WorkspaceSettings: ['updatedAt'],
  User: ['createdAt', 'lastLoginAt', 'lockedUntil'],
  Membership: ['createdAt'],
  EmployeeAssignment: ['createdAt'],
  PricingVersion: ['createdAt'],
  ScoringConfigVersion: ['createdAt'],
  PipelineConfigVersion: ['createdAt'],
  // T15 demo quotes (prisma/seed/fixtures/quotes.ts); lead-gen suite columns (ADR-118, ADR-124).
  Lead: ['createdAt', 'updatedAt', 'handedOverAt', 'placesContentExpiresAt', 'contactConfirmedAt'],
  Quote: ['createdAt', 'updatedAt', 'validUntil'],
  QuoteVersion: ['createdAt', 'validUntil', 'sentAt'],
  Approval: ['requestedAt', 'decidedAt', 'invalidatedAt'],
  // T16 demo shared quote (prisma/seed/fixtures/shared-quotes.ts).
  QuoteShare: ['createdAt', 'expiresAt', 'revokedAt', 'supersededAt'],
  // Lead-gen suite (ADR-118 to ADR-126): every time column it added, for the presentation seed.
  WhatsAppTemplate: ['syncedAt', 'submittedAt'],
  Conversation: ['createdAt', 'lastInboundProviderAt', 'closedAt', 'escalatedAt'],
  // ADR-126 presentation pack: chats, their consents and the finder import batch.
  Message: ['createdAt', 'providerTs'],
  ConsentRecord: ['collectedAt', 'recordedAt', 'withdrawnAt'],
  ImportBatch: ['createdAt', 'completedAt'],
  LeadSourceRecord: ['extractedAt', 'receivedAt'],
  LeadFinderRun: ['createdAt', 'startedAt', 'finishedAt', 'cancelledAt'],
  LeadFinderResult: ['contentExpiresAt', 'contentPurgedAt', 'importedAt', 'createdAt'],
  LeadImport: ['consentAttestedAt', 'createdAt', 'expiresAt', 'finishedAt'],
  LeadHandoff: ['acknowledgedAt', 'createdAt'],
  MediaAsset: ['providerHandleAt', 'createdAt'],
};

/** Primary key column per table when it is not `id`. */
export const REBASE_KEYS: Readonly<Record<string, string>> = {
  WorkspaceSettings: 'workspaceId',
};

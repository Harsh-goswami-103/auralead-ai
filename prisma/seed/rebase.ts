/**
 * Fixture time columns that `demo:refresh` re-bases (P20). A refresh shifts every listed column
 * by (new anchor - previous anchor), so relative ages ("created 90 days ago", later: "window
 * closes in 3 hours", "quote expires tomorrow") stay true while every id stays the same. Audit
 * rows are history and are never re-based. Tasks that seed new time-dependent fixtures append
 * their table and columns here (T24 adds the window and expiry fixtures).
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
  Conversation: ['escalatedAt'],
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

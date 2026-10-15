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
  // T15 demo quotes (prisma/seed/fixtures/quotes.ts).
  Lead: ['createdAt', 'updatedAt'],
  Quote: ['createdAt', 'updatedAt', 'validUntil'],
  QuoteVersion: ['createdAt', 'validUntil', 'sentAt'],
  Approval: ['requestedAt', 'decidedAt', 'invalidatedAt'],
  // T16 demo shared quote (prisma/seed/fixtures/shared-quotes.ts).
  QuoteShare: ['createdAt', 'expiresAt', 'revokedAt', 'supersededAt'],
};

/** Primary key column per table when it is not `id`. */
export const REBASE_KEYS: Readonly<Record<string, string>> = {
  WorkspaceSettings: 'workspaceId',
};

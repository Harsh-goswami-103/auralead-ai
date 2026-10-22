/**
 * Shared constants of the lead-gen suite (docs/handoff/lead-gen-suite-plan.md §4 B3; ADR-118 ..
 * ADR-126): one spelling of every job type, AI task, status string and route-manifest owner that
 * more than one slice reads. Framework-free and browser-safe, so services, jobs, routes, pages and
 * tests import the same names. Status strings live in plain String columns (never Prisma enums),
 * so these lists are the only place their values are written down.
 */

// ---- Slices -------------------------------------------------------------------------------------

/** The six slices that build the suite in parallel worktrees (plan §5). */
export const LEAD_GEN_SLICES = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'] as const;
export type LeadGenSlice = (typeof LEAD_GEN_SLICES)[number];

/** The short name in each slice's anchor comment and worktree (lg/f1 ...). */
export const LEAD_GEN_SLICE_NAMES: Readonly<Record<LeadGenSlice, string>> = {
  F1: 'finder',
  F2: 'import',
  F3: 'chat',
  F4: 'templates',
  F5: 'handoff',
  F6: 'presentation',
};

/** `RouteEntry.owner` of every page and route a slice adds to src/server/routes.manifest.ts (plan §5). */
export const LEAD_GEN_MANIFEST_OWNERS = {
  F1: 'T40',
  F2: 'T41',
  F3: 'T42',
  F4: 'T43',
  F5: 'T44',
  F6: 'T45',
} as const satisfies Record<LeadGenSlice, `T${number}`>;

/**
 * The comment lines that fence a slice's insertions in a shared file (plan §6): `// ---- lead-gen
 * F1 finder ----`, then the slice's lines, then `// ---- end F1 ----`. A slice appends only between
 * its own two lines.
 */
export function leadGenAnchor(slice: LeadGenSlice): { begin: string; end: string } {
  return { begin: `---- lead-gen ${slice} ${LEAD_GEN_SLICE_NAMES[slice]} ----`, end: `---- end ${slice} ----` };
}

// ---- Job types ----------------------------------------------------------------------------------

/** Job types the suite registers in src/server/jobs/registry.ts (plan §4 B3). */
export const LEAD_GEN_JOB_TYPES = {
  /** One Places Text Search page per job, self-continuing per run (ADR-118). */
  finderSearch: 'leadFinder.search',
  /** Email extraction from listed websites, at most 3 sites per job (ADR-118). */
  finderEmails: 'leadFinder.emails',
  /** Nulls a finder result's Places content at `contentExpiresAt` (24 h working copy, ADR-118 (a)). */
  finderPurge: 'leadFinder.purge',
  /** Nulls an imported lead's Places-sourced fields at `placesContentExpiresAt` unless confirmed (ADR-118 (d)). */
  placesExpire: 'leads.placesExpire',
  /** Processes a confirmed file import, 200 rows per chunk (ADR-120). */
  leadImport: 'leads.import',
  /** Deletes an import's parsed rows file at `expiresAt` (ADR-120). */
  importPurge: 'leads.importPurge',
  /** LIVE template submission to Meta (ADR-123). */
  templateSubmit: 'wa.templateSubmit',
  /** DEMO simulated template review after 30 s (ADR-123). */
  templateReview: 'wa.templateReview',
  /** DEMO simulated delivered and read statuses for the workspace's own sends (ADR-121). */
  demoStatus: 'wa.demoStatus',
  /** The AI handoff summary (kind ai, ADR-124). */
  handoffSummary: 'handoff.summary',
} as const;
export type LeadGenJobType = (typeof LEAD_GEN_JOB_TYPES)[keyof typeof LEAD_GEN_JOB_TYPES];

/** The slice that owns each job type's handler (plan §5). */
export const LEAD_GEN_JOB_OWNERS: Readonly<Record<LeadGenJobType, LeadGenSlice>> = {
  'leadFinder.search': 'F1',
  'leadFinder.emails': 'F1',
  'leadFinder.purge': 'F1',
  'leads.placesExpire': 'F1',
  'leads.import': 'F2',
  'leads.importPurge': 'F2',
  'wa.demoStatus': 'F3',
  'wa.templateSubmit': 'F4',
  'wa.templateReview': 'F4',
  'handoff.summary': 'F5',
};

// ---- AI tasks -----------------------------------------------------------------------------------

/** Model task names (the `task` of the user message and the local-deterministic dispatcher key). */
export const LEAD_GEN_AI_TASKS = {
  /** Catalog answers to service questions inside the 24-hour window (ADR-122). */
  conversationReply: 'conversation_reply',
  /** Template copy for a category the person chose first (ADR-123). */
  templateCopy: 'template_copy',
  /** The handoff summary for the client (ADR-124). */
  handoffSummary: 'handoff_summary',
} as const;
export type LeadGenAiTask = (typeof LEAD_GEN_AI_TASKS)[keyof typeof LEAD_GEN_AI_TASKS];

// ---- Lead Finder email extraction (ADR-118) ----------------------------------------------------

/** `LeadFinderResult.emailStatus`. */
export const FINDER_EMAIL_STATUSES = ['NOT_REQUESTED', 'PENDING', 'FOUND', 'NONE_FOUND', 'NO_WEBSITE', 'BLOCKED', 'FAILED'] as const;
export type FinderEmailStatus = (typeof FINDER_EMAIL_STATUSES)[number];

export const FINDER_EMAIL_STATUS_LABELS: Readonly<Record<FinderEmailStatus, string>> = {
  NOT_REQUESTED: 'Not requested',
  PENDING: 'Checking the website',
  FOUND: 'Emails found',
  NONE_FOUND: 'No emails on the website',
  NO_WEBSITE: 'No website listed',
  BLOCKED: "Not checked: the site's robots.txt disallows it",
  FAILED: 'Website could not be read',
};

/** The kind stored with each extracted address `{address, sourceUrl, kind}`. */
export const FINDER_EMAIL_KINDS = ['ROLE', 'PERSONAL', 'FREEMAIL'] as const;
export type FinderEmailKind = (typeof FINDER_EMAIL_KINDS)[number];

// ---- Contact confirmation (ADR-118 (d)) --------------------------------------------------------

/** `Lead.contactConfirmedVia`: how Places-sourced contact details became first-party data. */
export const CONTACT_CONFIRMED_VIA = ['INBOUND_WHATSAPP', 'RECORDED_OPT_IN', 'WEBSITE_EMAIL', 'OPERATOR'] as const;
export type ContactConfirmedVia = (typeof CONTACT_CONFIRMED_VIA)[number];

export const CONTACT_CONFIRMED_VIA_LABELS: Readonly<Record<ContactConfirmedVia, string>> = {
  INBOUND_WHATSAPP: 'The customer messaged on WhatsApp from this number',
  RECORDED_OPT_IN: 'A WhatsApp opt-in was recorded',
  WEBSITE_EMAIL: "The email matches the business's own website",
  OPERATOR: 'Confirmed by an operator',
};

// ---- Handoff summary (ADR-124) -----------------------------------------------------------------

/** `LeadHandoff.summaryStatus`. */
export const HANDOFF_SUMMARY_STATUSES = ['READY', 'PENDING', 'NOT_CONFIGURED', 'FAILED'] as const;
export type HandoffSummaryStatus = (typeof HANDOFF_SUMMARY_STATUSES)[number];

export const HANDOFF_SUMMARY_STATUS_LABELS: Readonly<Record<HandoffSummaryStatus, string>> = {
  READY: 'Summary ready',
  PENDING: 'Summary being written',
  NOT_CONFIGURED: 'No AI integration: no summary',
  FAILED: 'Summary could not be written',
};

// ---- Template studio (ADR-123) -----------------------------------------------------------------

/** A template saved in the studio and not submitted. Never sendable (only APPROVED is). */
export const TEMPLATE_DRAFT_STATUS = 'DRAFT';
/** A submission to the provider is in flight (LIVE `wa.templateSubmit`). Never sendable. */
export const TEMPLATE_SUBMITTING_STATUS = 'SUBMITTING';
/** Statuses this app writes itself; every other `WhatsAppTemplate.status` is the provider's raw string. */
export const LOCAL_TEMPLATE_STATUSES = [TEMPLATE_DRAFT_STATUS, TEMPLATE_SUBMITTING_STATUS] as const;

/** True for DRAFT and SUBMITTING (compared like every status reader: trimmed, upper-cased). A sync never counts these as missing. */
export function isLocalTemplateStatus(status: string | null | undefined): boolean {
  const s = (status ?? '').trim().toUpperCase();
  return s === TEMPLATE_DRAFT_STATUS || s === TEMPLATE_SUBMITTING_STATUS;
}

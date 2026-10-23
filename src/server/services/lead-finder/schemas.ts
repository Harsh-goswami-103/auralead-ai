/**
 * Lead Finder request shapes and limits (ADR-118, slice F1). Pure (zod only, no server imports),
 * so the routes validate with them and the finder components can read the limits and labels.
 */
import { z } from 'zod';

export const FINDER_LIMITS = {
  /** Keywords and locations per run (plan §5 F1: 10 x 10). */
  maxKeywords: 10,
  maxLocations: 10,
  maxKeywordLength: 80,
  maxLocationLength: 120,
  /** Results asked for per keyword x location cell: one, two or three Text Search pages. */
  perQueryOptions: [20, 40, 60] as const,
  maxBlacklistEntries: 50,
  maxBlacklistEntryLength: 254,
  /** Results imported per request (chunks of 100 through ingestBatch). */
  maxImport: 200,
  /** Expired results refreshed per request (each one is a paid Place Details call in LIVE). */
  maxRefresh: 10,
  /** Results per page of the grid. */
  pageSize: 50,
} as const;

/** Error codes a run can end with (`LeadFinderRun.errorCode`), with what the person should do. */
export const FINDER_ERROR_LABELS: Readonly<Record<string, string>> = {
  PLACES_NOT_CONFIGURED: 'Google Places is not set up: save the API key in the integration setup.',
  PLACES_CREDENTIAL_UNREADABLE: 'The saved Google Places key cannot be read: enter it again in the integration setup.',
  PLACES_AUTH: 'Google rejected the API key: enter a valid key in the integration setup.',
  PLACES_PERMISSION: 'Google refused the request: enable the Places API (New) and billing for the key’s project, or lift the key’s restrictions.',
  PLACES_RATE_LIMITED: 'Google’s quota for this key was exhausted; some searches were skipped.',
  PLACES_UNAVAILABLE: 'Google Places was unavailable; some searches were skipped.',
  PLACES_UNREACHABLE: 'Google Places could not be reached; some searches were skipped.',
  PLACES_INVALID_ARGUMENT: 'Google did not accept one of the searches; it was skipped.',
  PLACES_REJECTED: 'Google answered in an unexpected way; a search was skipped.',
  MODE_MISMATCH: 'This workspace belongs to the other mode.',
};

/** ADR-118 (b): the line shown with Places content in LIVE, next to the "Google Maps" attribution. */
export const GOOGLE_MAPS_TERMS_LINE = 'Results from Google Maps. Use is subject to the Google Maps Additional Terms of Service and the Google Privacy Policy.';
export const GOOGLE_MAPS_ADDITIONAL_TERMS_URL = 'https://maps.google.com/help/terms_maps/';
export const GOOGLE_PRIVACY_POLICY_URL = 'https://policies.google.com/privacy';

export type FinderPerQuery = (typeof FINDER_LIMITS.perQueryOptions)[number];

const requestKey = z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/);
const workspaceSlug = z.string().trim().min(1).max(100).optional();

const terms = (max: number, length: number, what: string) =>
  z
    .array(z.string().max(length * 2))
    .max(max * 4)
    .transform((list, c) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const raw of list) {
        const value = raw.trim().replace(/\s+/g, ' ');
        if (value === '') continue;
        if (value.length > length) {
          c.addIssue({ code: 'custom', message: `each ${what} is at most ${length} characters` });
          return z.NEVER;
        }
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
      }
      if (out.length === 0) {
        c.addIssue({ code: 'custom', message: `add at least one ${what}` });
        return z.NEVER;
      }
      if (out.length > max) {
        c.addIssue({ code: 'custom', message: `at most ${max} ${what}s per search` });
        return z.NEVER;
      }
      return out;
    });

/** One blacklist entry: a whole address (`info@x.in`) or a domain (`x.in`, `@x.in`); lower-cased. */
const blacklist = z
  .array(z.string().max(FINDER_LIMITS.maxBlacklistEntryLength))
  .max(FINDER_LIMITS.maxBlacklistEntries)
  .transform((list) => [...new Set(list.map((e) => e.trim().toLowerCase().replace(/^@/, '')).filter((e) => e !== ''))])
  .refine((list) => list.every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$|^[a-z0-9.-]+\.[a-z]{2,}$/.test(e)), { message: 'each blacklist entry is an email address or a domain' });

export const StartFinderRunBody = z.object({
  workspaceSlug,
  requestKey,
  keywords: terms(FINDER_LIMITS.maxKeywords, FINDER_LIMITS.maxKeywordLength, 'keyword'),
  locations: terms(FINDER_LIMITS.maxLocations, FINDER_LIMITS.maxLocationLength, 'location'),
  maxPerQuery: z.union([z.literal(20), z.literal(40), z.literal(60)]),
  extractEmails: z.boolean().default(false),
  emailBlacklist: blacklist.default([]),
});
export type StartFinderRunBody = z.input<typeof StartFinderRunBody>;
export type StartFinderRunInput = z.output<typeof StartFinderRunBody>;

export const ImportFinderResultsBody = z.object({
  workspaceSlug,
  requestKey,
  resultIds: z.array(z.string().trim().min(1).max(64)).min(1).max(FINDER_LIMITS.maxImport),
});
export type ImportFinderResultsBody = z.input<typeof ImportFinderResultsBody>;

export const RefreshFinderResultsBody = z.object({
  workspaceSlug,
  resultIds: z.array(z.string().trim().min(1).max(64)).min(1).max(FINDER_LIMITS.maxRefresh),
});
export type RefreshFinderResultsBody = z.input<typeof RefreshFinderResultsBody>;

export const WorkspaceSlugBody = z.object({ workspaceSlug });

const flag = z
  .enum(['1', 'true', '0', 'false'])
  .optional()
  .transform((v) => v === '1' || v === 'true');

/** `?noWebsite=1&hasPhone=1&notImported=1&page=2` of the results reads (real columns, never JSON). */
export const FinderResultsQuery = z.object({
  workspaceSlug,
  noWebsite: flag,
  hasPhone: flag,
  notImported: flag,
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
export type FinderResultFilters = { noWebsite: boolean; hasPhone: boolean; notImported: boolean };

/**
 * What a workspace created by a super admin starts with (T29, ADR-85). These are production
 * defaults, not demo fixtures: no services, prices, leads, integrations or sample data. The owner
 * adds their catalog in Pricing (the first service publishes price list v1), connects channels in
 * the Integration center and changes every setting below from the client panel.
 *
 *  - Scoring v1 and pipeline v1 are the same shapes every seeded DEMO workspace starts with
 *    (prisma/seed/fixtures/configs.ts; tests/unit/admin/workspace-defaults.test.ts keeps them
 *    equal), so ingestion can pin a pipeline version and the SCORE stage has an active config from
 *    the first lead on. Approval is HUMAN: nothing is sent without a person (R29).
 *  - Settings are conservative: auto-send, email fallback and B2B attestation off, no tax line
 *    until the owner configures GST (plan §8: tax is never implicit), quotes valid 15 days, a 10%
 *    discount ceiling the owner can lower or raise, no booking link, no internal caps.
 *
 * Pure module: no DB access, importable by unit tests.
 */
import type { TaxMode } from '@/generated/prisma/client';

export const DEFAULT_SCORING_CONFIG = {
  schemaVersion: 1,
  weights: {
    phonePresent: 15,
    emailPresent: 10,
    websiteStatus: 20,
    rating: 20,
    reviewCount: 15,
    categoryMatch: 15,
    sourceIntent: 5,
  },
  notes: 'Heuristic opportunity score. Not a measure of buying intent or consent.',
} as const;

export const DEFAULT_PIPELINE_GRAPH = {
  schemaVersion: 1,
  stages: [
    { id: 'ingestion', kind: 'INGESTION', label: 'Ingestion' },
    { id: 'score', kind: 'SCORE', label: 'Score' },
    { id: 'draft', kind: 'DRAFT', label: 'Draft' },
    { id: 'approval', kind: 'APPROVAL', label: 'Approval' },
    { id: 'delivery', kind: 'DELIVERY', label: 'Delivery' },
  ],
  edges: [
    { from: 'ingestion', to: 'score' },
    { from: 'score', to: 'draft' },
    { from: 'draft', to: 'approval' },
    { from: 'approval', to: 'delivery' },
  ],
} as const;

export const DEFAULT_PIPELINE_APPROVAL_MODE = 'HUMAN' as const;
export const DEFAULT_MAX_DISCOUNT_BPS = 1000;
export const DEFAULT_QUOTE_VALIDITY_DAYS = 15;
/** A deep teal; the quote page and PDF darken any brand color to 4.5:1 for text (F14). */
export const DEFAULT_BRAND_COLOR = '#0E7490';

export type DefaultWorkspaceSettings = {
  autoSendEnabled: boolean;
  emailB2bAttestationEnabled: boolean;
  emailFallbackEnabled: boolean;
  taxMode: TaxMode;
  taxLabel: string | null;
  taxBps: number | null;
  maxDiscountBps: number;
  quoteValidityDays: number;
  gstin: string | null;
  brandColor: string;
  logoPath: string | null;
  termsText: string;
  bookingUrl: string | null;
  internalWaDailyCap: number | null;
  internalEmailDailyCap: number | null;
  currencyDisplay: 'INR';
};

/** Quotation terms a new workspace prints until the owner writes their own. True for the defaults above. */
export function defaultTermsText(input: { name: string }): string {
  return [
    `Prices are in Indian Rupees (INR) and valid for ${DEFAULT_QUOTE_VALIDITY_DAYS} days from the quotation date.`,
    'Taxes are charged only where a tax line is shown on the quotation.',
    `This quotation is issued by ${input.name}; work starts after written acceptance.`,
  ].join('\n');
}

export function defaultWorkspaceSettings(input: { name: string }): DefaultWorkspaceSettings {
  return {
    autoSendEnabled: false,
    emailB2bAttestationEnabled: false,
    emailFallbackEnabled: false,
    taxMode: 'NONE',
    taxLabel: null,
    taxBps: null,
    maxDiscountBps: DEFAULT_MAX_DISCOUNT_BPS,
    quoteValidityDays: DEFAULT_QUOTE_VALIDITY_DAYS,
    gstin: null,
    brandColor: DEFAULT_BRAND_COLOR,
    logoPath: null,
    termsText: defaultTermsText(input),
    bookingUrl: null,
    internalWaDailyCap: null,
    internalEmailDailyCap: null,
    currencyDisplay: 'INR',
  };
}

/** An IANA time zone this runtime knows (Intl throws a RangeError for anything else). */
export function isValidTimezone(value: string): boolean {
  if (value.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-IN', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

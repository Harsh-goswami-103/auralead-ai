/**
 * The opportunity score (R14, D4, G-NORM-3): a pure function of a lead's stored fields and one
 * ScoringConfigVersion. No I/O, no clock.
 *
 * - Each of the seven inputs is either known (it earns `round(weight * fraction)` points and
 *   becomes a reason, including known zeros such as "No email on record") or unknown (weight 0,
 *   listed in `unknownInputs`, never treated as a negative signal).
 * - The score is the sum of the reason points, so it is always explained exactly, and it stays in
 *   0..100 because each reason is capped by its weight and the weights sum to 100.
 * - Website: only REACHABLE, VERIFIED_ABSENT and NOT_LISTED are known (G-SSRF-2, ADR-119).
 *   NOT_LISTED (the source listing says there is no website) scores like VERIFIED_ABSENT.
 *   UNKNOWN, PRESENT_UNVERIFIED, UNREACHABLE and BLOCKED say nothing about the business and are
 *   unknown.
 * - Source intent: forms and inbound messages are known 1; a Maps listing (the extension or a
 *   Google Places search, ADR-118) is a known 0; a manual entry or a file import is unknown, each
 *   with its own reason code.
 * - The result names the config version it was computed with, so a stored score stays
 *   reproducible after the config changes.
 */
import type { LeadSource, WebsiteStatus } from '@/lib/domain/enums';
import { DEFAULT_REVIEW_COUNT_TARGET, SCORE_CAPTION, type ScoreInputName, type ScoringConfig } from '@/lib/schemas/scoring';

export type ScoreInput = {
  phoneE164: string | null;
  emailNormalized: string | null;
  websiteStatus: WebsiteStatus;
  /** Stars x10 (4.5 is 45). */
  rating: number | null;
  reviewCount: number | null;
  category: string | null;
  firstSource: LeadSource;
};

export type ScoringConfigRef = { id: string; version: number; config: ScoringConfig };

export type ScoreReason = { input: ScoreInputName; points: number; maxPoints: number; label: string };
export type UnknownInput = { input: ScoreInputName; reasonCode: string; label: string };

export type ScoreResult = {
  score: number;
  reasons: ScoreReason[];
  unknownInputs: UnknownInput[];
  configVersionId: string;
  configVersion: number;
  caption: typeof SCORE_CAPTION;
};

type Factor = { known: true; fraction: number; label: string } | { known: false; reasonCode: string; label: string };

const FORM_OR_INBOUND: ReadonlySet<LeadSource> = new Set(['GOOGLE_SHEETS', 'META_ADS', 'WHATSAPP_INBOUND', 'EMAIL_INBOUND']);
const MAPS_LISTING: ReadonlySet<LeadSource> = new Set(['GMAPS_EXTENSION', 'GOOGLE_PLACES']);

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function norm(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function website(status: WebsiteStatus, preference: 'PRESENT' | 'ABSENT'): Factor {
  if (status === 'REACHABLE') return { known: true, fraction: preference === 'PRESENT' ? 1 : 0, label: 'Website reachable' };
  if (status === 'VERIFIED_ABSENT') return { known: true, fraction: preference === 'ABSENT' ? 1 : 0, label: 'No website (verified by a person)' };
  if (status === 'NOT_LISTED') return { known: true, fraction: preference === 'ABSENT' ? 1 : 0, label: 'No website listed' };
  const labels: Record<string, string> = {
    UNKNOWN: 'Website: unknown, not verified absent',
    PRESENT_UNVERIFIED: 'Website: listed, not checked yet',
    UNREACHABLE: 'Website: unreachable when checked',
    BLOCKED: 'Website: not checked (blocked destination)',
  };
  return { known: false, reasonCode: `WEBSITE_${status}`, label: labels[status] ?? 'Website: unknown' };
}

function factors(input: ScoreInput, config: ScoringConfig): Record<ScoreInputName, Factor> {
  const reviewTarget = config.reviewCountTarget ?? DEFAULT_REVIEW_COUNT_TARGET;
  const targets = (config.targetCategories ?? []).map(norm).filter(Boolean);
  const category = input.category === null ? '' : norm(input.category);

  let categoryMatch: Factor;
  if (targets.length === 0) categoryMatch = { known: false, reasonCode: 'NO_TARGET_CATEGORIES', label: 'Category: no target categories configured' };
  else if (category === '') categoryMatch = { known: false, reasonCode: 'CATEGORY_MISSING', label: 'Category: not on record' };
  else {
    const hit = targets.some((t) => category.includes(t) || t.includes(category));
    categoryMatch = { known: true, fraction: hit ? 1 : 0, label: hit ? 'Category matches a target category' : 'Category is not a target category' };
  }

  let sourceIntent: Factor;
  if (FORM_OR_INBOUND.has(input.firstSource)) sourceIntent = { known: true, fraction: 1, label: 'Came in through a form or an inbound message' };
  else if (MAPS_LISTING.has(input.firstSource)) sourceIntent = { known: true, fraction: 0, label: 'Found on a Maps listing; no inbound action' };
  else if (input.firstSource === 'FILE_IMPORT') sourceIntent = { known: false, reasonCode: 'SOURCE_FILE_IMPORT', label: 'Source: imported from a file' };
  else sourceIntent = { known: false, reasonCode: 'SOURCE_MANUAL', label: 'Source: added by hand' };

  return {
    phonePresent: input.phoneE164 ? { known: true, fraction: 1, label: 'Phone on record' } : { known: true, fraction: 0, label: 'No phone on record' },
    emailPresent: input.emailNormalized ? { known: true, fraction: 1, label: 'Email on record' } : { known: true, fraction: 0, label: 'No email on record' },
    websiteStatus: website(input.websiteStatus, config.websitePreference ?? 'PRESENT'),
    rating:
      input.rating === null
        ? { known: false, reasonCode: 'RATING_MISSING', label: 'Rating: not on record' }
        : { known: true, fraction: clamp01(input.rating / 50), label: `Rated ${(input.rating / 10).toFixed(1)} of 5` },
    reviewCount:
      input.reviewCount === null
        ? { known: false, reasonCode: 'REVIEW_COUNT_MISSING', label: 'Reviews: not on record' }
        : { known: true, fraction: clamp01(input.reviewCount / reviewTarget), label: `${input.reviewCount} reviews` },
    categoryMatch,
    sourceIntent,
  };
}

const ORDER: readonly ScoreInputName[] = ['phonePresent', 'emailPresent', 'websiteStatus', 'rating', 'reviewCount', 'categoryMatch', 'sourceIntent'];

export function scoreLead(input: ScoreInput, ref: ScoringConfigRef): ScoreResult {
  const all = factors(input, ref.config);
  const reasons: ScoreReason[] = [];
  const unknownInputs: UnknownInput[] = [];
  for (const name of ORDER) {
    const f = all[name];
    const maxPoints = ref.config.weights[name];
    if (f.known) reasons.push({ input: name, points: Math.round(maxPoints * f.fraction), maxPoints, label: f.label });
    else unknownInputs.push({ input: name, reasonCode: f.reasonCode, label: f.label });
  }
  return {
    score: reasons.reduce((s, r) => s + r.points, 0),
    reasons,
    unknownInputs,
    configVersionId: ref.id,
    configVersion: ref.version,
    caption: SCORE_CAPTION,
  };
}

/**
 * Lead normalization (R12, R13). Pure: no I/O, no clock.
 *
 * - Names: NFKC, whitespace collapsed; `nameNormalized` additionally folds case and accents and
 *   drops punctuation (the column used for search and display sorting).
 * - Phones: every number in the field is converted to E.164 with region IN (`src/lib/phone.ts`).
 *   The first valid one is `phoneE164`, further valid ones are `alternatePhones`, and the raw
 *   text is kept in `phoneRaw`. Invalid pieces are never guessed at.
 * - Email: trimmed and lowercased; malformed or placeholder addresses become null. An email is
 *   never invented from a name, website or phone.
 * - Website: http(s) only, scheme added when missing, no credentials, a dotted hostname. A
 *   supplied website is PRESENT_UNVERIFIED; otherwise UNKNOWN. Only enrichment (T12) moves it
 *   to REACHABLE/UNREACHABLE/BLOCKED, and only a human sets VERIFIED_ABSENT.
 * - A record is rejected (per row, with a reason code) when it has no name or no valid phone
 *   and no valid email.
 */
import { parsePhones } from '@/lib/phone';
import type { IngestFields } from '@/lib/schemas/ingest';

export type NormalizedLead = {
  displayName: string;
  nameNormalized: string;
  category: string | null;
  phoneE164: string | null;
  phoneRaw: string | null;
  alternatePhones: string[];
  emailNormalized: string | null;
  website: string | null;
  websiteStatus: 'UNKNOWN' | 'PRESENT_UNVERIFIED';
  address: string | null;
  city: string | null;
  /** Stars x10 (4.5 is 45). */
  rating: number | null;
  reviewCount: number | null;
};

export type NormalizeRejectReason = 'MISSING_NAME' | 'NO_VALID_CONTACT';
export type NormalizeResult = { ok: true; lead: NormalizedLead } | { ok: false; reasonCode: NormalizeRejectReason };

const MAX_NAME = 200;
const MAX_TEXT = 500;

function cleanText(value: string | null | undefined, max = MAX_TEXT): string | null {
  if (value === null || value === undefined) return null;
  const s = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return s === '' ? null : s.slice(0, max);
}

export function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const PLACEHOLDER_LOCAL_PARTS = new Set([
  'na', 'n.a', 'none', 'nil', 'null', 'nothing', 'noemail', 'no-email', 'no_email', 'no.email', 'nomail', 'no-mail',
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply', 'test', 'testing', 'dummy', 'sample', 'fake',
  'abc', 'xyz', 'xxx', 'asdf', 'unknown', 'notavailable', 'not.available', 'email', 'mail',
]);
const PLACEHOLDER_DOMAINS = new Set(['na.com', 'test.com', 'domain.com', 'xyz.com', 'abc.com', 'email.test', 'mailinator.com']);
const PLACEHOLDER_TLDS = new Set(['test', 'example', 'invalid', 'localhost', 'local']);

export function isPlaceholderEmail(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return true;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  if (PLACEHOLDER_LOCAL_PARTS.has(local)) return true;
  if (PLACEHOLDER_DOMAINS.has(domain) || PLACEHOLDER_TLDS.has(tld)) return true;
  // RFC 2606 reserved second-level domains.
  if (/^example\.(com|org|net)$/.test(domain)) return true;
  return false;
}

/** A syntactically valid, non-placeholder address, lowercased; otherwise null. */
export function normalizeEmail(value: string | null | undefined): string | null {
  const s = cleanText(value, 320);
  if (s === null) return null;
  const email = s.replace(/^mailto:/i, '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return null;
  return isPlaceholderEmail(email) ? null : email;
}

export function normalizeWebsite(value: string | null | undefined): string | null {
  const s = cleanText(value, 2048);
  if (s === null || /\s/.test(s)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s);
  if (hasScheme && !/^https?:\/\//i.test(s)) return null;
  let url: URL;
  try {
    url = new URL(hasScheme ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  const host = url.hostname;
  if (!host.includes('.') || host.endsWith('.') || /^[\d.]+$/.test(host) || host.startsWith('[')) return null;
  url.hash = '';
  return url.toString();
}

export function parseRatingX10(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value.trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 5) return null;
  return Math.round(n * 10);
}

export function parseReviewCount(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  let n: number;
  if (typeof value === 'number') n = value;
  else {
    const digits = value.replace(/[,\s]/g, '').match(/\d+/);
    if (!digits) return null;
    n = Number(digits[0]);
  }
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

export function normalizeLeadFields(fields: IngestFields): NormalizeResult {
  const displayName = cleanText(fields.name, MAX_NAME);
  if (displayName === null) return { ok: false, reasonCode: 'MISSING_NAME' };

  const phoneRaw = cleanText(fields.phone, 300);
  const phones = phoneRaw === null ? { primary: null, alternates: [] as string[] } : parsePhones(phoneRaw);
  const emailNormalized = normalizeEmail(fields.email);
  if (phones.primary === null && emailNormalized === null) return { ok: false, reasonCode: 'NO_VALID_CONTACT' };

  const website = normalizeWebsite(fields.website);
  return {
    ok: true,
    lead: {
      displayName,
      nameNormalized: normalizeName(displayName),
      category: cleanText(fields.category, 200),
      phoneE164: phones.primary,
      phoneRaw,
      alternatePhones: phones.alternates,
      emailNormalized,
      website,
      websiteStatus: website === null ? 'UNKNOWN' : 'PRESENT_UNVERIFIED',
      address: cleanText(fields.address, 1000),
      city: cleanText(fields.city, 200),
      rating: parseRatingX10(fields.rating),
      reviewCount: parseReviewCount(fields.reviewCount),
    },
  };
}

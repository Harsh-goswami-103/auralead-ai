/**
 * WhatsApp quality rating and messaging limit, read raw (T32; R26, plan §5.1, §13, ADR-30).
 *
 * The values are stored exactly as the provider returns them (`Integration.qualityRaw`,
 * `messagingLimitRaw`, `limitsCheckedAt`). There is deliberately no tier list, tier enum or
 * mapping to numbers anywhere in this app: Meta has changed both the values and where limits live
 * (per business portfolio since 2025, per the snippets below), and a stale table would show a
 * wrong limit as fact. A field the answer does not carry is stored as null and shown as
 * "Unknown, last checked <time>".
 *
 * Fields requested on GET /<version>/<PHONE_NUMBER_ID> (UNVERIFIED, from search snippets of
 * developers.facebook.com "Messaging limits", 2026-10-20): `quality_rating` (snippets show upper-case
 * values and NA for an ungraded number) and `whatsapp_business_manager_messaging_limit`, which the
 * snippet names as the replacement of the deprecated `messaging_limit_tier`. Quality RED pauses
 * automation through the eligibility check QUALITY_PAUSED (plan §7 check 6): a raw-value
 * comparison, not a tier enum.
 */
import { describeGraphFailure, type CloudApiClient } from './cloud-api';

export const WA_LIMITS_CHECKED_ON = '2026-10-20';
export const WA_QUALITY_FIELD = 'quality_rating';
export const WA_MESSAGING_LIMIT_FIELD = 'whatsapp_business_manager_messaging_limit';
const MAX_RAW_CHARS = 200;

export type RawQualityLimits = { qualityRaw: string | null; messagingLimitRaw: string | null };

/** A raw provider value as a bounded string: strings as they are, objects as compact JSON, absent as null. */
export function rawValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : value.slice(0, MAX_RAW_CHARS);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value).slice(0, MAX_RAW_CHARS);
  } catch {
    return null;
  }
}

export function readQualityLimits(phoneNumber: Record<string, unknown>): RawQualityLimits {
  return { qualityRaw: rawValue(phoneNumber[WA_QUALITY_FIELD]), messagingLimitRaw: rawValue(phoneNumber[WA_MESSAGING_LIMIT_FIELD]) };
}

export type QualityFetch = { ok: true; values: RawQualityLimits } | { ok: false; httpStatus: number | null; errorCode: string | null; error: string };

export async function fetchQualityLimits(client: CloudApiClient): Promise<QualityFetch> {
  const res = await client.getPhoneNumber(['id', WA_QUALITY_FIELD, WA_MESSAGING_LIMIT_FIELD]);
  if (res.ok) return { ok: true, values: readQualityLimits(res.data) };
  return { ok: false, httpStatus: res.status, errorCode: res.error.code, error: describeGraphFailure(res) };
}

/** Quality RED is the provider's own value for the lowest rating; compared raw, case-insensitive. */
export function isQualityRed(qualityRaw: string | null): boolean {
  return (qualityRaw ?? '').trim().toUpperCase() === 'RED';
}

/**
 * Money in an ad account's own currency (P6): Meta reports spend and cost per result as decimal
 * strings in the ad account currency ("1842.50"). They are stored as integer minor units of that
 * same currency and never converted to INR or any other currency. The number of minor digits is
 * the one the platform's Intl data uses for the ISO 4217 code (INR 2, USD 2, JPY 0, KWD 3), the
 * same rule the Meta page uses to format them back (`formatMinor`).
 *
 * Rounding is explicit (R5): a value with more fraction digits than the currency has is rounded
 * half-up on the first dropped digit. Framework-free.
 */

const CURRENCY_RE = /^[A-Z]{3}$/;
const DECIMAL_RE = /^(\d{1,15})(?:\.(\d{1,9}))?$/;

/** Minor digits of an ISO 4217 code, or null when the platform does not know the currency. */
export function currencyMinorDigits(currency: string): number | null {
  if (!CURRENCY_RE.test(currency)) return null;
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    return typeof digits === 'number' && Number.isInteger(digits) && digits >= 0 && digits <= 4 ? digits : null;
  } catch {
    return null;
  }
}

/**
 * "1842.50" in INR -> 184250n. Returns null for anything that is not a plain non-negative decimal
 * or for an unknown currency (nothing is guessed).
 */
export function decimalToMinor(value: string, currency: string): bigint | null {
  const digits = currencyMinorDigits(currency);
  if (digits === null) return null;
  const m = DECIMAL_RE.exec(value.trim());
  if (!m) return null;
  const whole = m[1]!;
  const fraction = m[2] ?? '';
  const kept = fraction.slice(0, digits).padEnd(digits, '0');
  let minor = BigInt(whole) * 10n ** BigInt(digits) + (kept === '' ? 0n : BigInt(kept));
  const firstDropped = fraction.length > digits ? Number(fraction[digits]) : 0;
  if (firstDropped >= 5) minor += 1n;
  return minor;
}

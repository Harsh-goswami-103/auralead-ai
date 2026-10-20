/**
 * Landing ROI calculator math (plan T30, 06-design F12): an illustrative estimate, never a claim.
 * Every assumption is visible and editable on the page, and this module only does arithmetic on
 * them. Pure and framework-free: no React, no Next, no clock.
 *
 * Model (all per month):
 *   replies now        = leads x current reply rate
 *   replies with lift  = leads x (current reply rate + assumed lift), the rate capped at 100%
 *   extra deals        = (replies with lift - replies now) x close rate
 *   extra revenue      = extra deals x average deal value
 *   hours saved        = leads x hours saved per lead
 * Inputs are clamped to sane ranges and anything that is not a finite number falls back to the
 * range minimum, so no output is ever NaN or Infinity. Money is computed in bigint paise (plan
 * invariant): rates become integer basis points first, so the revenue figure is exact.
 */

export type RoiInputs = {
  leadsPerMonth: number;
  replyRatePct: number;
  /** Percentage points added to the reply rate by faster, consistent follow-up (your assumption). */
  replyLiftPts: number;
  dealValueInr: number;
  closeRatePct: number;
  hoursSavedPerLead: number;
};

export type RoiKey = keyof RoiInputs;

export type RoiLimit = { min: number; max: number; step: number; integer: boolean };

export const ROI_LIMITS: Readonly<Record<RoiKey, RoiLimit>> = {
  leadsPerMonth: { min: 0, max: 100_000, step: 10, integer: true },
  replyRatePct: { min: 0, max: 100, step: 1, integer: false },
  replyLiftPts: { min: 0, max: 100, step: 1, integer: false },
  dealValueInr: { min: 0, max: 100_000_000, step: 500, integer: true },
  closeRatePct: { min: 0, max: 100, step: 1, integer: false },
  hoursSavedPerLead: { min: 0, max: 8, step: 0.05, integer: false },
};

/** Starting assumptions: deliberately modest, and all of them editable. */
export const ROI_DEFAULTS: Readonly<RoiInputs> = Object.freeze({
  leadsPerMonth: 200,
  replyRatePct: 18,
  replyLiftPts: 6,
  dealValueInr: 25_000,
  closeRatePct: 20,
  hoursSavedPerLead: 0.25,
});

export const ROI_KEYS: readonly RoiKey[] = ['leadsPerMonth', 'replyRatePct', 'replyLiftPts', 'dealValueInr', 'closeRatePct', 'hoursSavedPerLead'];

/** Two decimals at most for fractional inputs: keeps typed values like 0.25 exact enough to show. */
function roundTo(value: number, integer: boolean): number {
  return integer ? Math.round(value) : Math.round(value * 100) / 100;
}

/** Clamps one assumption into its range; NaN, Infinity and non-numbers become the range minimum. */
export function clampInput(key: RoiKey, value: unknown): number {
  const limit = ROI_LIMITS[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return limit.min;
  return roundTo(Math.min(limit.max, Math.max(limit.min, value)), limit.integer);
}

/**
 * Parses what a person typed. Accepts Indian digit grouping and a leading rupee sign
 * ("₹1,25,000"); an empty or unreadable field counts as the minimum (0), and a number too large
 * for a double ("1e400") as the maximum.
 */
export function parseInput(key: RoiKey, raw: string): number {
  const cleaned = raw.replace(/[₹,\s_]/g, '').replace(/%$/, '');
  if (cleaned === '' || !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(cleaned)) return ROI_LIMITS[key].min;
  const value = Number(cleaned);
  if (value === Number.POSITIVE_INFINITY) return ROI_LIMITS[key].max;
  return clampInput(key, value);
}

/** A complete, clamped set of inputs from any partial or untrusted object. */
export function sanitizeInputs(input: Partial<Record<RoiKey, unknown>>): RoiInputs {
  const out = { ...ROI_DEFAULTS };
  for (const key of ROI_KEYS) out[key] = key in input ? clampInput(key, input[key]) : ROI_DEFAULTS[key];
  return out;
}

/** A fresh copy of the defaults (the calculator's "Reset assumptions"). */
export function resetInputs(): RoiInputs {
  return { ...ROI_DEFAULTS };
}

export type RoiEstimate = {
  repliesNow: number;
  repliesWithLift: number;
  extraReplies: number;
  extraDeals: number;
  /** Extra deals x 10^8, exact: leads x lift x close rate in basis points has no more decimals. */
  extraDealsE8: bigint;
  /** Exact expected value in paise, rounded half up to a whole paisa. */
  extraRevenuePaise: bigint;
  hoursSaved: number;
  /** The lift actually applied (the reply rate never passes 100%). */
  appliedLiftPts: number;
};

const BP = 10_000n;
const toBasisPoints = (pct: number) => BigInt(Math.round(pct * 100));

/** Rounds a non-negative rational a / b half up to an integer. */
function divRound(a: bigint, b: bigint): bigint {
  return (2n * a + b) / (2n * b);
}

export function estimateRoi(input: Partial<Record<RoiKey, unknown>>): RoiEstimate {
  const i = sanitizeInputs(input);
  const appliedLiftPts = roundTo(Math.min(i.replyLiftPts, 100 - i.replyRatePct), false);
  const repliesNow = (i.leadsPerMonth * i.replyRatePct) / 100;
  const extraReplies = (i.leadsPerMonth * appliedLiftPts) / 100;
  const extraDeals = (extraReplies * i.closeRatePct) / 100;
  const leads = BigInt(i.leadsPerMonth);
  const dealPaise = BigInt(i.dealValueInr) * 100n;
  const extraDealsE8 = leads * toBasisPoints(appliedLiftPts) * toBasisPoints(i.closeRatePct);
  const extraRevenuePaise = divRound(extraDealsE8 * dealPaise, BP * BP);
  return {
    repliesNow,
    repliesWithLift: repliesNow + extraReplies,
    extraReplies,
    extraDeals,
    extraDealsE8,
    extraRevenuePaise,
    hoursSaved: i.leadsPerMonth * i.hoursSavedPerLead,
    appliedLiftPts,
  };
}

const WHOLE_RUPEES = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0, minimumFractionDigits: 0 });
const ONE_DECIMAL = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1, minimumFractionDigits: 0 });
const TWO_DECIMALS = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
const EIGHT_DECIMALS = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 8, minimumFractionDigits: 0 });

/** "₹60,000": whole rupees (half up) in Indian grouping, for an estimate where paise are noise. */
export function formatWholeRupees(paise: bigint): string {
  const rupees = divRound(paise < 0n ? -paise : paise, 100n);
  return WHOLE_RUPEES.format(`${paise < 0n ? '-' : ''}${rupees.toString()}` as Intl.StringNumericLiteral);
}

/** Counts and hours with at most one decimal ("2.4", "1,250"). */
export function formatAmount(value: number): string {
  return ONE_DECIMAL.format(Number.isFinite(value) ? value : 0);
}

/** An assumption at the precision it is used with (two decimals at most: "0.26", "1,00,000"). */
export function formatInput(value: number): string {
  return TWO_DECIMALS.format(Number.isFinite(value) ? value : 0);
}

/**
 * The exact extra-deal count from extraDealsE8 ("0.084", "2.4"): times the deal value it gives the
 * revenue figure, to the whole rupee, where formatAmount's one decimal would not ("0.1").
 */
export function formatDeals(dealsE8: bigint): string {
  const scale = BP * BP;
  const positive = dealsE8 < 0n ? -dealsE8 : dealsE8;
  const fraction = (positive % scale).toString().padStart(8, '0');
  return EIGHT_DECIMALS.format(`${dealsE8 < 0n ? '-' : ''}${(positive / scale).toString()}.${fraction}` as Intl.StringNumericLiteral);
}

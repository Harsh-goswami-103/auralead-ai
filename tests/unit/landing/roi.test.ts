/**
 * R30 (T30): the landing ROI calculator's math (src/lib/landing/roi.ts). It is an illustrative
 * estimate over visible, editable assumptions, so the rules are about robustness: every input is
 * clamped, nothing typed can produce NaN or Infinity, reset restores the defaults, and the revenue
 * figure is exact bigint paise.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ROI_DEFAULTS,
  ROI_KEYS,
  ROI_LIMITS,
  clampInput,
  estimateRoi,
  formatAmount,
  formatWholeRupees,
  parseInput,
  resetInputs,
  sanitizeInputs,
  type RoiInputs,
} from '@/lib/landing/roi';

describe('ROI defaults', () => {
  it('starts inside every range', () => {
    for (const key of ROI_KEYS) {
      expect(ROI_DEFAULTS[key]).toBeGreaterThanOrEqual(ROI_LIMITS[key].min);
      expect(ROI_DEFAULTS[key]).toBeLessThanOrEqual(ROI_LIMITS[key].max);
    }
  });

  it('works out the documented example from the defaults', () => {
    // 200 leads, 18% reply, +6 points, 20% close, Rs 25,000 deals, 15 minutes saved per lead.
    const e = estimateRoi(ROI_DEFAULTS);
    expect(e.repliesNow).toBe(36);
    expect(e.extraReplies).toBe(12);
    expect(e.repliesWithLift).toBe(48);
    expect(e.extraDeals).toBeCloseTo(2.4, 10);
    expect(e.extraRevenuePaise).toBe(6_000_000n);
    expect(formatWholeRupees(e.extraRevenuePaise)).toBe('₹60,000');
    expect(e.hoursSaved).toBe(50);
  });

  it('reset returns a fresh copy of the defaults', () => {
    const a = resetInputs();
    expect(a).toEqual(ROI_DEFAULTS);
    a.leadsPerMonth = 9;
    expect(resetInputs().leadsPerMonth).toBe(ROI_DEFAULTS.leadsPerMonth);
    expect(Object.isFrozen(ROI_DEFAULTS)).toBe(true);
  });
});

describe('clamping and parsing', () => {
  it('clamps each input to its range', () => {
    expect(clampInput('replyRatePct', 140)).toBe(100);
    expect(clampInput('closeRatePct', -5)).toBe(0);
    expect(clampInput('leadsPerMonth', 2_000_000)).toBe(100_000);
    expect(clampInput('dealValueInr', 1e12)).toBe(100_000_000);
    expect(clampInput('hoursSavedPerLead', 99)).toBe(8);
  });

  it('turns NaN, Infinity and non-numbers into the range minimum', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '12', null, undefined, {}]) {
      for (const key of ROI_KEYS) expect(clampInput(key, bad)).toBe(ROI_LIMITS[key].min);
    }
  });

  it('rounds counts and money to whole numbers and rates to two decimals', () => {
    expect(clampInput('leadsPerMonth', 12.6)).toBe(13);
    expect(clampInput('dealValueInr', 999.5)).toBe(1000);
    expect(clampInput('replyRatePct', 12.3456)).toBe(12.35);
  });

  it('parses typed text, including Indian grouping and a rupee sign', () => {
    expect(parseInput('dealValueInr', '₹1,25,000')).toBe(125_000);
    expect(parseInput('replyRatePct', ' 22% ')).toBe(22);
    expect(parseInput('hoursSavedPerLead', '.5')).toBe(0.5);
    expect(parseInput('leadsPerMonth', '')).toBe(0);
    expect(parseInput('leadsPerMonth', 'abc')).toBe(0);
    expect(parseInput('leadsPerMonth', '1e3')).toBe(1000);
    expect(parseInput('leadsPerMonth', '1e400')).toBe(100_000);
    expect(parseInput('closeRatePct', '-20')).toBe(0);
  });

  it('fills missing keys from the defaults and clamps the rest', () => {
    expect(sanitizeInputs({ leadsPerMonth: -1, replyRatePct: Number.NaN })).toEqual({ ...ROI_DEFAULTS, leadsPerMonth: 0, replyRatePct: 0 });
  });
});

describe('estimate', () => {
  it('never lifts the reply rate past 100%', () => {
    const e = estimateRoi({ ...ROI_DEFAULTS, replyRatePct: 97, replyLiftPts: 10 });
    expect(e.appliedLiftPts).toBe(3);
    expect(e.repliesWithLift).toBeLessThanOrEqual(ROI_DEFAULTS.leadsPerMonth);
  });

  it('is zero with no leads or no lift', () => {
    expect(estimateRoi({ ...ROI_DEFAULTS, leadsPerMonth: 0 }).extraRevenuePaise).toBe(0n);
    expect(estimateRoi({ ...ROI_DEFAULTS, replyLiftPts: 0 }).extraDeals).toBe(0);
  });

  it('gives finite, non-negative figures for any input at all', () => {
    const anyValue = fc.oneof(fc.double(), fc.integer(), fc.constant(Number.NaN), fc.string(), fc.constant(null));
    fc.assert(
      fc.property(fc.record(Object.fromEntries(ROI_KEYS.map((k) => [k, anyValue])) as Record<keyof RoiInputs, fc.Arbitrary<unknown>>), (input) => {
        const e = estimateRoi(input);
        for (const n of [e.repliesNow, e.repliesWithLift, e.extraReplies, e.extraDeals, e.hoursSaved, e.appliedLiftPts]) {
          expect(Number.isFinite(n)).toBe(true);
          expect(n).toBeGreaterThanOrEqual(0);
        }
        expect(e.extraRevenuePaise).toBeGreaterThanOrEqual(0n);
        expect(formatWholeRupees(e.extraRevenuePaise)).toMatch(/^₹[\d,]+$/);
      }),
    );
  });

  it('matches float arithmetic for in-range inputs (exact paise, rounded half up)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 500_000 }),
        (leads, reply, lift, close, deal) => {
          const e = estimateRoi({ leadsPerMonth: leads, replyRatePct: reply, replyLiftPts: lift, closeRatePct: close, dealValueInr: deal });
          const applied = Math.min(lift, 100 - reply);
          const expected = (leads * applied * close * deal * 100) / 10_000;
          expect(Math.abs(Number(e.extraRevenuePaise) - expected)).toBeLessThanOrEqual(0.5 + expected * 1e-12);
        },
      ),
    );
  });
});

describe('formatting', () => {
  it('formats whole rupees in Indian grouping and amounts with one decimal at most', () => {
    expect(formatWholeRupees(12_345_678_950n)).toBe('₹12,34,56,790');
    expect(formatWholeRupees(0n)).toBe('₹0');
    expect(formatAmount(2.4)).toBe('2.4');
    expect(formatAmount(1250)).toBe('1,250');
    expect(formatAmount(Number.NaN)).toBe('0');
  });
});

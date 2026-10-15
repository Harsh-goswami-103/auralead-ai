import { describe, expect, it } from 'vitest';
import { AmountInvalidError } from '@/lib/errors';
import { computeQuoteTotals, mulDivHalfUp } from '@/lib/money';

describe('mulDivHalfUp (plan §8, ADR-31): (a * bps + 5000) / 10000, floor', () => {
  it.each([
    [25n, 1800n, 5n], // 4.5 -> 5 (banker's rounding would give 4)
    [5n, 1000n, 1n], // 0.5 -> 1
    [75n, 1800n, 14n], // 13.5 -> 14
    [333n, 1800n, 60n], // 59.94 -> 60
    [1n, 4999n, 0n], // 0.4999 -> 0
    [1n, 5000n, 1n], // 0.5 -> 1
    [0n, 1800n, 0n],
    [2_000_000n, 1000n, 200_000n],
    [1_800_000n, 1800n, 324_000n],
  ])('mulDivHalfUp(%s, %s) = %s', (a, bps, expected) => {
    expect(mulDivHalfUp(a, bps)).toBe(expected);
  });

  it('accepts number bps', () => {
    expect(mulDivHalfUp(25n, 1800)).toBe(5n);
  });

  it('rejects negative amounts or bps and non-integer bps', () => {
    expect(() => mulDivHalfUp(-1n, 100n)).toThrow(AmountInvalidError);
    expect(() => mulDivHalfUp(1n, -1n)).toThrow(AmountInvalidError);
    expect(() => mulDivHalfUp(1n, 1.5)).toThrow(AmountInvalidError);
  });
});

describe('rounding inside the quote computation', () => {
  it('taxable 25 at 1800 bps gives tax 5', () => {
    const t = computeQuoteTotals({ lines: [{ qty: 1, unitPricePaise: 25n }], discount: { kind: 'NONE', value: 0n }, tax: { mode: 'CONFIGURED', bps: 1800 } });
    expect(t.taxPaise).toBe(5n);
    expect(t.totalPaise).toBe(30n);
  });

  it('subtotal 5 at 1000 bps discount gives discount 1', () => {
    const t = computeQuoteTotals({ lines: [{ qty: 1, unitPricePaise: 5n }], discount: { kind: 'PERCENT_BPS', value: 1000n }, tax: { mode: 'NONE' } });
    expect(t.discountPaise).toBe(1n);
    expect(t.totalPaise).toBe(4n);
  });

  it('75 at 1800 gives 14 and 333 at 1800 gives 60', () => {
    const tax = (p: bigint) =>
      computeQuoteTotals({ lines: [{ qty: 1, unitPricePaise: p }], discount: { kind: 'NONE', value: 0n }, tax: { mode: 'CONFIGURED', bps: 1800 } }).taxPaise;
    expect(tax(75n)).toBe(14n);
    expect(tax(333n)).toBe(60n);
  });

  it('qty 9,999 x 99,999,999 is exact (no float drift)', () => {
    const t = computeQuoteTotals({ lines: [{ qty: 9_999, unitPricePaise: 99_999_999n }], discount: { kind: 'NONE', value: 0n }, tax: { mode: 'NONE' } });
    expect(t.lines[0]!.lineTotalPaise).toBe(999_899_990_001n);
    expect(t.subtotalPaise).toBe(999_899_990_001n);
  });

  it('each derived amount is rounded once: discount then tax on the rounded taxable', () => {
    // subtotal 15; 10% discount = 1.5 -> 2; taxable 13; 18% tax = 2.34 -> 2; total 15.
    const t = computeQuoteTotals({ lines: [{ qty: 3, unitPricePaise: 5n }], discount: { kind: 'PERCENT_BPS', value: 1000n }, tax: { mode: 'CONFIGURED', bps: 1800 } });
    expect(t).toMatchObject({ subtotalPaise: 15n, discountPaise: 2n, taxablePaise: 13n, taxPaise: 2n, totalPaise: 15n });
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AmountInvalidError, DiscountInvalidError } from '@/lib/errors';
import {
  QUOTE_TOTAL_SANITY_CAP_PAISE,
  computeQuoteTotals,
  exceedsSanityCap,
  formatINR,
  parsePaise,
  parseRupeesToPaise,
  paiseToRupeeString,
  serializePaise,
} from '@/lib/money';

describe('AT5 fixture (plan §8): every intermediate asserted', () => {
  const totals = computeQuoteTotals({
    lines: [{ qty: 2, unitPricePaise: 1_000_000n }],
    discount: { kind: 'PERCENT_BPS', value: 1000n },
    tax: { mode: 'CONFIGURED', bps: 1800 },
  });

  it('line total 2 x 1,000,000 = 2,000,000', () => {
    expect(totals.lines).toEqual([{ qty: 2, unitPricePaise: 1_000_000n, lineTotalPaise: 2_000_000n }]);
  });
  it('subtotal 2,000,000', () => expect(totals.subtotalPaise).toBe(2_000_000n));
  it('discount 10% = 200,000', () => expect(totals.discountPaise).toBe(200_000n));
  it('taxable 1,800,000', () => expect(totals.taxablePaise).toBe(1_800_000n));
  it('tax 18% = 324,000', () => expect(totals.taxPaise).toBe(324_000n));
  it('total 2,124,000 formats as ₹21,240.00', () => {
    expect(totals.totalPaise).toBe(2_124_000n);
    expect(formatINR(totals.totalPaise)).toBe('₹21,240.00');
  });
});

describe('discount kinds and tax modes', () => {
  it('NONE discount and NONE tax give total = subtotal', () => {
    const t = computeQuoteTotals({
      lines: [
        { qty: 3, unitPricePaise: 1_999n },
        { qty: 1, unitPricePaise: 50_000n },
      ],
      discount: { kind: 'NONE', value: 0n },
      tax: { mode: 'NONE' },
    });
    expect(t.subtotalPaise).toBe(55_997n);
    expect(t.discountPaise).toBe(0n);
    expect(t.taxPaise).toBe(0n);
    expect(t.totalPaise).toBe(55_997n);
  });

  it('FLAT_PAISE discount subtracts exactly and tax applies to the discounted subtotal', () => {
    const t = computeQuoteTotals({
      lines: [{ qty: 1, unitPricePaise: 100_000n }],
      discount: { kind: 'FLAT_PAISE', value: 10_000n },
      tax: { mode: 'CONFIGURED', bps: 1800 },
    });
    expect(t.discountPaise).toBe(10_000n);
    expect(t.taxablePaise).toBe(90_000n);
    expect(t.taxPaise).toBe(16_200n);
    expect(t.totalPaise).toBe(106_200n);
  });

  it('flat discount equal to the subtotal is allowed (total 0)', () => {
    const t = computeQuoteTotals({
      lines: [{ qty: 1, unitPricePaise: 500n }],
      discount: { kind: 'FLAT_PAISE', value: 500n },
      tax: { mode: 'CONFIGURED', bps: 1800 },
    });
    expect(t.totalPaise).toBe(0n);
  });

  it('an empty quote totals zero', () => {
    const t = computeQuoteTotals({ lines: [], discount: { kind: 'NONE', value: 0n }, tax: { mode: 'NONE' } });
    expect(t).toMatchObject({ subtotalPaise: 0n, discountPaise: 0n, taxablePaise: 0n, taxPaise: 0n, totalPaise: 0n });
  });
});

describe('input validation (422)', () => {
  const line = { qty: 1, unitPricePaise: 1000n };
  const noTax = { mode: 'NONE' as const };

  it.each([
    ['negative percent', { kind: 'PERCENT_BPS' as const, value: -1n }],
    ['percent above 10000 bps', { kind: 'PERCENT_BPS' as const, value: 10_001n }],
    ['negative flat', { kind: 'FLAT_PAISE' as const, value: -1n }],
    ['flat above subtotal', { kind: 'FLAT_PAISE' as const, value: 1001n }],
    ['NONE with a value', { kind: 'NONE' as const, value: 5n }],
  ])('rejects %s', (_l, discount) => {
    expect(() => computeQuoteTotals({ lines: [line], discount, tax: noTax })).toThrow(DiscountInvalidError);
  });

  it.each([
    ['zero qty', { qty: 0, unitPricePaise: 1n }],
    ['fractional qty', { qty: 1.5, unitPricePaise: 1n }],
    ['negative price', { qty: 1, unitPricePaise: -1n }],
  ])('rejects %s', (_l, bad) => {
    expect(() => computeQuoteTotals({ lines: [bad], discount: { kind: 'NONE', value: 0n }, tax: noTax })).toThrow(AmountInvalidError);
  });

  it.each([-1, 10_001, 18.5])('rejects tax bps %s', (bps) => {
    expect(() => computeQuoteTotals({ lines: [line], discount: { kind: 'NONE', value: 0n }, tax: { mode: 'CONFIGURED', bps } })).toThrow(
      AmountInvalidError,
    );
  });

  it('100% discount is the limit and allowed', () => {
    const t = computeQuoteTotals({ lines: [line], discount: { kind: 'PERCENT_BPS', value: 10_000n }, tax: { mode: 'CONFIGURED', bps: 1800 } });
    expect(t.totalPaise).toBe(0n);
  });
});

describe('sanity cap (ADR-07)', () => {
  it('is ₹100 crore = 10^11 paise; above it routes to review', () => {
    expect(QUOTE_TOTAL_SANITY_CAP_PAISE).toBe(10n ** 11n);
    expect(exceedsSanityCap(10n ** 11n)).toBe(false);
    expect(exceedsSanityCap(10n ** 11n + 1n)).toBe(true);
    expect(exceedsSanityCap(5_000n, 4_999n)).toBe(true);
  });
});

describe('DTO serialization (decimal strings)', () => {
  it('round-trips paise as integer strings', () => {
    expect(serializePaise(2_124_000n)).toBe('2124000');
    expect(parsePaise('2124000')).toBe(2_124_000n);
    expect(parsePaise('99999999999999999999')).toBe(99_999_999_999_999_999_999n);
    for (const bad of ['', '1.5', '1e5', ' 12', '0x10', '+5', '--1']) expect(() => parsePaise(bad)).toThrow(AmountInvalidError);
  });

  it('converts paise to rupee strings and back', () => {
    expect(paiseToRupeeString(2_124_000n)).toBe('21240.00');
    expect(paiseToRupeeString(5n)).toBe('0.05');
    expect(paiseToRupeeString(-105n)).toBe('-1.05');
    expect(parseRupeesToPaise('21240')).toBe(2_124_000n);
    expect(parseRupeesToPaise('21,240.5')).toBe(2_124_050n);
    expect(parseRupeesToPaise('0.05')).toBe(5n);
    for (const bad of ['1.234', 'abc', '', '1,2,3.4.5', '₹10']) expect(() => parseRupeesToPaise(bad)).toThrow(AmountInvalidError);
  });
});

describe('property (fast-check, fixed seed, 500 runs)', () => {
  const lineArb = fc.record({
    qty: fc.integer({ min: 1, max: 10_000 }),
    unitPricePaise: fc.bigInt({ min: 0n, max: 100_000_000_000n }),
  });
  const inputArb = fc
    .record({
      lines: fc.array(lineArb, { minLength: 0, maxLength: 12 }),
      discountKind: fc.constantFrom('NONE', 'PERCENT_BPS', 'FLAT_PAISE'),
      bps: fc.bigInt({ min: 0n, max: 10_000n }),
      flatFraction: fc.double({ min: 0, max: 1, noNaN: true }),
      taxMode: fc.constantFrom('NONE', 'CONFIGURED'),
      taxBps: fc.integer({ min: 0, max: 10_000 }),
    })
    .map((r) => {
      const subtotal = r.lines.reduce((s, l) => s + BigInt(l.qty) * l.unitPricePaise, 0n);
      const flat = (subtotal * BigInt(Math.floor(r.flatFraction * 1000))) / 1000n;
      const discount =
        r.discountKind === 'NONE'
          ? { kind: 'NONE' as const, value: 0n }
          : r.discountKind === 'PERCENT_BPS'
            ? { kind: 'PERCENT_BPS' as const, value: r.bps }
            : { kind: 'FLAT_PAISE' as const, value: flat };
      const tax = r.taxMode === 'NONE' ? { mode: 'NONE' as const } : { mode: 'CONFIGURED' as const, bps: r.taxBps };
      return { lines: r.lines, discount, tax };
    });

  it('total == subtotal - discount + tax, all non-negative integers, line order independent', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const t = computeQuoteTotals(input);
        expect(t.totalPaise).toBe(t.subtotalPaise - t.discountPaise + t.taxPaise);
        expect(t.taxablePaise).toBe(t.subtotalPaise - t.discountPaise);
        for (const v of [t.subtotalPaise, t.discountPaise, t.taxablePaise, t.taxPaise, t.totalPaise]) {
          expect(typeof v).toBe('bigint');
          expect(v >= 0n).toBe(true);
        }
        const reversed = computeQuoteTotals({ ...input, lines: [...input.lines].reverse() });
        expect(reversed.totalPaise).toBe(t.totalPaise);
        expect(reversed.subtotalPaise).toBe(t.subtotalPaise);
      }),
      { seed: 20261015, numRuns: 500 },
    );
  });
});

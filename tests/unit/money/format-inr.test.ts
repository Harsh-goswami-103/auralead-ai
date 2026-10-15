import { describe, expect, it } from 'vitest';
import { formatINR } from '@/lib/format/inr';
import { formatINR as formatFromMoney } from '@/lib/money';

describe('formatINR (en-IN, Indian grouping)', () => {
  it.each([
    [2_124_000n, '₹21,240.00'],
    [12_345_600n, '₹1,23,456.00'],
    [0n, '₹0.00'],
    [5n, '₹0.05'],
    [99n, '₹0.99'],
    [100n, '₹1.00'],
    [10n ** 11n, '₹1,00,00,00,000.00'],
    [999_889_990_001n, '₹9,99,88,99,900.01'],
    [-105n, '-₹1.05'],
  ])('%s paise -> %s', (paise, expected) => {
    expect(formatINR(paise)).toBe(expected);
  });

  it('is exact beyond the float-safe range', () => {
    expect(formatINR(9_007_199_254_740_993_01n)).toBe('₹9,00,71,99,25,47,40,993.01');
  });

  it('uses the rupee sign U+20B9', () => {
    expect(formatINR(100n).codePointAt(0)).toBe(0x20b9);
  });

  it('is host time zone independent (suite runs with TZ=America/New_York)', () => {
    expect(process.env.TZ).toBe('America/New_York');
    const original = process.env.TZ;
    try {
      for (const tz of ['UTC', 'Asia/Kolkata', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
        process.env.TZ = tz;
        expect(formatINR(2_124_000n)).toBe('₹21,240.00');
      }
    } finally {
      process.env.TZ = original;
    }
  });

  it('is re-exported from lib/money', () => {
    expect(formatFromMoney).toBe(formatINR);
  });

  it('rejects non-bigint input at runtime', () => {
    expect(() => formatINR(21240 as unknown as bigint)).toThrow(TypeError);
  });
});

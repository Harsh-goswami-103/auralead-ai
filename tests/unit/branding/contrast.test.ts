/**
 * F14 / T27: a workspace brand colour used as text is darkened in OKLCH until it reads at 4.5:1 or
 * more on white. Only lightness moves (hue kept), as little as needed; a colour that already passes
 * is unchanged; the guarantee holds on the rounded #RRGGBB for every possible input (property test,
 * fixed seed). The public quote palette's text colour uses the same function (at its stricter 4.6:1
 * on the wash tint), so the quote page and the branding preview agree.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { brandPalette } from '@/components/quote/brand-palette';
import { brandTextColor, contrastRatio, isBrandHex, oklchToHex, toOklch } from '@/lib/branding/contrast';

const WHITE = '#FFFFFF';
const hueDelta = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

describe('contrast maths', () => {
  it('matches the WCAG reference points', () => {
    expect(contrastRatio('#000000', WHITE)).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', WHITE)).toBeCloseTo(4.48, 2);
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 5);
  });

  it('round-trips sRGB through OKLCH', () => {
    for (const hex of ['#FFD400', '#0F766E', '#E11D48', '#2563EB', '#808080', '#000000', '#FFFFFF']) {
      expect(oklchToHex(toOklch(hex))).toBe(hex);
    }
  });
});

describe('brandTextColor (F14)', () => {
  it('darkens a light brand colour to at least 4.5:1 on white, keeping its hue', () => {
    const yellow = brandTextColor('#FFD400');
    expect(yellow.adjusted).toBe(true);
    expect(contrastRatio(yellow.color, WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(yellow.ratio).toBeGreaterThanOrEqual(4.5);
    const before = toOklch('#FFD400');
    const after = toOklch(yellow.color);
    expect(after.l).toBeLessThan(before.l);
    expect(hueDelta(after.h, before.h)).toBeLessThan(4);
    expect(yellow.color).toMatch(/^#[0-9A-F]{6}$/);
  });

  it('darkens only as much as needed (a slightly lighter colour fails)', () => {
    for (const brand of ['#FFD400', '#38BDF8', '#F472B6', '#22C55E', '#FB923C']) {
      const out = brandTextColor(brand);
      const o = toOklch(out.color);
      const lighter = oklchToHex({ ...o, l: o.l + 0.02 });
      expect(contrastRatio(lighter, WHITE), `${brand} -> ${out.color}`).toBeLessThan(4.5);
    }
  });

  it('returns a colour that already passes unchanged', () => {
    expect(contrastRatio('#0F766E', WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(brandTextColor('#0f766e')).toEqual({ color: '#0F766E', ratio: Math.floor(contrastRatio('#0F766E', WHITE) * 100) / 100, adjusted: false });
    expect(brandTextColor('#111318').adjusted).toBe(false);
  });

  it('reaches 4.5:1 for every #rrggbb (property test, fixed seed)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffff }), (n) => {
        const hex = `#${n.toString(16).padStart(6, '0').toUpperCase()}`;
        const out = brandTextColor(hex);
        return isBrandHex(out.color) && contrastRatio(out.color, WHITE) >= 4.5;
      }),
      { seed: 20261020, numRuns: 1000 },
    );
  });

  it('honours another background and target', () => {
    const out = brandTextColor('#FACC15', { against: '#F7F8FA', min: 7 });
    expect(contrastRatio(out.color, '#F7F8FA')).toBeGreaterThanOrEqual(7);
  });

  it('refuses anything but #rrggbb', () => {
    expect(isBrandHex('#fff')).toBe(false);
    expect(isBrandHex('red')).toBe(false);
    expect(() => brandTextColor('red')).toThrow(RangeError);
  });

  it('is the text colour of the public quote palette', () => {
    for (const brand of ['#FFD400', '#0E7490', '#F472B6']) {
      const p = brandPalette(brand);
      expect(p.text).toBe(brandTextColor(brand, { against: p.wash, min: 4.6 }).color);
      expect(contrastRatio(p.text, WHITE)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

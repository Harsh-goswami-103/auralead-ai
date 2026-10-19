/**
 * WCAG 2 contrast proofs for the "Aurora" palette (design spec §0.5 and §1; the matrix in the
 * color report). Every value is read from src/styles/tokens.css, so a token edit that breaks a
 * pairing fails here. The math is a port of the palette lab's colorlib (sRGB linearisation,
 * relative luminance, and alpha compositing in gamma-encoded sRGB, as browsers do).
 */
import { describe, expect, it } from 'vitest';
import { hexToken, resolveToken } from './token-source';

type Rgb = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function hexRgb(hex: string): Rgb {
  return [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255) as Rgb;
}

function rgbHex(rgb: Rgb): string {
  return `#${rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(hex: string): number {
  const [r, g, b] = hexRgb(hex).map(toLinear) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `fg` at `alpha` painted over the opaque `bg`. */
function over(fg: string, alpha: number, bg: string): string {
  const f = hexRgb(fg);
  const b = hexRgb(bg);
  return rgbHex(f.map((c, i) => alpha * c + (1 - alpha) * b[i]!) as Rgb);
}

const SURFACES = ['bg-0', 'bg-1', 'bg-2', 'bg-3'] as const;
const TEXT = 4.5;
const NON_TEXT = 3;

function expectPair(fg: string, bg: string, min: number, label: string) {
  const ratio = contrast(fg, bg);
  expect(ratio, `${label}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(min);
}

describe('contrast math (port check)', () => {
  it('matches the WCAG reference points', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(over('#ffffff', 0.5, '#000000')).toBe('#808080');
  });
});

describe('Aurora palette contrast (WCAG 2 AA)', () => {
  it('text-1, text-2 and text-3 read on every surface', () => {
    for (const text of ['text-1', 'text-2', 'text-3']) {
      for (const bg of SURFACES) expectPair(hexToken(text), hexToken(bg), TEXT, `${text} on ${bg}`);
    }
  });

  it('aura, zest and flare work as text on bg-0..bg-2', () => {
    for (const hue of ['aura', 'zest', 'flare']) {
      for (const bg of SURFACES.slice(0, 3)) expectPair(hexToken(hue), hexToken(bg), TEXT, `${hue} on ${bg}`);
    }
  });

  it('ink (accent-fg) reads on every bright fill a button uses', () => {
    for (const fill of ['aura', 'azure', 'zest', 'danger']) {
      expectPair(hexToken('accent-fg'), hexToken(fill), TEXT, `accent-fg on ${fill}`);
    }
  });

  it('the solid input border and the aura focus outline are visible (non-text 3:1)', () => {
    for (const bg of SURFACES.slice(0, 3)) expectPair(hexToken('border-input'), hexToken(bg), NON_TEXT, `border-input vs ${bg}`);
    for (const bg of SURFACES) expectPair(hexToken('accent'), hexToken(bg), NON_TEXT, `focus outline on ${bg}`);
  });

  it('status badges: tone text on the tone at 12% over bg-1 and bg-2', () => {
    for (const tone of ['success', 'warning', 'danger', 'info', 'demo']) {
      for (const bg of ['bg-1', 'bg-2']) {
        expectPair(hexToken(tone), over(hexToken(tone), 0.12, hexToken(bg)), TEXT, `${tone} badge over ${bg}`);
      }
    }
  });

  it('text over an aurora blob at the --aurora-alpha-text cap still passes, for every panel hue', () => {
    const cap = Number.parseFloat(resolveToken('aurora-alpha-text')) / 100;
    expect(cap).toBeGreaterThan(0);
    for (const hue of ['aura', 'zest', 'flare', 'volt-hi']) {
      const blob = over(hexToken(hue), cap, hexToken('bg-0'));
      for (const text of ['text-1', 'text-2', 'text-3']) expectPair(hexToken(text), blob, TEXT, `${text} on ${hue} blob`);
    }
  });

  it('text-1 and text-2 read on glass even over white content', () => {
    const glass = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(resolveToken('glass-bg'));
    expect(glass, 'glass-bg is rgb(r g b / a)').not.toBeNull();
    const [r, g, b, alpha] = glass!.slice(1).map(Number) as [number, number, number, number];
    expect(alpha).toBeGreaterThanOrEqual(0.78);
    const surface = over(rgbHex([r / 255, g / 255, b / 255]), alpha, '#ffffff');
    for (const text of ['text-1', 'text-2']) expectPair(hexToken(text), surface, TEXT, `${text} on glass`);
  });
});

/**
 * The workspace brand colour as a paper palette for the public quote page (design spec §6
 * "Public quote": brand colour accents on a light, printable page).
 *
 * A workspace may pick any #rrggbb, so nothing here trusts the colour to be readable. Every value
 * is derived so the text that sits on it, or that uses it, meets WCAG AA:
 *  - `band` is the header band fill and `ink` the text on it, at least 4.5:1. White ink is the
 *    default; dark ink is used for light brands; a mid-tone brand that suits neither is darkened
 *    under white ink. `band2`, the gradient end, moves away from the ink, so contrast only rises.
 *  - `text` is the brand used as text, links, borders and the focus outline on white or on the
 *    `wash` tint, at least 4.6:1: the brand darkened in OKLCH, hue kept (F14, T27,
 *    `brandTextColor` in src/lib/branding/contrast.ts, which the branding page preview uses too).
 *  - `wash`, `soft` and `haze` are tints for surfaces and rules (non-text decoration).
 *  - `chip` and `line` are translucent overlays for chips and hairlines inside the band. They move
 *    the band away from the ink, so a chip's text keeps its contrast.
 * Pure and deterministic: hex in, hex out. The values reach the page only as a hashed style
 * block (see `quoteBrandCss`), never as an inline style attribute.
 */

import { brandTextColor } from '@/lib/branding/contrast';

type Rgb = readonly [number, number, number];

const HEX = /^#[0-9a-fA-F]{6}$/;
const WHITE = '#FFFFFF';
const BLACK = '#000000';
/** The paper ink (`--ink-1`), the dark text colour. */
export const PAPER_INK = '#111318';
/** The page canvas behind the paper (`--canvas`). */
export const PAPER_CANVAS = '#F2F4F7';
/** The colour used when a workspace has no valid brand colour, and on pages with no workspace. */
export const NEUTRAL_BRAND = '#0B7285';

export type BrandPalette = {
  brand: string;
  band: string;
  band2: string;
  ink: string;
  text: string;
  wash: string;
  soft: string;
  haze: string;
  chip: string;
  line: string;
};

function parse(hex: string): Rgb {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const [r, g, b] = parse(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio between two #rrggbb colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Mixes `b` into `a` by `t` (0 = a, 1 = b), per sRGB channel. */
export function mix(a: string, b: string, t: number): string {
  const x = parse(a);
  const y = parse(b);
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** The least mix of `base` towards `target` that reaches `ratio` against `against`. */
function untilContrast(base: string, target: string, ratio: number, against: string): string {
  for (let step = 0; step <= 50; step++) {
    const candidate = mix(base, target, step / 50);
    if (contrast(candidate, against) >= ratio) return candidate;
  }
  return target;
}

export function brandPalette(input: string): BrandPalette {
  const brand = HEX.test(input) ? input.toUpperCase() : NEUTRAL_BRAND;
  let ink = WHITE;
  let band = brand;
  if (contrast(WHITE, brand) < 4.5) {
    if (contrast(PAPER_INK, brand) >= 4.5) ink = PAPER_INK;
    else band = untilContrast(brand, BLACK, 4.5, WHITE);
  }
  const darkInk = ink === PAPER_INK;
  const wash = mix(brand, WHITE, 0.93);
  return {
    brand,
    band,
    band2: darkInk ? mix(band, WHITE, 0.35) : mix(band, BLACK, 0.32),
    ink,
    text: brandTextColor(brand, { against: wash, min: 4.6 }).color,
    wash,
    soft: mix(brand, WHITE, 0.8),
    haze: mix(brand, PAPER_CANVAS, 0.8),
    chip: darkInk ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.2)',
    line: darkInk ? 'rgba(17,19,24,.22)' : 'rgba(255,255,255,.3)',
  };
}

/** The palette as CSS custom properties (declarations only, no selector). */
export function brandDeclarations(p: BrandPalette): string {
  return [
    `--brand:${p.brand}`,
    `--brand-band:${p.band}`,
    `--brand-band-2:${p.band2}`,
    `--brand-ink:${p.ink}`,
    `--brand-text:${p.text}`,
    `--brand-wash:${p.wash}`,
    `--brand-soft:${p.soft}`,
    `--brand-haze:${p.haze}`,
    `--brand-chip:${p.chip}`,
    `--brand-line:${p.line}`,
  ].join(';');
}

/** Two-letter monogram for the band (decorative, aria-hidden): the first letters of the first two words. */
export function senderInitials(name: string): string {
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter((w) => w.length > 0);
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0] ?? '');
  return letters.join('').toLocaleUpperCase('en-IN') || '·';
}

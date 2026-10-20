/**
 * Brand colour as text (F14, plan §10 "--brand: workspace color darkened in OKLCH until 4.5:1 on
 * white for text"; T27).
 *
 * A workspace may pick any #rrggbb as its brand colour. Where the colour is used for text (quote
 * headings, links, rules next to text), `brandTextColor` keeps its hue and lowers only its OKLCH
 * lightness, as little as needed, until it reaches the required WCAG 2 contrast against the
 * background (4.5:1 on white by default). Chroma is reduced only when the darker colour falls
 * outside the sRGB gamut at that hue, so the result is always a real #RRGGBB. A colour that
 * already passes is returned unchanged. The ratio is checked on the rounded hex, never on the
 * unrounded maths, so the guarantee holds for the value that is actually painted.
 *
 * Pure and framework-free: shared by the branding service, the branding page preview and the
 * public quote palette.
 */

export type Rgb = readonly [number, number, number];
export type Oklch = { l: number; c: number; h: number };

export const BRAND_HEX = /^#[0-9a-fA-F]{6}$/;
export const WCAG_AA_TEXT = 4.5;

export function isBrandHex(value: string): boolean {
  return BRAND_HEX.test(value);
}

function parse(hex: string): Rgb {
  if (!BRAND_HEX.test(hex)) throw new RangeError(`not a #rrggbb colour: ${hex}`);
  return [Number.parseInt(hex.slice(1, 3), 16) / 255, Number.parseInt(hex.slice(3, 5), 16) / 255, Number.parseInt(hex.slice(5, 7), 16) / 255];
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** WCAG 2 relative luminance of a #rrggbb colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parse(hex).map(toLinear) as unknown as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two #rrggbb colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** sRGB hex to OKLCH (Björn Ottosson's OKLab, hue in degrees 0..360). */
export function toOklch(hex: string): Oklch {
  const [r, g, b] = parse(hex).map(toLinear) as unknown as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

/** OKLCH to gamma-encoded sRGB channels, unclamped (a value outside 0..1 is out of gamut). */
function oklchToRgb({ l: L, c, h }: Oklch): Rgb {
  const rad = (h * Math.PI) / 180;
  const A = c * Math.cos(rad);
  const B = c * Math.sin(rad);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

const EPS = 1e-6;
const inGamut = (rgb: Rgb) => rgb.every((v) => Number.isFinite(v) && v >= -EPS && v <= 1 + EPS);

/** The OKLCH colour as #RRGGBB; chroma is lowered (hue and lightness kept) until it fits sRGB. */
export function oklchToHex(color: Oklch): string {
  const l = Math.min(1, Math.max(0, color.l));
  if (inGamut(oklchToRgb({ l, c: color.c, h: color.h }))) return toHex(oklchToRgb({ l, c: color.c, h: color.h }));
  let lo = 0;
  let hi = color.c;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklchToRgb({ l, c: mid, h: color.h }))) lo = mid;
    else hi = mid;
  }
  return toHex(oklchToRgb({ l, c: lo, h: color.h }));
}

export type BrandTextColor = {
  /** The colour to paint text with. */
  color: string;
  /** Its contrast against the background (two decimals, rounded down). */
  ratio: number;
  /** False when the brand colour already had the contrast and is returned as is. */
  adjusted: boolean;
};

const floor2 = (n: number) => Math.floor(n * 100) / 100;

/**
 * The brand colour darkened in OKLCH (hue kept, lightness lowered as little as needed) until it
 * reaches `min` contrast against `against` (default 4.5:1 on white). Throws on anything but
 * #rrggbb; callers validate first.
 */
export function brandTextColor(brand: string, opts: { against?: string; min?: number } = {}): BrandTextColor {
  const against = opts.against ?? '#FFFFFF';
  const min = opts.min ?? WCAG_AA_TEXT;
  const original = brand.toUpperCase();
  const base = contrastRatio(original, against);
  if (base >= min) return { color: original, ratio: floor2(base), adjusted: false };

  const start = toOklch(original);
  const passes = (l: number) => contrastRatio(oklchToHex({ ...start, l }), against) >= min;
  // Lightness lo always passes (black-ish), hi never does; find the lightest passing value.
  let lo = 0;
  let hi = start.l;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (passes(mid)) lo = mid;
    else hi = mid;
  }
  let l = lo;
  // The hex rounding can land a hair under the line: step down until the painted value passes.
  while (!passes(l) && l > 0) l = Math.max(0, l - 0.002);
  const color = oklchToHex({ ...start, l });
  return { color, ratio: floor2(contrastRatio(color, against)), adjusted: true };
}

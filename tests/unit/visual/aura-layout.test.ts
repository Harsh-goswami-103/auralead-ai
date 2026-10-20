/**
 * The aura scene's shared layout (src/components/visual/aura/aura-layout.ts): its colors must stay
 * the Aurora tokens (src/styles/tokens.css) and keep clear of the reserved AI violet, its particle
 * budget must hold, and the poster projection must scale like the scene's fit so the crossfade from
 * poster to canvas does not jump.
 */
import { describe, expect, it } from 'vitest';
import {
  AURA_COLORS,
  AURA_PRESETS,
  AURA_STREAMS,
  TIER_BUDGET,
  fitScale,
  heroAnchors,
  heroAspect,
  posterViewBox,
  projectRest,
  restHalfHeight,
  rotateXYZ,
} from '@/components/visual/aura/aura-layout';
import { hexToken } from '../design/token-source';

/* sRGB hex -> OKLCH (Björn Ottosson's OKLab), enough to read lightness, chroma and hue. */
function oklch(hex: string): { l: number; c: number; h: number } {
  const lin = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const [r, g, b] = lin;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

describe('aura palette', () => {
  it('uses the Aurora token values', () => {
    expect(AURA_COLORS.bg).toBe(hexToken('bg-0'));
    expect(AURA_COLORS.aura).toBe(hexToken('aura'));
    expect(AURA_COLORS.ice).toBe(hexToken('ice'));
    expect(AURA_COLORS.volt).toBe(hexToken('volt'));
    expect(AURA_COLORS.voltHi).toBe(hexToken('volt-hi'));
    expect(AURA_COLORS.flare).toBe(hexToken('flare'));
    expect(AURA_COLORS.flareIce).toBe(hexToken('flare-ice'));
    expect(AURA_COLORS.zest).toBe(hexToken('zest'));
    expect(AURA_COLORS.maps).toBe(hexToken('chart-1-hi'));
  });

  it('keeps every chromatic color at least 25 degrees of hue away from the AI violet', () => {
    const ai = oklch(hexToken('ai')).h;
    for (const [name, hex] of Object.entries(AURA_COLORS)) {
      const { c, h } = oklch(hex);
      if (c < 0.06) continue;
      const distance = Math.min(Math.abs(h - ai), 360 - Math.abs(h - ai));
      expect(distance, `${name} ${hex}`).toBeGreaterThan(25);
    }
  });

  it('never uses a status hue', () => {
    const status = ['success', 'warning', 'danger', 'info', 'demo', 'ai'].map(hexToken);
    for (const hex of Object.values(AURA_COLORS)) expect(status).not.toContain(hex);
  });

  it('puts the blue stream (Meta) and the pink stream (WhatsApp) on opposite sides', () => {
    const meta = AURA_STREAMS.find((s) => s.key === 'meta')!;
    const whatsapp = AURA_STREAMS.find((s) => s.key === 'whatsapp')!;
    expect(meta.color).toBe(AURA_COLORS.voltHi);
    expect(whatsapp.color).toBe(AURA_COLORS.flare);
    expect(meta.from[0]).toBeLessThan(0);
    expect(whatsapp.to[0]).toBeGreaterThan(0);
  });
});

describe('aura budget', () => {
  const particles = (tier: keyof typeof TIER_BUDGET) => {
    const b = TIER_BUDGET[tier];
    return b.dust + 3 * b.ring + AURA_STREAMS.length * b.packetsPerStream + b.sparkles;
  };

  it('stays within 6000 particles on high and 2000 on low', () => {
    expect(particles('high')).toBeLessThanOrEqual(6000);
    expect(particles('low')).toBeLessThanOrEqual(2000);
  });

  it('runs the tile at the low tier, capped at 24 fps', () => {
    expect(AURA_PRESETS.tile.maxTier).toBe('low');
    expect(AURA_PRESETS.tile.fpsCap).toBe(24);
  });
});

describe('aura projection', () => {
  it('rotates like three Euler XYZ (Rx * Ry * Rz)', () => {
    const [x, y, z] = rotateXYZ([1, 0, 0], [0, 0, Math.PI / 2]);
    expect([x, y, z].map((n) => Number(n.toFixed(6)) + 0)).toEqual([0, 1, 0]);
    const [x2, y2, z2] = rotateXYZ([0, 1, 0], [Math.PI / 2, 0, 0]);
    expect([x2, y2, z2].map((n) => Number(n.toFixed(6)) + 0)).toEqual([0, 0, 1]);
  });

  it('fits the hero frame on narrow boxes and leaves wide boxes at scale 1', () => {
    expect(fitScale('hero', 2)).toBe(1);
    expect(fitScale('hero', heroAspect())).toBeCloseTo(1, 6);
    expect(fitScale('hero', 1)).toBeCloseTo(1 / heroAspect(), 6);
  });

  it('gives the poster a viewBox of the frame width by the visible height, like the scene fit', () => {
    for (const preset of ['hero', 'auth', 'tile'] as const) {
      const [x, y, w, h] = posterViewBox(preset);
      expect(w).toBeCloseTo(AURA_PRESETS[preset].frameWidth, 6);
      expect(h).toBeCloseTo(2 * restHalfHeight(preset), 6);
      expect([x, y]).toEqual([-w / 2, -h / 2]);
    }
  });

  it('projects the auth core off-centre right and every hero anchor inside the frame', () => {
    const [cx, cy] = projectRest('auth', [0, 0, 0], true);
    expect(cx).toBeCloseTo(1.6, 6);
    expect(cy).toBeCloseTo(0.3, 6);
    for (const a of heroAnchors()) {
      expect(a.left).toBeGreaterThan(0);
      expect(a.left).toBeLessThan(100);
      expect(a.top).toBeGreaterThan(0);
      expect(a.top).toBeLessThan(100);
      expect(a.direction === 'in' ? a.left < 50 : a.left > 50).toBe(true);
    }
  });
});

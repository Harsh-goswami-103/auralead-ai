/**
 * decideBudget (src/components/visual/aura/visual-budget.ts): the pure rule that gates the WebGL
 * scene (plan §10, design spec §0.7). 'off' means poster only and no three chunk; software GL caps
 * at 'low'; 'high' needs a wide, strong, fine-pointer desktop. Each placement passes its own
 * minimum width (hero 768, auth 1024, tile 1440).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decideBudget, type BudgetInputs } from '@/components/visual/aura/visual-budget';
import { AURA_PRESETS } from '@/components/visual/aura/aura-layout';

const STRONG_DESKTOP: BudgetInputs = {
  reducedMotion: false,
  webgl2: true,
  renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  saveData: false,
  cores: 8,
  memoryGb: 8,
  width: 1440,
  coarsePointer: false,
};

const SWIFTSHADER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';

describe('decideBudget', () => {
  it('gives a strong desktop the high tier', () => {
    expect(decideBudget(STRONG_DESKTOP)).toBe('high');
  });

  it.each<[string, Partial<BudgetInputs>]>([
    ['reduced motion', { reducedMotion: true }],
    ['no WebGL2', { webgl2: false, renderer: null }],
    ['Save-Data', { saveData: true }],
    ['4 cores', { cores: 4 }],
    ['2 cores', { cores: 2 }],
    ['a viewport under the minimum width', { width: 767 }],
  ])('is off with %s', (_, override) => {
    expect(decideBudget({ ...STRONG_DESKTOP, ...override })).toBe('off');
  });

  it('caps software renderers at low', () => {
    expect(decideBudget({ ...STRONG_DESKTOP, renderer: SWIFTSHADER })).toBe('low');
    expect(decideBudget({ ...STRONG_DESKTOP, renderer: 'llvmpipe (LLVM 15.0.7, 256 bits)' })).toBe('low');
    expect(decideBudget({ ...STRONG_DESKTOP, renderer: 'Microsoft Basic Render Driver' })).toBe('low');
  });

  it.each<[string, Partial<BudgetInputs>]>([
    ['under 1280px', { width: 1279 }],
    ['6 cores', { cores: 6 }],
    ['4 GB of memory', { memoryGb: 4 }],
    ['a coarse pointer', { coarsePointer: true }],
  ])('drops to low with %s', (_, override) => {
    expect(decideBudget({ ...STRONG_DESKTOP, ...override })).toBe('low');
  });

  it('treats unknown device memory (Safari, Firefox) as enough', () => {
    expect(decideBudget({ ...STRONG_DESKTOP, memoryGb: null })).toBe('high');
  });

  it('applies the placement minimum width: the tile needs 1440px, auth 1024px', () => {
    const tile = AURA_PRESETS.tile.minWidth;
    const auth = AURA_PRESETS.auth.minWidth;
    expect(tile).toBe(1440);
    expect(auth).toBe(1024);
    expect(decideBudget({ ...STRONG_DESKTOP, width: 1439 }, tile)).toBe('off');
    expect(decideBudget({ ...STRONG_DESKTOP, width: 1440 }, tile)).toBe('high');
    expect(decideBudget({ ...STRONG_DESKTOP, width: 1023 }, auth)).toBe('off');
    expect(decideBudget({ ...STRONG_DESKTOP, width: 1024 }, auth)).toBe('low');
  });

  it('never enables WebGL when any hard gate is closed (property)', () => {
    const inputs = fc.record({
      reducedMotion: fc.boolean(),
      webgl2: fc.boolean(),
      renderer: fc.option(fc.constantFrom(STRONG_DESKTOP.renderer!, SWIFTSHADER, 'Apple M2'), { nil: null }),
      saveData: fc.boolean(),
      cores: fc.integer({ min: 1, max: 32 }),
      memoryGb: fc.option(fc.constantFrom(0.5, 1, 2, 4, 8, 16), { nil: null }),
      width: fc.integer({ min: 320, max: 3840 }),
      coarsePointer: fc.boolean(),
    });
    fc.assert(
      fc.property(inputs, fc.constantFrom(768, 1024, 1440), (i, minWidth) => {
        const budget = decideBudget(i, minWidth);
        const closed = i.reducedMotion || !i.webgl2 || i.saveData || i.cores <= 4 || i.width < minWidth;
        if (closed) return budget === 'off';
        if (budget === 'high') return i.width >= 1280 && i.cores >= 8 && (i.memoryGb ?? 8) >= 8 && !i.coarsePointer && i.renderer !== SWIFTSHADER;
        return budget === 'low';
      }),
    );
  });
});

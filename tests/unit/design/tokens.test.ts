/**
 * Token contract for the "Aurora" palette (design spec §0 and §1): every pre-v2 token name keeps
 * working, the reserved hues keep their roles, the panel signatures map to the right hues, and the
 * Tailwind theme exposes the names pages use. Read from the shipped CSS (token-source).
 */
import { describe, expect, it } from 'vitest';
import { declarations, globalsCss, hexToken, resolveToken, rootTokens, ruleBody, tokensCss } from './token-source';

describe('token names', () => {
  it('keeps every pre-v2 token defined in :root', () => {
    const legacy = [
      'bg-0', 'bg-1', 'bg-2', 'bg-3', 'border-subtle', 'border-strong', 'text-1', 'text-2', 'text-3',
      'accent', 'accent-fg', 'ai', 'success', 'warning', 'danger', 'info', 'demo',
      'paper', 'ink-1', 'ink-2', 'rule', 'brand',
      'r-xs', 'r-sm', 'r-md', 'r-lg', 'r-xl', 'r-full', 'dur-fast', 'dur-base', 'dur-slow', 'ease-enter', 'ease-exit',
      'shadow-overlay', 'glass-bg', 'glass-blur', 'banner-h', 'topbar-h', 'sidebar-w',
      'background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground', 'primary',
      'primary-foreground', 'secondary', 'secondary-foreground', 'muted', 'muted-foreground', 'surface-hover',
      'surface-hover-foreground', 'destructive', 'border', 'input', 'ring', 'radius',
    ];
    for (const name of legacy) expect(rootTokens.has(name), `--${name}`).toBe(true);
  });

  it('keeps the paper theme and the AI violet unchanged', () => {
    expect(hexToken('paper')).toBe('#ffffff');
    expect(hexToken('ink-1')).toBe('#111318');
    expect(hexToken('ink-2')).toBe('#4a5060');
    expect(hexToken('rule')).toBe('#e3e6ec');
    expect(hexToken('brand')).toBe('#111318');
    expect(hexToken('ai')).toBe('#a78bfa');
  });

  it('keeps aura as the one action color behind accent, primary, ring and the shadcn input border', () => {
    expect(hexToken('accent')).toBe(hexToken('aura'));
    expect(hexToken('primary')).toBe(hexToken('aura'));
    expect(hexToken('ring')).toBe(hexToken('aura'));
    expect(hexToken('primary-foreground')).toBe(hexToken('accent-fg'));
    expect(hexToken('input')).toBe(hexToken('border-input'));
  });
});

describe('panel signatures', () => {
  it('maps each data-panel to its hue pair and gradient', () => {
    const expected = {
      user: ['var(--aura)', 'var(--volt-hi)', 'var(--grad-client)'],
      employee: ['var(--zest)', 'var(--aura)', 'var(--grad-operator)'],
      admin: ['var(--flare)', 'var(--flare-ice)', 'var(--grad-admin)'],
    };
    for (const [panel, [hue, hue2, grad]] of Object.entries(expected)) {
      const tokens = declarations(ruleBody(tokensCss, `[data-panel='${panel}']`));
      expect([tokens.get('panel-hue'), tokens.get('panel-hue-2'), tokens.get('panel-grad')], panel).toEqual([hue, hue2, grad]);
    }
    expect([rootTokens.get('panel-hue'), rootTokens.get('panel-hue-2'), rootTokens.get('panel-grad')]).toEqual([
      'var(--aura)',
      'var(--volt-hi)',
      'var(--grad-aurora)',
    ]);
  });

  it('re-declares the panel-dependent gradients on every panel root', () => {
    const tokens = declarations(ruleBody(tokensCss, ':root,\n[data-panel],\n[data-chroma]'));
    expect(tokens.get('grad-hairline')).toContain('var(--panel-hue)');
    expect(tokens.get('grad-comet')).toMatch(/^conic-gradient\( ?in oklab from var\(--chroma-angle\)/);
  });
});

describe('reserved hues', () => {
  it('never puts status, demo or AI tokens in a gradient', () => {
    const gradients = [...tokensCss.matchAll(/--grad-[\w-]+\s*:\s*([^;]+);/g)].map((m) => m[1]!);
    expect(gradients.length).toBeGreaterThan(5);
    for (const value of gradients) expect(value).not.toMatch(/var\(--(success|warning|danger|info|demo|ai)\)/);
  });

  it('interpolates every pink segment in oklab, never oklch (oklch crosses AI violet)', () => {
    for (const name of ['grad-admin']) expect(resolveToken(name)).toMatch(/^linear-gradient\(in oklab /);
  });
});

describe('Tailwind theme (globals.css)', () => {
  const theme = declarations(ruleBody(globalsCss, '@theme inline'));

  it('exposes the Aurora colors, panel hues and chart series as utilities', () => {
    const names = [
      'aura', 'azure', 'volt', 'volt-hi', 'flare', 'flare-ice', 'zest', 'ice', 'panel', 'panel-2', 'border-input',
      'chart-1', 'chart-1-hi', 'chart-2', 'chart-2-hi', 'chart-3', 'chart-3-hi', 'chart-4', 'chart-4-hi', 'chart-other',
    ];
    for (const name of names) expect(theme.has(`color-${name}`), `--color-${name}`).toBe(true);
    expect(theme.get('color-panel')).toBe('var(--panel-hue)');
    expect(theme.get('color-cyan')).toBe('var(--accent)');
  });

  it('keeps every pre-v2 utility color name', () => {
    const names = [
      'bg-0', 'bg-1', 'bg-2', 'bg-3', 'fg-1', 'fg-2', 'fg-3', 'border-subtle', 'border-strong', 'cyan', 'cyan-fg', 'ai',
      'success', 'warning', 'danger', 'info', 'demo', 'paper', 'ink-1', 'ink-2', 'rule', 'brand', 'background',
      'foreground', 'card', 'popover', 'primary', 'primary-foreground', 'secondary', 'muted', 'muted-foreground',
      'accent', 'accent-foreground', 'destructive', 'border', 'input', 'ring',
    ];
    for (const name of names) expect(theme.has(`color-${name}`), `--color-${name}`).toBe(true);
  });

  it('maps the motion durations and easings', () => {
    for (const d of ['instant', 'fast', 'base', 'slow', 'enter', 'chart', 'cinematic']) {
      expect(theme.get(`transition-duration-${d}`)).toBe(`var(--dur-${d})`);
      expect(rootTokens.has(`dur-${d}`), `--dur-${d}`).toBe(true);
    }
    for (const e of ['enter', 'exit', 'emphasized', 'ambient']) expect(rootTokens.has(`ease-${e}`), `--ease-${e}`).toBe(true);
  });

  it('keeps the type scale at 56px or below', () => {
    const scale = declarations(ruleBody(globalsCss, '@theme'));
    const sizes = [...scale].filter(([name]) => /^text-\w+$/.test(name)).map(([, value]) => value);
    expect(sizes.length).toBeGreaterThan(5);
    for (const size of sizes) {
      if (size === 'initial') continue;
      expect(Number.parseFloat(size), size).toBeLessThanOrEqual(56);
    }
  });
});

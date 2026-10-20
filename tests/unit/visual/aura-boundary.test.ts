/**
 * Bundle hygiene for the aura scene (design spec §0.7): three, @react-three/* and the scene module
 * (AuraScene) are reachable only through next/dynamic({ ssr: false }) in AuraVisual.tsx, so no page
 * bundles three eagerly. Also checks the server render: the wrappers SSR the poster only (no canvas,
 * aria-hidden, data-visual-state="poster") and the poster markup is deterministic, so it hydrates.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuraAuthBackdrop, AuraHero, AuraPoster, AuraTile } from '@/components/visual/aura';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const AURA_DIR = 'src/components/visual/aura';
const SCENE = `${AURA_DIR}/AuraScene.tsx`;
const SHELL = `${AURA_DIR}/AuraVisual.tsx`;

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(repoRoot, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(repoRoot, rel)).isDirectory()) return name === 'generated' ? [] : sourceFiles(rel);
    return /\.(ts|tsx)$/.test(name) ? [rel] : [];
  });
}

const FILES = sourceFiles('src').map((rel) => ({ rel, source: readFileSync(path.join(repoRoot, rel), 'utf8') }));
const THREE_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:three(?:\/[^'"]*)?|@react-three\/[^'"]+|three-stdlib)['"]/;
const SCENE_IMPORT = /['"][^'"]*AuraScene['"]/;

describe('aura bundle boundary', () => {
  it('imports three and @react-three/* only in the scene module', () => {
    const offenders = FILES.filter((f) => THREE_IMPORT.test(f.source)).map((f) => f.rel);
    expect(offenders).toEqual([SCENE]);
  });

  it('reaches the scene module only through a dynamic import with ssr: false in AuraVisual', () => {
    const importers = FILES.filter((f) => f.rel !== SCENE && SCENE_IMPORT.test(f.source));
    expect(importers.map((f) => f.rel)).toEqual([SHELL]);
    const shell = importers[0]!.source;
    expect(shell).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\(\s*['"]\.\/AuraScene['"]\s*\)[\s\S]*?\{\s*ssr:\s*false\s*\}\s*\)/);
    expect(shell).not.toMatch(/^import[^;]*['"]\.\/AuraScene['"]/m);
  });
});

describe('aura server render', () => {
  it.each([
    ['AuraHero', AuraHero, 'hero'],
    ['AuraAuthBackdrop', AuraAuthBackdrop, 'auth'],
    ['AuraTile', AuraTile, 'tile'],
  ] as const)('%s renders only the poster on the server', (_, Wrapper, preset) => {
    const html = renderToStaticMarkup(createElement(Wrapper, { className: 'h-64' }));
    expect(html).toContain(`data-aura="${preset}"`);
    expect(html).toContain('data-visual-state="poster"');
    expect(html).toContain(`data-aura-poster="${preset}"`);
    expect(html).toMatch(/^<div aria-hidden="true"/);
    expect(html).not.toContain('<canvas');
  });

  it('renders a deterministic, text-free poster for every preset', () => {
    for (const preset of ['hero', 'auth', 'tile'] as const) {
      const first = renderToStaticMarkup(createElement(AuraPoster, { preset }));
      expect(renderToStaticMarkup(createElement(AuraPoster, { preset }))).toBe(first);
      expect(first.replace(/<[^>]+>/g, '').trim()).toBe('');
      expect(first).toContain('aria-hidden="true"');
      expect(first).not.toMatch(/NaN|Infinity/);
    }
  });
});

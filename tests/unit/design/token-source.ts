/**
 * Reads design tokens straight from src/styles/tokens.css and the Tailwind theme in
 * src/app/globals.css, so the design tests check the shipped CSS rather than a copy of it.
 * Comments are stripped first; values are the raw declaration text, `var(--x)` aliases resolvable.
 */
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

function readCss(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

export const tokensCss = readCss('src/styles/tokens.css');
export const globalsCss = readCss('src/app/globals.css');

/** Body of the first rule whose prelude is exactly `selector` (brace-matched). */
export function ruleBody(css: string, selector: string): string {
  const head = css.indexOf(`${selector} {`);
  if (head < 0) throw new Error(`no rule for ${selector}`);
  const open = css.indexOf('{', head);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces after ${selector}`);
}

/** Custom-property declarations of a rule body, name (without --) to raw value. */
export function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim().replace(/\s+/g, ' '));
  return out;
}

export const rootTokens = declarations(ruleBody(tokensCss, ':root'));

/** A :root token's value with plain `var(--x)` aliases followed. */
export function resolveToken(name: string): string {
  let value = rootTokens.get(name);
  const seen = new Set<string>();
  while (value !== undefined) {
    const alias = /^var\(--([\w-]+)\)$/.exec(value);
    if (!alias) return value;
    if (seen.has(alias[1]!)) throw new Error(`alias cycle at --${name}`);
    seen.add(alias[1]!);
    value = rootTokens.get(alias[1]!);
  }
  throw new Error(`--${name} is not defined in :root`);
}

/** A :root token that must resolve to a #rrggbb hex. */
export function hexToken(name: string): string {
  const value = resolveToken(name);
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`--${name} is not a #rrggbb hex: ${value}`);
  return value.toLowerCase();
}

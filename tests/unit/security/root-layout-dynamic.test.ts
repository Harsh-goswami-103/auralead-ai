/**
 * ADR-69: the nonce CSP only works on pages rendered per request. A prerendered page (Next's
 * generated `/_not-found` for an unknown URL is one unless the root layout opts out) has no nonce on
 * its scripts, so the browser blocks all of them. The root layout must therefore stay dynamic.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('root layout', () => {
  it('opts every page, including not-found, into dynamic rendering', () => {
    const source = readFileSync(path.resolve(import.meta.dirname, '../../../src/app/layout.tsx'), 'utf8');
    expect(source).toMatch(/^export const dynamic = 'force-dynamic';$/m);
  });
});

/**
 * Plan §9 XSS (T11 contract, built with T37): `safeHref` is the one gate for hrefs that come from
 * data (docs content today). It allows http, https, mailto and tel URLs, same-origin paths and
 * in-page fragments, and refuses everything else, including scripts hidden behind case, leading
 * whitespace, control characters or protocol-relative tricks.
 */
import { describe, expect, it } from 'vitest';
import { safeHref } from '@/server/security/safe-href';

describe('safeHref', () => {
  it.each([
    ['https://example.com/a?b=c#d', 'https://example.com/a?b=c#d'],
    ['http://localhost:3000/login', 'http://localhost:3000/login'],
    ['mailto:owner@example.com', 'mailto:owner@example.com'],
    ['tel:+919876543210', 'tel:+919876543210'],
    ['/docs/security#csrf', '/docs/security#csrf'],
    ['/login', '/login'],
    ['#on-this-page', '#on-this-page'],
    ['  /docs  ', '/docs'],
  ])('allows %s', (input, expected) => {
    expect(safeHref(input)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'javascript\u0000:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://example.com',
    '//evil.example/path',
    '/\\evil.example',
    'relative/path',
    '',
    '   ',
    '#',
    '#has space',
    'https://',
  ])('refuses %j', (input) => {
    expect(safeHref(input)).toBeNull();
  });

  it('refuses non-strings', () => {
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref(null)).toBeNull();
    expect(safeHref(42)).toBeNull();
  });
});

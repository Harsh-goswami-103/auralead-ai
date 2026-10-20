/**
 * ADR-69 on the built app: every HTML response, including the page an unknown URL gets, carries the
 * nonce CSP and every script tag in it carries the same nonce; the pages hydrate without a single
 * CSP violation.
 */
import { expect, test } from '@playwright/test';

const nonceOf = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1] ?? null;

for (const url of ['/', '/login', '/docs', '/definitely/not/a/page']) {
  test(`${url}: the nonce is on every script and nothing is blocked`, async ({ page, request }) => {
    const res = await request.get(url);
    const csp = res.headers()['content-security-policy'];
    expect(csp, `${url} has a CSP`).toBeTruthy();
    const nonce = nonceOf(csp!);
    expect(nonce, `${url} CSP carries a script nonce`).toBeTruthy();
    const html = await res.text();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag, `${url}: ${tag}`).toContain(`nonce="${nonce}"`);

    const violations: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) violations.push(m.text());
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    expect(violations).toEqual([]);
  });
}

test('every request gets a fresh nonce', async ({ request }) => {
  const a = nonceOf((await request.get('/login')).headers()['content-security-policy']!);
  const b = nonceOf((await request.get('/login')).headers()['content-security-policy']!);
  expect(a).toBeTruthy();
  expect(a).not.toBe(b);
});

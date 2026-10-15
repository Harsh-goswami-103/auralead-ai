/**
 * AT7 / R19 (T16, C2-C5) against the built DEMO app and worker: the public quote at /quote/[token]
 * in each share state, using the seeded shared quote of NestKey Realty
 * (prisma/seed/fixtures/shared-quotes.ts):
 *  - never-issued and revoked links render the identical 404 page; the superseded link 410 names
 *    the sender;
 *  - the live link renders with the public-page headers and a working CSP (no violations), the
 *    beacon moves the quote to VIEWED after 2 s of visibility, the stored PDF downloads once the
 *    worker has rendered it, and acceptance records a receipt the page then shows;
 *  - past the link's expiry (shared test clock) the same link is 410 naming the sender.
 */
import { createHash } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';

const SENDER = 'NestKey Realty Advisors';
const KEY = 'nestkey-realty:Q-0001';
const token = (label: 'current' | 'superseded' | 'revoked') => createHash('sha256').update(`auralead-demo-share:${KEY}:${label}`, 'utf8').digest('base64url');
const NEVER_ISSUED = Buffer.alloc(32, 0x4e).toString('base64url');

function control(): Record<string, string> {
  const t = process.env.E2E_TEST_CONTROL_TOKEN;
  if (!t) throw new Error('E2E_TEST_CONTROL_TOKEN is not set: run through the T09 harness');
  return { 'x-test-control-token': t };
}

async function resetAll(request: APIRequestContext) {
  expect((await request.post('/api/test/clock', { headers: control(), data: { reset: true } })).status()).toBe(200);
  expect((await request.post('/api/test/reset', { headers: control() })).status()).toBe(200);
}

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test.afterAll(async ({ request }) => {
  await resetAll(request);
});

test('invalid and revoked links give the identical 404; a superseded link gives 410 naming the sender', async ({ request }) => {
  const unknown = await request.get(`/quote/${NEVER_ISSUED}`);
  const revoked = await request.get(`/quote/${token('revoked')}`);
  expect(unknown.status()).toBe(404);
  expect(revoked.status()).toBe(404);
  expect(await unknown.text()).toBe(await revoked.text());
  expect(await unknown.text()).not.toContain(SENDER);

  const superseded = await request.get(`/quote/${token('superseded')}`);
  expect(superseded.status()).toBe(410);
  expect(await superseded.text()).toContain(SENDER);
});

test('the live link: headers, beacon to VIEWED, PDF download and acceptance', async ({ page, request, baseURL }) => {
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (/Content Security Policy|Refused to/i.test(msg.text())) violations.push(msg.text());
  });
  const live = `/quote/${token('current')}`;
  const beacon = page.waitForRequest((r) => r.url().endsWith(`/api/quote-share/${token('current')}/view`) && r.method() === 'POST');
  const startedAt = Date.now();
  const response = await page.goto(live);
  expect(response?.status()).toBe(200);
  const headers = response!.headers();
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['cache-control']).toBe('private, no-store');
  expect(headers['x-robots-tag']).toBe('noindex');
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");

  await expect(page.getByRole('heading', { name: 'Quotation', exact: true })).toBeVisible();
  await expect(page.locator('[data-field="total"]')).toHaveText('₹24,780.00');
  await expect(page.locator('[data-field="version"]')).toHaveText('v2');
  await expect(page.getByText('DEMO: not a valid offer')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();

  // C4: the beacon fires after 2 s of visibility; a bot-class probe then reads the status without moving it.
  await (await beacon).response();
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_000);
  const probe = await request.post(`/api/quote-share/${token('current')}/view`, { headers: { origin: baseURL!, 'user-agent': 'curl/8.4.0' }, data: {} });
  expect(probe.status()).toBe(200);
  expect(await probe.json()).toMatchObject({ status: 'VIEWED' });

  // C1: the PDF is rendered by the worker and served from storage (503 + Retry-After until then).
  let pdf = await request.get(`/api/quote-share/${token('current')}/pdf`);
  for (let i = 0; i < 30 && pdf.status() === 503; i++) {
    expect(Number(pdf.headers()['retry-after'])).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1_000));
    pdf = await request.get(`/api/quote-share/${token('current')}/pdf`);
  }
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');

  // C5: acceptance through the page form; the page then shows the receipt instead of the form.
  await page.getByLabel('Your full name').fill('Meera Iyer');
  await page.getByRole('button', { name: 'Accept Q-0001 v2' }).click();
  await expect(page.locator('[data-field="acceptance"]')).toContainText('Accepted by Meera Iyer');
  await expect(page.locator('[data-field="state"]')).toHaveText('Accepted');
  await expect(page.getByRole('button', { name: /^Accept / })).toHaveCount(0);
  expect(violations).toEqual([]);
});

test('past its expiry the same link is 410 naming the sender', async ({ request }) => {
  expect((await request.get(`/quote/${token('current')}`)).status()).toBe(200);
  expect((await request.post('/api/test/clock', { headers: control(), data: { advanceMs: 31 * 86_400_000 } })).status()).toBe(200);
  const expired = await request.get(`/quote/${token('current')}`);
  expect(expired.status()).toBe(410);
  const html = await expired.text();
  expect(html).toContain(SENDER);
  expect(html).toMatch(/expired/i);
});

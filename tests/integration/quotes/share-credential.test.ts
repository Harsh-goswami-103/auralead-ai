/**
 * AT7 / R19 (T16, C2, C3, ADR-09): the public quote at /quote/[token] needs a valid share
 * credential, and each share state answers with its own status:
 *  - no token / wrong token / revoked / cancelled quote: the identical 404 page (a takedown must
 *    not confirm the link ever existed);
 *  - expired link or expired quote, superseded link: 410 naming the sender;
 *  - only sha256(token) is stored; the public quote limit (30/min/IP) answers 429.
 * The JSON API under /api/quote-share answers with the same statuses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '@/server/security/tokens';
import { createQuoteShare, revokeQuoteShare } from '@/server/services/quotes/share';
import { cancelQuote, reviseQuote } from '@/server/services/quotes/versioning';
import { createPublicHarness, getQuotePage, getSharePdf, issueQuote, postView, type PublicHarness } from './public-support';
import { DAY } from './support';

let h: PublicHarness;

beforeAll(async () => {
  h = await createPublicHarness('share-credential');
});
afterAll(async () => {
  await h?.destroy();
});

const NEVER_ISSUED = Buffer.alloc(32, 0x41).toString('base64url');
const SENDER = 'Smile Avenue Dental Clinic';

async function page(token: string, ip = '203.0.113.20') {
  const res = await getQuotePage(token, { ip });
  return { res, status: res.status, html: await res.text() };
}

describe('public quote share credentials (AT7, C3)', () => {
  it('a live link renders the quote with the public-page headers', async () => {
    const q = await issueQuote(h, { sent: true });
    const { res, status, html } = await page(q.token);
    expect(status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/);
    expect(html).toContain(q.number);
    expect(html).toContain('₹21,240.00');
  });

  it('a missing, malformed or never-issued token, a revoked link and a cancelled quote give the identical 404', async () => {
    const revoked = await issueQuote(h, { sent: true });
    const share = await h.db.quoteShare.findFirstOrThrow({ where: { quoteId: revoked.quoteId } });
    await revokeQuoteShare(h.owner, revoked.quoteId, share.id);

    const cancelled = await issueQuote(h, { sent: true });
    await cancelQuote(h.owner, cancelled.quoteId, { expectedVersion: 1 });

    const results = await Promise.all([page(''), page('not-a-token'), page(NEVER_ISSUED), page(revoked.token), page(cancelled.token)]);
    for (const r of results) expect(r.status).toBe(404);
    const bodies = new Set(results.map((r) => r.html));
    expect(bodies.size).toBe(1);
    expect(results[0]!.html).not.toContain(SENDER);
  });

  it('an expired link and an expired quote give 410 naming the sender', async () => {
    const shortLink = await issueQuote(h, { sent: true });
    const { token: oneDay } = await createQuoteShare(h.owner, shortLink.quoteId, { expiresInDays: 1 });
    const lapsing = await issueQuote(h, { sent: true });
    const quote = await h.db.quote.findUniqueOrThrow({ where: { id: lapsing.quoteId } });

    h.clock.advance(DAY + 1_000);
    const expiredLink = await page(oneDay);
    expect(expiredLink.status).toBe(410);
    expect(expiredLink.html).toContain(SENDER);
    expect(expiredLink.html).toMatch(/expired/i);
    // The quote's other link (expiresAt = validUntil) is still live.
    expect((await page(shortLink.token)).status).toBe(200);

    h.clock.set(new Date(quote.validUntil!.getTime()));
    const expiredQuote = await page(lapsing.token);
    expect(expiredQuote.status).toBe(410);
    expect(expiredQuote.html).toContain(SENDER);
    h.clock.set(new Date('2026-10-16T06:00:00.000Z'));
  });

  it('a link to a superseded version gives 410 naming the sender', async () => {
    const q = await issueQuote(h, { sent: true });
    await reviseQuote(h.owner, q.quoteId, { expectedVersion: 1, items: [{ serviceId: h.serviceId, qty: 3 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'Revised plan', timelineText: 'Six weeks' });
    const { status, html } = await page(q.token);
    expect(status).toBe(410);
    expect(html).toContain(SENDER);
    expect(html).toMatch(/newer version/i);
  });

  it('the JSON routes answer with the same statuses (404 identical for invalid and revoked, 410 for superseded)', async () => {
    const revoked = await issueQuote(h, { sent: true });
    const share = await h.db.quoteShare.findFirstOrThrow({ where: { quoteId: revoked.quoteId } });
    await revokeQuoteShare(h.owner, revoked.quoteId, share.id);
    const a = await getSharePdf(NEVER_ISSUED, { requestId: 'req_share_probe_0001' });
    const b = await getSharePdf(revoked.token, { requestId: 'req_share_probe_0001' });
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(await a.text()).toBe(await b.text());

    const superseded = await issueQuote(h, { sent: true });
    await reviseQuote(h.owner, superseded.quoteId, { expectedVersion: 1, items: [{ serviceId: h.serviceId, qty: 1 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'Smaller plan', timelineText: 'Two weeks' });
    const gone = await postView(superseded.token, {});
    expect(gone.status).toBe(410);
    expect(((await gone.json()) as { message: string }).message).toContain(SENDER);
  });

  it('stores only the sha256 of the token', async () => {
    const q = await issueQuote(h, { sent: true });
    const rows = await h.db.quoteShare.findMany({ where: { quoteId: q.quoteId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashToken(q.token));
    expect(JSON.stringify(rows)).not.toContain(q.token);
    const audit = await h.db.auditEvent.findMany({ where: { targetId: q.quoteId } });
    expect(JSON.stringify(audit)).not.toContain(q.token);
  });

  it('rate limits the public quote per IP (30/min) with 429', async () => {
    const q = await issueQuote(h, { sent: true });
    const ip = '198.51.100.77';
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await getQuotePage(q.token, { ip })).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    const limited = await getQuotePage(q.token, { ip });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another address is unaffected.
    expect((await getQuotePage(q.token, { ip: '198.51.100.78' })).status).toBe(200);
  });
});

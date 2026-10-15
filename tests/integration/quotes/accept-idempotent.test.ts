/**
 * AT7 / R19 (T16, C5, ADR-10): public acceptance is a POST with the token, the form nonce the
 * page rendered (HMAC(SHARE_NONCE_KEY, tokenHash || versionId)), Origin = APP_ORIGIN and the
 * expected version. It is idempotent per version: two parallel accepts give one ACCEPTED quote,
 * one QuoteAcceptance, one `quote.accept` audit row and the same receipt. A stale version is a
 * 409; a missing or wrong nonce or a foreign Origin is a 403; GET never mutates.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formNonce } from '@/server/security/csrf';
import { hashToken } from '@/server/security/tokens';
import { createQuoteShare } from '@/server/services/quotes/share';
import { approveQuote, reviseQuote } from '@/server/services/quotes/versioning';
import { acceptFormFields, createPublicHarness, getQuotePage, issueQuote, markSent, postAccept, type PublicHarness } from './public-support';

let h: PublicHarness;

beforeAll(async () => {
  h = await createPublicHarness('accept-idempotent');
});
afterAll(async () => {
  await h?.destroy();
});

let ipSeq = 0;
const freshIp = () => `192.0.2.${++ipSeq}`;

async function formFor(token: string) {
  const res = await getQuotePage(token, { ip: freshIp() });
  expect(res.status).toBe(200);
  return acceptFormFields(await res.text());
}

describe('public quote acceptance (C5)', () => {
  it('two parallel accepts: one ACCEPTED quote, one acceptance, one audit row, the same receipt', async () => {
    const q = await issueQuote(h, { sent: true });
    const form = await formFor(q.token);
    const body = { token: q.token, ...form, acceptorName: 'Asha Raman' };
    const [a, b] = await Promise.all([postAccept(q.token, { body, ip: freshIp() }), postAccept(q.token, { body: { ...body, acceptorName: 'Asha R.' }, ip: freshIp() })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const ra = (await a.json()) as { receipt: Record<string, unknown> };
    const rb = (await b.json()) as { receipt: Record<string, unknown> };
    expect(ra.receipt).toEqual(rb.receipt);
    expect(ra.receipt).toMatchObject({ quoteNumber: q.number, versionNo: 1 });

    const quote = await h.db.quote.findUniqueOrThrow({ where: { id: q.quoteId } });
    expect(quote).toMatchObject({ status: 'ACCEPTED', acceptedVersionId: q.versionId });
    expect(await h.db.quoteAcceptance.count({ where: { quoteId: q.quoteId } })).toBe(1);
    expect(await h.db.auditEvent.count({ where: { targetId: q.quoteId, action: 'quote.accept' } })).toBe(1);
    const lead = await h.db.lead.findUniqueOrThrow({ where: { id: q.leadId } });
    expect(lead.salesStage).toBe('CONVERTED');

    // A later repeat returns the same receipt and writes nothing.
    const again = await postAccept(q.token, { body, ip: freshIp() });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { receipt: unknown }).receipt).toEqual(ra.receipt);
    expect(await h.db.auditEvent.count({ where: { targetId: q.quoteId, action: 'quote.accept' } })).toBe(1);

    // The page now shows the acceptance instead of the form.
    const after = await (await getQuotePage(q.token, { ip: freshIp() })).text();
    expect(after).toMatch(/Accepted/);
    expect(after).not.toContain('name="formNonce"');
  });

  it('accepting a version that is no longer current is a 409; the superseded link itself is a 410', async () => {
    const q = await issueQuote(h, { sent: true });
    const v1Form = await formFor(q.token);
    await reviseQuote(h.owner, q.quoteId, { expectedVersion: 1, items: [{ serviceId: h.serviceId, qty: 1 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'Revised', timelineText: 'Two weeks' });
    await approveQuote(h.owner, q.quoteId, { expectedVersion: 2 });
    await markSent(h.db, q.quoteId);
    const { token: v2Token } = await createQuoteShare(h.owner, q.quoteId, {});

    const old = await postAccept(q.token, { body: { token: q.token, ...v1Form, acceptorName: 'Asha Raman' }, ip: freshIp() });
    expect(old.status).toBe(410);

    // A correctly minted nonce for version 1 on the version 2 link: the version check answers 409.
    const key = h.runtime.config.secrets.shareNonceKey!;
    const stale = await postAccept(v2Token, {
      body: { token: v2Token, formNonce: formNonce(key, hashToken(v2Token), q.versionId), expectedVersionId: q.versionId, acceptorName: 'Asha Raman' },
      ip: freshIp(),
    });
    expect(stale.status).toBe(409);

    // A nonce minted for another version than the one claimed is refused before any read.
    const v2Form = await formFor(v2Token);
    const mixed = await postAccept(v2Token, { body: { token: v2Token, formNonce: v2Form.formNonce, expectedVersionId: q.versionId, acceptorName: 'Asha Raman' }, ip: freshIp() });
    expect(mixed.status).toBe(403);
    expect((await h.db.quote.findUniqueOrThrow({ where: { id: q.quoteId } })).status).toBe('SENT');
    expect(await h.db.quoteAcceptance.count({ where: { quoteId: q.quoteId } })).toBe(0);
  });

  it('a quote that is approved but not yet sent cannot be accepted (409) and offers no form', async () => {
    const q = await issueQuote(h, { sent: false });
    const html = await (await getQuotePage(q.token, { ip: freshIp() })).text();
    expect(html).not.toContain('name="formNonce"');
    const nonce = formNonce(h.runtime.config.secrets.shareNonceKey!, hashToken(q.token), q.versionId);
    const res = await postAccept(q.token, { body: { token: q.token, formNonce: nonce, expectedVersionId: q.versionId, acceptorName: 'Asha Raman' }, ip: freshIp() });
    expect(res.status).toBe(409);
    expect((await h.db.quote.findUniqueOrThrow({ where: { id: q.quoteId } })).status).toBe('APPROVED');
  });

  it('missing nonce, wrong nonce, missing or foreign Origin give 403 and change nothing', async () => {
    const q = await issueQuote(h, { sent: true });
    const form = await formFor(q.token);
    const good = { token: q.token, ...form, acceptorName: 'Asha Raman' };
    const cases = [
      postAccept(q.token, { body: { ...good, formNonce: undefined }, ip: freshIp() }),
      postAccept(q.token, { body: { ...good, formNonce: `${form.formNonce.slice(0, -2)}AA` }, ip: freshIp() }),
      postAccept(q.token, { body: good, origin: null, ip: freshIp() }),
      postAccept(q.token, { body: good, origin: 'https://evil.example', ip: freshIp() }),
    ];
    const statuses = (await Promise.all(cases)).map((r) => r.status);
    expect(statuses[0]).toBeGreaterThanOrEqual(400);
    expect(statuses.slice(1)).toEqual([403, 403, 403]);
    expect([400, 403]).toContain(statuses[0]);
    expect((await h.db.quote.findUniqueOrThrow({ where: { id: q.quoteId } })).status).toBe('SENT');
    expect(await h.db.quoteAcceptance.count({ where: { quoteId: q.quoteId } })).toBe(0);
  });

  it('a body token that differs from the link is a 404', async () => {
    const q = await issueQuote(h, { sent: true });
    const other = await issueQuote(h, { sent: true });
    const form = await formFor(q.token);
    const res = await postAccept(q.token, { body: { token: other.token, ...form, acceptorName: 'Asha Raman' }, ip: freshIp() });
    expect(res.status).toBe(404);
  });

  it('GET never mutates: repeated page loads leave the quote SENT and only append FETCH events', async () => {
    const q = await issueQuote(h, { sent: true });
    for (let i = 0; i < 3; i++) expect((await getQuotePage(q.token, { ip: freshIp() })).status).toBe(200);
    const quote = await h.db.quote.findUniqueOrThrow({ where: { id: q.quoteId } });
    expect(quote.status).toBe('SENT');
    expect(await h.db.quoteAcceptance.count({ where: { quoteId: q.quoteId } })).toBe(0);
    const events = await h.db.quoteViewEvent.findMany({ where: { quoteVersionId: q.versionId } });
    expect(events.map((e) => e.kind)).toEqual(['FETCH', 'FETCH', 'FETCH']);
  });
});

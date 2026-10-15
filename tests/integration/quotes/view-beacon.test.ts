/**
 * R20 / P15 (T16, C4, ADR-10): what counts as "viewed".
 *  - GET of the public page only appends a QuoteViewEvent(FETCH); the quote state never moves.
 *  - The page's beacon (POST after 2 s visible) on a SENT quote appends a BEACON event and moves
 *    the quote to VIEWED, audited with the label "Opened (may be automated)".
 *  - A beacon from a link-preview or bot user agent is recorded but moves nothing.
 *  - A beacon on an APPROVED quote (link copied, never marked sent) records the event plus the
 *    hint "Mark as sent?" and leaves the quote APPROVED (APPROVED -> VIEWED is invalid).
 *  - The beacon needs Origin = APP_ORIGIN like every public mutation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicHarness, getQuotePage, issueQuote, postView, WS_A, type PublicHarness } from './public-support';

let h: PublicHarness;

beforeAll(async () => {
  h = await createPublicHarness('view-beacon');
});
afterAll(async () => {
  await h?.destroy();
});

const events = (versionId: string) => h.db.quoteViewEvent.findMany({ where: { quoteVersionId: versionId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const status = async (quoteId: string) => (await h.db.quote.findUniqueOrThrow({ where: { id: quoteId } })).status;

describe('view evidence (C4)', () => {
  it('GET appends a FETCH event only; the quote stays SENT', async () => {
    const q = await issueQuote(h, { sent: true });
    expect((await getQuotePage(q.token)).status).toBe(200);
    expect((await getQuotePage(q.token, { ua: 'WhatsApp/2.23.20.0 A' })).status).toBe(200);
    const ev = await events(q.versionId);
    // Same clock tick: compare without order.
    expect(ev.map((e) => `${e.kind}:${e.uaClass}`).sort()).toEqual(['FETCH:BROWSER', 'FETCH:LINK_PREVIEW']);
    expect(ev.every((e) => /^[0-9a-f]{32}$/.test(e.ipHash))).toBe(true);
    expect(await status(q.quoteId)).toBe('SENT');
    expect(await h.db.auditEvent.count({ where: { targetId: q.quoteId, action: { startsWith: 'quote.view' } } })).toBe(0);
  });

  it('a beacon on a SENT quote gives VIEWED, labelled "Opened (may be automated)"', async () => {
    const q = await issueQuote(h, { sent: true });
    const res = await postView(q.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recorded: true, status: 'VIEWED', label: 'Opened (may be automated)', hint: null });
    expect(await status(q.quoteId)).toBe('VIEWED');
    expect((await events(q.versionId)).map((e) => e.kind)).toEqual(['BEACON']);
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { targetId: q.quoteId, action: 'quote.view' } });
    expect(audit).toMatchObject({ actorKind: 'PUBLIC', workspaceId: WS_A });
    expect(audit.summary).toMatchObject({ label: 'Opened (may be automated)', versionNo: 1 });

    // A second beacon records the event and changes nothing else.
    expect((await (await postView(q.token)).json()) as object).toMatchObject({ status: 'VIEWED' });
    expect(await h.db.auditEvent.count({ where: { targetId: q.quoteId, action: 'quote.view' } })).toBe(1);
    expect((await events(q.versionId)).map((e) => e.kind)).toEqual(['BEACON', 'BEACON']);
  });

  it('a beacon from a link-preview or bot user agent is recorded but does not move the quote', async () => {
    const q = await issueQuote(h, { sent: true });
    for (const ua of ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'curl/8.4.0']) {
      const res = await postView(q.token, { ua });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ recorded: true, status: 'SENT' });
    }
    expect(await status(q.quoteId)).toBe('SENT');
    expect((await events(q.versionId)).map((e) => e.uaClass).sort()).toEqual(['BOT', 'BOT', 'LINK_PREVIEW']);
  });

  it('a beacon on an APPROVED quote records the event and the hint "Mark as sent?"', async () => {
    const q = await issueQuote(h, { sent: false });
    const res = await postView(q.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recorded: true, status: 'APPROVED', hint: 'Mark as sent?' });
    expect(await status(q.quoteId)).toBe('APPROVED');
    expect((await events(q.versionId)).map((e) => e.kind)).toEqual(['BEACON']);
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { targetId: q.quoteId, action: 'quote.view.unsent' } });
    expect(audit.summary).toMatchObject({ hint: 'Mark as sent?', versionNo: 1 });
  });

  it('the beacon needs Origin = APP_ORIGIN', async () => {
    const q = await issueQuote(h, { sent: true });
    expect((await postView(q.token, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await postView(q.token, { origin: null })).status).toBe(403);
    expect(await status(q.quoteId)).toBe('SENT');
    expect(await events(q.versionId)).toEqual([]);
  });
});

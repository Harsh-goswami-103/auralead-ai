/**
 * T16 seed fixture: the demo shared quote in nestkey-realty (prisma/seed/fixtures/shared-quotes.ts)
 * is priced exactly as the server would price it, and its three seeded links answer as the public
 * page contract says: current link 200 with the acceptance form, superseded link 410 naming the
 * sender, revoked link 404.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeQuoteTotals } from '@/server/services/pricing/compute-totals';
import { demoShareToken, SHARED_QUOTE_KEY } from '../../../prisma/seed/fixtures/shared-quotes';
import { seedId } from '../../../prisma/seed/ids';
import { createPublicHarness, getQuotePage, type PublicHarness } from './public-support';
import { jobCtx } from './support';

let h: PublicHarness;

beforeAll(async () => {
  h = await createPublicHarness('seed-shared-quote');
});
afterAll(async () => {
  await h?.destroy();
});

const WS = seedId('workspace', 'nestkey-realty');
const QUOTE = seedId('quote', SHARED_QUOTE_KEY);

describe('seeded shared quote (nestkey-realty)', () => {
  it('is SENT on version 2, priced by the server rules, with links in each share state', async () => {
    const quote = await h.db.quote.findUniqueOrThrow({ where: { id: QUOTE }, include: { currentVersion: { include: { items: true } } } });
    expect(quote).toMatchObject({ workspaceId: WS, status: 'SENT', sentVia: 'MANUAL_LINK', currentVersionNo: 2 });
    const v2 = quote.currentVersion!;
    const priced = await computeQuoteTotals(jobCtx({ db: h.db, clock: h.clock, testDb: h.testDb }, WS), {
      items: v2.items.map((i) => ({ serviceId: i.serviceId, qty: i.qty })),
      discount: { kind: 'NONE', value: 0n },
    });
    expect(v2.totalPaise).toBe(priced.totals.totalPaise);
    expect(v2.totalPaise).toBe(2_478_000n);
    const shares = await h.db.quoteShare.findMany({ where: { quoteId: QUOTE } });
    expect(shares).toHaveLength(3);
  });

  it('the current link renders the live page with the acceptance form', async () => {
    const res = await getQuotePage(demoShareToken('current'), { ip: '198.51.100.201' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('₹24,780.00');
    expect(html).toContain('name="formNonce"');
    expect(html).toContain('NestKey Realty Advisors');
  });

  it('the superseded link is 410 naming the sender, the revoked link is 404', async () => {
    const gone = await getQuotePage(demoShareToken('superseded'), { ip: '198.51.100.202' });
    expect(gone.status).toBe(410);
    expect(await gone.text()).toContain('NestKey Realty Advisors');
    expect((await getQuotePage(demoShareToken('revoked'), { ip: '198.51.100.203' })).status).toBe(404);
  });
});

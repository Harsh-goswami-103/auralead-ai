/**
 * T15 seed fixture: the demo quote in workspace B is exactly what `createQuote` would have written
 * at seed time: totals and snapshot from `computeQuoteTotals` on price list v1, one PENDING
 * approval, a `quote.create` audit row, validUntil = created + the workspace validity. It can be
 * approved and revised through the real services (owner of B).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeQuoteTotals } from '@/server/services/pricing/compute-totals';
import { approveQuote, getQuoteDetail, reviseQuote } from '@/server/services/quotes/versioning';
import { seedId } from '../../../prisma/seed/ids';
import { createQuoteHarness, DAY, jobCtx, SEED_NOW, SERVICE_B, userCtx, WS_B, type QuoteHarness } from './support';

let h: QuoteHarness;

beforeAll(async () => {
  h = await createQuoteHarness('quote-seed');
});
afterAll(async () => {
  await h?.testDb.destroy();
});

const QUOTE_B = seedId('quote', 'ironpulse-fitness:Q-0001');

describe('seeded demo quote (workspace B)', () => {
  it('matches the server price computation and the createQuote row shape', async () => {
    const quote = await h.db.quote.findUniqueOrThrow({ where: { id: QUOTE_B }, include: { currentVersion: { include: { items: true } } } });
    expect(quote).toMatchObject({ workspaceId: WS_B, number: 'Q-0001', status: 'DRAFT', currentVersionNo: 1, needsPricingReview: false });
    const v = quote.currentVersion!;
    expect(quote.validUntil?.toISOString()).toBe(v.validUntil.toISOString());
    expect(v.validUntil.getTime() - v.createdAt.getTime()).toBe(7 * DAY);
    expect(v.createdAt.getTime()).toBeLessThan(SEED_NOW.getTime());

    const priced = await computeQuoteTotals(jobCtx(h, WS_B), { items: [{ serviceId: SERVICE_B, qty: 1 }], discount: { kind: 'NONE', value: 0n } });
    expect({ subtotal: v.subtotalPaise, discount: v.discountPaise, taxable: v.taxablePaise, tax: v.taxPaise, total: v.totalPaise }).toEqual({
      subtotal: priced.totals.subtotalPaise,
      discount: priced.totals.discountPaise,
      taxable: priced.totals.taxablePaise,
      tax: priced.totals.taxPaise,
      total: priced.totals.totalPaise,
    });
    const { computedAt: _ignored, ...snapshot } = priced.snapshot as Record<string, unknown>;
    expect(v.snapshot).toEqual(snapshot);
    expect(v.items.map((i) => [i.serviceId, i.qty, i.unitPricePaise, i.lineTotalPaise])).toEqual(priced.lines.map((l) => [l.serviceId, l.qty, l.unitPricePaise, l.lineTotalPaise]));

    expect(await h.db.approval.findMany({ where: { quoteId: QUOTE_B }, select: { status: true, quoteVersionId: true } })).toEqual([{ status: 'PENDING', quoteVersionId: v.id }]);
    expect((await h.db.auditEvent.findFirstOrThrow({ where: { targetId: QUOTE_B } })).action).toBe('quote.create');
  });

  it('works through the real services for its owner', async () => {
    const rohan = await userCtx(h.db, h.clock, 'rohan');
    expect((await getQuoteDetail(rohan, QUOTE_B)).timeline.map((t) => t.action)).toEqual(['quote.create']);
    const revised = await reviseQuote(rohan, QUOTE_B, { expectedVersion: 1, items: [{ serviceId: SERVICE_B, qty: 2 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'Two packs', timelineText: 'Twelve weeks' });
    expect(revised.version.versionNo).toBe(2);
    expect((await approveQuote(rohan, QUOTE_B, { expectedVersion: 2 })).quote.status).toBe('APPROVED');
  });
});

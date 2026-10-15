/**
 * T13 (AT5, R17): server-side quote pricing over the real catalog.
 *  - Prices come only from the pricing version; the totals persisted on a QuoteVersion and its
 *    QuoteItems (through the column mapping later tasks use) equal the pure §8 math, including
 *    the AT5 fixture 2 x ₹10,000, -10%, +18% = 2,124,000 paise.
 *  - A total above the ₹100 crore sanity cap routes to review.
 *  - A service with no price in the version sets needsPricingReview and is never priced at 0.
 *  - Quantities outside the entry's bounds are 422; a workspace B serviceId is 404.
 *  - Discount limits: service/workspace limit 422; above the actor's own cap 403 with a committed
 *    DENIED audit row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { DiscountLimitExceededError, PermissionDeniedError, PricingMissingError } from '@/lib/errors';
import { computeQuoteTotals as pureTotals, QUOTE_TOTAL_SANITY_CAP_PAISE } from '@/lib/money';
import type { AppCtx } from '@/server/auth/context';
import { createService, updateService } from '@/server/services/pricing/catalog';
import { computeQuoteTotals, quoteItemsData, quoteVersionPricingData } from '@/server/services/pricing/compute-totals';
import { updatePricingSettings } from '@/server/services/pricing/settings';
import { createTestDb, type TestDb } from '../../support/db';
import { NOW, seedIdentities, type Identity } from '../auth/support';
import { contextFor } from './support';

let testDb: TestDb;
let db: PrismaClient;
let ids: Identity;
let ownerCtx: AppCtx;
let employeeCtx: AppCtx;
const clock = new FixedClock(NOW);
const svc: Record<string, string> = {};

async function add(ctx: AppCtx, code: string, unitPricePaise: bigint, extra: { maxDiscountBps?: number | null; maxQty?: number } = {}) {
  const current = (await db.pricingVersion.findFirst({ where: { workspaceId: ids.workspaceAId, active: true } }))?.version ?? 0;
  const res = await createService(ctx, {
    code,
    name: `Service ${code}`,
    description: '',
    unitLabel: 'unit',
    defaultTimelineDays: null,
    maxDiscountBps: extra.maxDiscountBps ?? null,
    unitPricePaise,
    minQty: 1,
    maxQty: extra.maxQty ?? 10_000,
    expectedVersion: current,
  });
  svc[code] = res.service.id;
}

beforeAll(async () => {
  testDb = await createTestDb({ label: 'compute-totals' });
  db = testDb.client();
  ids = await seedIdentities(db, 'LIVE');
  // The employee may edit quotes in workspace A with a 5% personal cap and no pricing.override.
  await db.employeeAssignment.updateMany({
    where: { employeeUserId: ids.employeeId, workspaceId: ids.workspaceAId },
    data: { capabilities: ['leads.read', 'quotes.edit'], maxDiscountBps: 500 },
  });
  ownerCtx = await contextFor(db, clock, ids.ownerId, 'USER');
  employeeCtx = await contextFor(db, clock, ids.employeeId, 'EMPLOYEE', ids.workspaceAId);
  await updatePricingSettings(ownerCtx, { taxMode: 'CONFIGURED', taxLabel: 'GST', taxBps: 1800, maxDiscountBps: 1500 });
  await add(ownerCtx, 'SITE', 1_000_000n);
  await add(ownerCtx, 'ADS', 333n, { maxDiscountBps: 1000 });
  await add(ownerCtx, 'CAP', 99_999_999n, { maxQty: 10_000 });
});

afterAll(async () => {
  await testDb?.destroy();
});

describe('computeQuoteTotals', () => {
  it('AT5: 2 x ₹10,000, 10% off, 18% GST = 2,124,000 paise from the server price', async () => {
    const result = await computeQuoteTotals(ownerCtx, { items: [{ serviceId: svc.SITE!, qty: 2 }], discount: { kind: 'PERCENT_BPS', value: 1000n } });
    expect(result.lines).toEqual([
      expect.objectContaining({ serviceId: svc.SITE, serviceName: 'Service SITE', unitLabel: 'unit', qty: 2, unitPricePaise: 1_000_000n, lineTotalPaise: 2_000_000n, position: 0 }),
    ]);
    expect(result.totals).toEqual({ subtotalPaise: 2_000_000n, discountPaise: 200_000n, taxablePaise: 1_800_000n, taxPaise: 324_000n, totalPaise: 2_124_000n });
    expect(result.tax).toEqual({ mode: 'CONFIGURED', label: 'GST', bps: 1800 });
    expect(result.needsPricingReview).toBe(false);
    expect(result.reviewReasons).toEqual([]);
    expect(result.discountLimitBps).toBe(1500);
  });

  it('persisted QuoteVersion and QuoteItem totals equal the pure §8 math', async () => {
    const items = [
      { serviceId: svc.SITE!, qty: 3 },
      { serviceId: svc.ADS!, qty: 7 },
    ];
    const result = await computeQuoteTotals(ownerCtx, { items, discount: { kind: 'FLAT_PAISE', value: 12_345n } });
    const lead = await db.lead.create({
      data: { workspaceId: ids.workspaceAId, displayName: 'Totals Lead', nameNormalized: 'totals lead', alternatePhones: [], scoreReasons: [], unknownInputs: [], firstSource: 'MANUAL' },
    });
    const quote = await db.quote.create({ data: { workspaceId: ids.workspaceAId, leadId: lead.id, number: 'Q-0900', createdBy: ids.ownerId } });
    const version = await db.quoteVersion.create({
      data: {
        workspaceId: ids.workspaceAId,
        quoteId: quote.id,
        versionNo: 1,
        ...quoteVersionPricingData(result),
        scopeText: 'Scope',
        timelineText: 'Timeline',
        validUntil: new Date(clock.now().getTime() + 15 * 86_400_000),
        aiPolicyFlags: [],
        createdBy: ids.ownerId,
        items: { create: quoteItemsData(result) },
      },
      include: { items: { orderBy: { position: 'asc' } } },
    });

    const pure = pureTotals({
      lines: [
        { qty: 3, unitPricePaise: 1_000_000n },
        { qty: 7, unitPricePaise: 333n },
      ],
      discount: { kind: 'FLAT_PAISE', value: 12_345n },
      tax: { mode: 'CONFIGURED', bps: 1800 },
    });
    expect(version).toMatchObject({
      pricingVersionId: result.pricingVersion.id,
      discountKind: 'FLAT_PAISE',
      discountValue: 12_345n,
      taxLabel: 'GST',
      taxBps: 1800,
      subtotalPaise: pure.subtotalPaise,
      discountPaise: pure.discountPaise,
      taxablePaise: pure.taxablePaise,
      taxPaise: pure.taxPaise,
      totalPaise: pure.totalPaise,
    });
    expect(version.totalPaise).toBe(version.subtotalPaise - version.discountPaise + version.taxPaise);
    expect(version.items.map((i) => [i.serviceId, i.qty, i.unitPricePaise, i.lineTotalPaise, i.position, i.serviceNameSnapshot])).toEqual([
      [svc.SITE, 3, 1_000_000n, pure.lines[0]!.lineTotalPaise, 0, 'Service SITE'],
      [svc.ADS, 7, 333n, pure.lines[1]!.lineTotalPaise, 1, 'Service ADS'],
    ]);
    const snapshot = version.snapshot as { pricingVersion: number; services: Array<{ serviceId: string; unitPricePaise: string }>; rules: { taxMode: string; effectiveDiscountLimitBps: number } };
    expect(snapshot.pricingVersion).toBe(result.pricingVersion.version);
    expect(snapshot.services.find((s) => s.serviceId === svc.ADS)?.unitPricePaise).toBe('333');
    expect(snapshot.rules).toMatchObject({ taxMode: 'CONFIGURED', effectiveDiscountLimitBps: 1000 });
    expect(version.reviewReasons).toEqual([]);
  });

  it('a later catalog change does not change totals computed against the earlier version', async () => {
    const pinned = await db.pricingVersion.findFirstOrThrow({ where: { workspaceId: ids.workspaceAId, active: true } });
    await updateService(ownerCtx, svc.SITE!, { unitPricePaise: 1_100_000n, expectedVersion: pinned.version });
    const again = await computeQuoteTotals(ownerCtx, { items: [{ serviceId: svc.SITE!, qty: 1 }], discount: { kind: 'NONE', value: 0n }, pricingVersionId: pinned.id });
    expect(again.lines[0]?.unitPricePaise).toBe(1_000_000n);
    const current = await computeQuoteTotals(ownerCtx, { items: [{ serviceId: svc.SITE!, qty: 1 }], discount: { kind: 'NONE', value: 0n } });
    expect(current.lines[0]?.unitPricePaise).toBe(1_100_000n);
    expect(current.pricingVersion.version).toBe(pinned.version + 1);
  });

  it('a total above the ₹100 crore sanity cap routes to review', async () => {
    // 9,999 x ₹9,99,999.99 = 999,890,000,001 paise before tax.
    const result = await computeQuoteTotals(ownerCtx, { items: [{ serviceId: svc.CAP!, qty: 9_999 }], discount: { kind: 'NONE', value: 0n } });
    expect(result.lines[0]?.lineTotalPaise).toBe(9_999n * 99_999_999n);
    expect(result.totals.totalPaise > QUOTE_TOTAL_SANITY_CAP_PAISE).toBe(true);
    expect(result.needsPricingReview).toBe(true);
    expect(result.reviewReasons).toContainEqual(expect.objectContaining({ code: 'TOTAL_ABOVE_SANITY_CAP' }));
    const small = await computeQuoteTotals(ownerCtx, { items: [{ serviceId: svc.CAP!, qty: 1 }], discount: { kind: 'NONE', value: 0n } });
    expect(small.needsPricingReview).toBe(false);
  });

  it('a service with no price in the version sets needsPricingReview and is not priced', async () => {
    const unpriced = await db.service.create({ data: { workspaceId: ids.workspaceAId, code: 'NOPRICE', name: 'Unpriced', description: '', unitLabel: 'unit' } });
    const result = await computeQuoteTotals(ownerCtx, {
      items: [
        { serviceId: svc.SITE!, qty: 1 },
        { serviceId: unpriced.id, qty: 2 },
      ],
      discount: { kind: 'NONE', value: 0n },
    });
    expect(result.needsPricingReview).toBe(true);
    expect(result.reviewReasons).toContainEqual({ code: 'PRICE_MISSING', serviceId: unpriced.id });
    expect(result.lines.map((l) => l.serviceId)).toEqual([svc.SITE]);
    expect(result.unpriced).toEqual([{ serviceId: unpriced.id, serviceName: 'Unpriced', qty: 2, reason: 'PRICE_MISSING' }]);
    expect(result.totals.subtotalPaise).toBe(1_100_000n);
  });

  it('a workspace without any price list cannot be quoted (422 PRICING_MISSING)', async () => {
    const betaOwner = await db.user.create({ data: { email: 'owner@beta.test', name: 'beta owner', globalRole: 'USER' } });
    await db.membership.create({ data: { userId: betaOwner.id, workspaceId: ids.workspaceBId, role: 'OWNER' } });
    const betaCtx = await contextFor(db, clock, betaOwner.id, 'USER');
    const bare = await db.service.create({ data: { workspaceId: ids.workspaceBId, code: 'B1', name: 'Beta one', description: '', unitLabel: 'unit' } });
    await expect(computeQuoteTotals(betaCtx, { items: [{ serviceId: bare.id, qty: 1 }], discount: { kind: 'NONE', value: 0n } })).rejects.toBeInstanceOf(PricingMissingError);
  });

  it('quantities outside the price entry bounds are 422', async () => {
    for (const qty of [0, 10_001, 1.5]) {
      await expect(computeQuoteTotals(ownerCtx, { items: [{ serviceId: svc.SITE!, qty }], discount: { kind: 'NONE', value: 0n } })).rejects.toMatchObject({ status: 422, code: 'AMOUNT_INVALID' });
    }
  });

  it("a workspace B serviceId is 404, never priced", async () => {
    const foreign = await db.service.create({ data: { workspaceId: ids.workspaceBId, code: 'B2', name: 'Beta two', description: '', unitLabel: 'unit' } });
    await expect(computeQuoteTotals(ownerCtx, { items: [{ serviceId: foreign.id, qty: 1 }], discount: { kind: 'NONE', value: 0n } })).rejects.toMatchObject({ status: 404 });
  });

  it('TaxMode NONE yields zero tax and no tax label', async () => {
    await updatePricingSettings(ownerCtx, { taxMode: 'NONE' });
    const result = await computeQuoteTotals(ownerCtx, { items: [{ serviceId: svc.SITE!, qty: 1 }], discount: { kind: 'NONE', value: 0n } });
    expect(result.tax).toEqual({ mode: 'NONE', label: null, bps: null });
    expect(result.totals.taxPaise).toBe(0n);
    expect(quoteVersionPricingData(result)).toMatchObject({ taxLabel: null, taxBps: null });
    await updatePricingSettings(ownerCtx, { taxMode: 'CONFIGURED', taxLabel: 'GST', taxBps: 1800 });
  });
});

describe('discount limits against the catalog', () => {
  it("a line's service limit caps the whole quote: at the limit accepted, +1 bp 422", async () => {
    const items = [
      { serviceId: svc.SITE!, qty: 1 },
      { serviceId: svc.ADS!, qty: 1 },
    ];
    const ok = await computeQuoteTotals(ownerCtx, { items, discount: { kind: 'PERCENT_BPS', value: 1000n } });
    expect(ok.discountLimitBps).toBe(1000);
    await expect(computeQuoteTotals(ownerCtx, { items, discount: { kind: 'PERCENT_BPS', value: 1001n } })).rejects.toBeInstanceOf(DiscountLimitExceededError);
  });

  it("above the actor's own cap without pricing.override: 403 and a committed DENIED audit", async () => {
    const before = await db.auditEvent.count({ where: { action: 'pricing.discount.denied', result: 'DENIED' } });
    await expect(
      computeQuoteTotals(employeeCtx, { items: [{ serviceId: svc.SITE!, qty: 1 }], discount: { kind: 'PERCENT_BPS', value: 600n } }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    const denied = await db.auditEvent.findMany({ where: { action: 'pricing.discount.denied', result: 'DENIED' } });
    expect(denied).toHaveLength(before + 1);
    expect(denied.at(-1)).toMatchObject({ actorUserId: ids.employeeId, workspaceId: ids.workspaceAId, actorKind: 'EMPLOYEE' });
    expect(denied.at(-1)?.summary).toMatchObject({ requestedBps: 600, capBps: 500, limitBps: 1500 });

    const within = await computeQuoteTotals(employeeCtx, { items: [{ serviceId: svc.SITE!, qty: 1 }], discount: { kind: 'PERCENT_BPS', value: 500n } });
    expect(within.totals.discountPaise).toBe(55_000n);
  });

  it('the owner (pricing.override) may go above an employee cap up to the limit', async () => {
    const result = await computeQuoteTotals(ownerCtx, { items: [{ serviceId: svc.SITE!, qty: 1 }], discount: { kind: 'PERCENT_BPS', value: 1500n } });
    expect(result.totals.discountPaise).toBe(165_000n);
  });
});

/**
 * P16 / plan §6.1 expiry (T15): validUntil defaults to the workspace validity (15 days for the
 * dental clinic) and is copied onto the quote; APPROVED, SENT and VIEWED quotes become EXPIRED at
 * `now >= validUntil` (FixedClock at validUntil), by the sweeper job that version creation
 * schedules, while reads show the effective status without writing. Share links never outlive
 * validUntil, and EXPIRED does not depend on links. An expired quote is reissued by revising.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { createQuoteExpireSweepJob, QUOTE_EXPIRE_SWEEP_JOB } from '@/server/jobs/handlers/quote-expire-sweep';
import { createQuoteShare } from '@/server/services/quotes/share';
import { approveQuote, createQuote, effectiveQuoteStatus, expireDueQuotes, getQuoteDetail, listQuotes, reviseQuote } from '@/server/services/quotes/versioning';
import { createLead, createQuoteHarness, DAY, drain, jobCtx, NOW, ownerCtx, SERVICE, workerWith, WS_A, type QuoteHarness } from './support';

let h: QuoteHarness;
let db: PrismaClient;

beforeAll(async () => {
  h = await createQuoteHarness('quote-expiry');
  db = h.db;
});
afterAll(async () => {
  await h?.testDb.destroy();
});

const consult = { items: [{ serviceId: SERVICE.CONSULT, qty: 1 }], discount: { kind: 'NONE' as const, value: 0n }, scopeText: 'Consultation', timelineText: 'Same day' };

async function approvedQuote(validityDays?: number) {
  const ctx = await ownerCtx(h);
  const lead = await createLead(db);
  const created = await createQuote(ctx, { leadId: lead.id, ...consult, ...(validityDays ? { validityDays } : {}) });
  await approveQuote(ctx, created.quote.id, { expectedVersion: 1 });
  return { ctx, ...created };
}

describe('quote expiry (P16)', () => {
  it('validUntil defaults to the workspace validity and is copied to the quote; a custom validity is honored', async () => {
    h.clock.set(NOW);
    const { quote, version } = await approvedQuote();
    const expected = new Date(new Date(NOW).getTime() + 15 * DAY);
    expect(version.validUntil.toISOString()).toBe(expected.toISOString());
    expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).validUntil?.toISOString()).toBe(expected.toISOString());

    const custom = await approvedQuote(7);
    expect(custom.version.validUntil.toISOString()).toBe(new Date(new Date(NOW).getTime() + 7 * DAY).toISOString());

    const ctx = await ownerCtx(h);
    const lead = await createLead(db);
    await expect(createQuote(ctx, { leadId: lead.id, ...consult, validityDays: 0 })).rejects.toMatchObject({ status: 422, code: 'VALIDITY_INVALID' });
    await expect(createQuote(ctx, { leadId: lead.id, ...consult, validityDays: 366 })).rejects.toMatchObject({ status: 422, code: 'VALIDITY_INVALID' });
  });

  it('expires exactly at validUntil (not 1 ms before); reads show it before the sweep without writing', async () => {
    h.clock.set(NOW);
    const { ctx, quote, version } = await approvedQuote();
    const job = jobCtx(h);

    h.clock.set(new Date(version.validUntil.getTime() - 1));
    await expireDueQuotes(job);
    expect(await db.auditEvent.count({ where: { action: 'quote.expire', targetId: quote.id } })).toBe(0);
    expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).status).toBe('APPROVED');
    expect(effectiveQuoteStatus({ status: 'APPROVED', validUntil: version.validUntil }, h.clock.now())).toBe('APPROVED');

    h.clock.set(version.validUntil);
    expect(effectiveQuoteStatus({ status: 'APPROVED', validUntil: version.validUntil }, h.clock.now())).toBe('EXPIRED');
    const detail = await getQuoteDetail(ctx, quote.id);
    expect(detail.effectiveStatus).toBe('EXPIRED');
    expect((await listQuotes(ctx, {})).find((q) => q.id === quote.id)?.effectiveStatus).toBe('EXPIRED');
    expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).status).toBe('APPROVED');

    expect(await expireDueQuotes(job)).toBeGreaterThanOrEqual(1);
    expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).status).toBe('EXPIRED');
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'quote.expire', targetId: quote.id } });
    expect(audit).toMatchObject({ actorKind: 'WORKER', workspaceId: WS_A });
    expect(audit.summary).toMatchObject({ fromStatus: 'APPROVED', versionNo: 1 });
    // A second sweep finds nothing new for this quote.
    await expireDueQuotes(job);
    expect(await db.auditEvent.count({ where: { action: 'quote.expire', targetId: quote.id } })).toBe(1);
  });

  it('version creation schedules the sweeper; the worker expires SENT and VIEWED quotes but never DRAFT', async () => {
    h.clock.set(NOW);
    const sent = await approvedQuote();
    await db.quote.update({ where: { id: sent.quote.id }, data: { status: 'SENT', sentVia: 'MANUAL_LINK' } });
    const viewed = await approvedQuote();
    await db.quote.update({ where: { id: viewed.quote.id }, data: { status: 'VIEWED' } });
    const ctx = await ownerCtx(h);
    const draft = await createQuote(ctx, { leadId: (await createLead(db)).id, ...consult });

    const validUntil = sent.version.validUntil;
    const sweep = await db.job.findFirstOrThrow({ where: { type: QUOTE_EXPIRE_SWEEP_JOB, workspaceId: WS_A, status: 'QUEUED', runAt: { gte: validUntil } }, orderBy: { runAt: 'asc' } });
    expect(sweep.idempotencyKey).toMatch(/^quote-expiry:/);
    expect(sweep.runAt.getTime() - validUntil.getTime()).toBeLessThanOrEqual(60_000);

    const worker = workerWith(h, [createQuoteExpireSweepJob({ mode: () => 'demo' })]);
    h.clock.set(sweep.runAt);
    await drain(worker);
    expect((await db.job.findUniqueOrThrow({ where: { id: sweep.id } })).status).toBe('SUCCEEDED');
    expect((await db.quote.findUniqueOrThrow({ where: { id: sent.quote.id } })).status).toBe('EXPIRED');
    expect((await db.quote.findUniqueOrThrow({ where: { id: viewed.quote.id } })).status).toBe('EXPIRED');
    expect((await db.quote.findUniqueOrThrow({ where: { id: draft.quote.id } })).status).toBe('DRAFT');
    await expect(approveQuote(ctx, draft.quote.id, { expectedVersion: 1 })).rejects.toMatchObject({ status: 422, code: 'QUOTE_VALIDITY_PASSED' });
  });

  it('share expiresAt never exceeds validUntil, and expiry does not depend on links', async () => {
    h.clock.set(NOW);
    const { ctx, quote, version } = await approvedQuote();
    const full = await createQuoteShare(ctx, quote.id, {});
    expect(full.share.expiresAt.toISOString()).toBe(version.validUntil.toISOString());
    const long = await createQuoteShare(ctx, quote.id, { expiresInDays: 30 });
    expect(long.share.expiresAt.toISOString()).toBe(version.validUntil.toISOString());
    const short = await createQuoteShare(ctx, quote.id, { expiresInDays: 3 });
    expect(short.share.expiresAt.toISOString()).toBe(new Date(new Date(NOW).getTime() + 3 * DAY).toISOString());
    for (const s of await db.quoteShare.findMany({ where: { quoteId: quote.id } })) expect(s.expiresAt.getTime()).toBeLessThanOrEqual(version.validUntil.getTime());

    h.clock.set(version.validUntil);
    await expireDueQuotes(jobCtx(h));
    expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).status).toBe('EXPIRED');
    const shares = await db.quoteShare.findMany({ where: { quoteId: quote.id } });
    expect(shares).toHaveLength(3);
    for (const s of shares) expect(s).toMatchObject({ revokedAt: null, supersededAt: null });
    await expect(createQuoteShare(ctx, quote.id, {})).rejects.toMatchObject({ status: 422 });
  });

  it('an expired quote is reissued by revising: DRAFT v2 with a fresh validUntil', async () => {
    h.clock.set(NOW);
    const { ctx, quote, version } = await approvedQuote();
    h.clock.set(version.validUntil);
    await expireDueQuotes(jobCtx(h));
    h.clock.advance(DAY);
    const reissued = await reviseQuote(ctx, quote.id, { expectedVersion: 1, ...consult });
    expect(reissued.quote.status).toBe('DRAFT');
    expect(reissued.version.validUntil.toISOString()).toBe(new Date(h.clock.now().getTime() + 15 * DAY).toISOString());
    expect((await approveQuote(ctx, quote.id, { expectedVersion: 2 })).quote.status).toBe('APPROVED');
  });
});

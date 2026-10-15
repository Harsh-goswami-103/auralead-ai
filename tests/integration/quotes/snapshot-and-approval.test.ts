/**
 * AT6 / R18 (T15): a quote version is a snapshot. A catalog change after issue leaves the issued
 * items, prices and totals unchanged; approval is a CAS with an Approval row; a material edit of
 * an APPROVED quote creates version N+1 and, in the same transaction, invalidates the approval,
 * cancels QUEUED dispatch attempts as SUPERSEDED (and their jobs), and supersedes share links.
 * Also: creation from an AI proposal carries its policy flags to review; missing prices block
 * approval; foreign ids are 404; capabilities are enforced.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { createService, updateService } from '@/server/services/pricing/catalog';
import { createQuoteShare } from '@/server/services/quotes/share';
import { approveQuote, cancelQuote, createQuote, getQuoteDetail, reviseQuote } from '@/server/services/quotes/versioning';
import {
  auditActions,
  createDraft,
  createLead,
  createQuoteHarness,
  ownerCtx,
  queueDispatch,
  SERVICE,
  SERVICE_B,
  userCtx,
  WS_A,
  WS_B,
  WS_KESARI_SLUG,
  type QuoteHarness,
} from './support';

let h: QuoteHarness;
let db: PrismaClient;

beforeAll(async () => {
  h = await createQuoteHarness('quote-snapshot');
  db = h.db;
});
afterAll(async () => {
  await h?.testDb.destroy();
});

const SCOPE = 'Whitening course plus one root canal, as discussed on the call.';
const TIMELINE = 'Two visits within 10 days';

describe('quote snapshots and approval invalidation (AT6)', () => {
  it('persists v1 totals from server prices and keeps them when the catalog changes', async () => {
    const ctx = await ownerCtx(h);
    const lead = await createLead(db);
    // WHITEN 8,500 x 2 + RCT 6,500; effective discount limit = min(15%, 10%, 5%) = 5%.
    const created = await createQuote(ctx, {
      leadId: lead.id,
      items: [
        { serviceId: SERVICE.WHITEN, qty: 2 },
        { serviceId: SERVICE.RCT, qty: 1 },
      ],
      discount: { kind: 'PERCENT_BPS', value: 500n },
      scopeText: SCOPE,
      timelineText: TIMELINE,
    });
    expect(created.quote).toMatchObject({ status: 'DRAFT', number: 'Q-0001', currentVersionNo: 1, needsPricingReview: false });

    const v1 = await db.quoteVersion.findUniqueOrThrow({ where: { id: created.version.id }, include: { items: { orderBy: { position: 'asc' } } } });
    expect(v1).toMatchObject({
      versionNo: 1,
      subtotalPaise: 2_350_000n,
      discountPaise: 117_500n,
      taxablePaise: 2_232_500n,
      taxPaise: 401_850n,
      totalPaise: 2_634_350n,
      discountKind: 'PERCENT_BPS',
      discountValue: 500n,
      taxLabel: 'GST',
      taxBps: 1800,
      scopeText: SCOPE,
      timelineText: TIMELINE,
    });
    expect(v1.items.map((i) => [i.serviceNameSnapshot, i.qty, i.unitPricePaise, i.lineTotalPaise])).toEqual([
      ['Teeth whitening (in-clinic)', 2, 850_000n, 1_700_000n],
      ['Root canal treatment', 1, 650_000n, 650_000n],
    ]);
    expect((v1.snapshot as { pricingVersion: number }).pricingVersion).toBe(1);

    // Price change (publishes price list v2) and a rename (in place).
    await updateService(ctx, SERVICE.WHITEN, { unitPricePaise: 900_000n, expectedVersion: 1 });
    await updateService(ctx, SERVICE.WHITEN, { name: 'Laser whitening', expectedVersion: 2 });
    await createService(ctx, { code: 'SCALING', name: 'Scaling', description: '', unitLabel: 'visit', defaultTimelineDays: 1, maxDiscountBps: null, unitPricePaise: 150_000n, minQty: 1, maxQty: 2, expectedVersion: 2 });

    const after = await db.quoteVersion.findUniqueOrThrow({ where: { id: v1.id }, include: { items: { orderBy: { position: 'asc' } } } });
    expect(after.items.map((i) => [i.serviceNameSnapshot, i.unitPricePaise, i.lineTotalPaise])).toEqual([
      ['Teeth whitening (in-clinic)', 850_000n, 1_700_000n],
      ['Root canal treatment', 650_000n, 650_000n],
    ]);
    expect(after.totalPaise).toBe(2_634_350n);
    expect(after.snapshot).toEqual(v1.snapshot);

    const detail = await getQuoteDetail(ctx, created.quote.id);
    expect(detail.versions[0]!.items[0]!.serviceNameSnapshot).toBe('Teeth whitening (in-clinic)');
    expect(detail.versions[0]!.totalPaise).toBe(2_634_350n);
  });

  it('approve is a CAS that writes an APPROVED Approval row; a material edit then invalidates everything bound to v1', async () => {
    const ctx = await ownerCtx(h);
    const lead = await createLead(db);
    const { quote, version } = await createQuote(ctx, {
      leadId: lead.id,
      items: [{ serviceId: SERVICE.CONSULT, qty: 1 }],
      discount: { kind: 'NONE', value: 0n },
      scopeText: 'Consultation',
      timelineText: 'Same day',
    });
    const pending = await db.approval.findMany({ where: { quoteId: quote.id } });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'QUOTE_VERSION', status: 'PENDING', quoteVersionId: version.id });

    h.clock.advance(1_000);
    const approved = await approveQuote(ctx, quote.id, { expectedVersion: 1 });
    expect(approved.quote.status).toBe('APPROVED');
    const approval = await db.approval.findFirstOrThrow({ where: { quoteVersionId: version.id, status: 'APPROVED' } });
    expect(approval).toMatchObject({ kind: 'QUOTE_VERSION', quoteId: quote.id, decidedBy: ctx.actor!.userId });
    expect(approval.decidedAt?.toISOString()).toBe(h.clock.now().toISOString());

    h.clock.advance(1_000);
    const share = await createQuoteShare(ctx, quote.id, {});
    const queued = await queueDispatch(db, { leadId: lead.id, quoteVersionId: version.id, approvalId: approval.id, tag: 'material-edit' });
    const sending = await queueDispatch(db, { leadId: (await createLead(db)).id, quoteVersionId: version.id, approvalId: approval.id, tag: 'in-flight' });
    await db.dispatchAttempt.update({ where: { id: sending.attempt.id }, data: { state: 'SENDING' } });

    h.clock.advance(60_000);
    const revised = await reviseQuote(ctx, quote.id, {
      expectedVersion: 1,
      items: [{ serviceId: SERVICE.CONSULT, qty: 2 }],
      discount: { kind: 'NONE', value: 0n },
      scopeText: 'Consultation for two family members',
      timelineText: 'Same day',
    });
    expect(revised.quote).toMatchObject({ status: 'DRAFT', currentVersionNo: 2, currentVersionId: revised.version.id });
    expect(revised.version.versionNo).toBe(2);
    expect(revised.invalidated).toEqual({ approvals: 1, dispatchAttempts: 1, shares: 1 });

    expect(await db.approval.findUniqueOrThrow({ where: { id: approval.id } })).toMatchObject({ status: 'INVALIDATED', invalidationReason: 'QUOTE_REVISED' });
    expect(await db.dispatchAttempt.findUniqueOrThrow({ where: { id: queued.attempt.id } })).toMatchObject({ state: 'CANCELLED', reasonCode: 'SUPERSEDED' });
    expect(await db.job.findUniqueOrThrow({ where: { id: queued.job.id } })).toMatchObject({ status: 'CANCELLED' });
    // An attempt already SENDING is in flight; it is never touched (C8: settle decides, E6).
    expect(await db.dispatchAttempt.findUniqueOrThrow({ where: { id: sending.attempt.id } })).toMatchObject({ state: 'SENDING' });
    expect(await db.quoteShare.findUniqueOrThrow({ where: { id: share.share.id } })).toMatchObject({ revokedAt: null });
    expect((await db.quoteShare.findUniqueOrThrow({ where: { id: share.share.id } })).supersededAt).not.toBeNull();

    // v1 is untouched; v2 has its own PENDING approval.
    const v1 = await db.quoteVersion.findUniqueOrThrow({ where: { id: version.id }, include: { items: true } });
    expect(v1.items.map((i) => i.qty)).toEqual([1]);
    const v2Approvals = await db.approval.findMany({ where: { quoteVersionId: revised.version.id } });
    expect(v2Approvals.map((a) => a.status)).toEqual(['PENDING']);

    const actions = (await auditActions(db, quote.id)).map((a) => a.action);
    expect(actions).toEqual(['quote.create', 'quote.approve', 'quote.share.create', 'quote.revise']);
    const reviseAudit = (await auditActions(db, quote.id)).find((a) => a.action === 'quote.revise')!;
    expect(reviseAudit.summary).toMatchObject({ fromStatus: 'APPROVED', versionNo: 2, invalidatedApprovals: 1, cancelledDispatchAttempts: 1, supersededShares: 1 });
    expect(reviseAudit.correlationId).toBe(ctx.correlationId);
  });

  it('a revision keeps the price list of the version it revises unless asked to re-price', async () => {
    const ctx = await ownerCtx(h);
    const lead = await createLead(db);
    const pinned = await db.pricingVersion.findFirstOrThrow({ where: { workspaceId: WS_A, active: true } });
    const { quote } = await createQuote(ctx, { leadId: lead.id, items: [{ serviceId: SERVICE.WHITEN, qty: 1 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'Whitening', timelineText: '1 day' });
    await updateService(ctx, SERVICE.WHITEN, { unitPricePaise: 950_000n, expectedVersion: pinned.version });

    const kept = await reviseQuote(ctx, quote.id, { expectedVersion: 1, items: [{ serviceId: SERVICE.WHITEN, qty: 2 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'Whitening x2', timelineText: '1 day' });
    expect(kept.version.pricingVersionId).toBe(pinned.id);
    expect(kept.version.subtotalPaise).toBe(1_800_000n);

    const repriced = await reviseQuote(ctx, quote.id, { expectedVersion: 2, items: [{ serviceId: SERVICE.WHITEN, qty: 2 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'Whitening x2', timelineText: '1 day', repriceToActive: true });
    expect(repriced.version.pricingVersionId).not.toBe(pinned.id);
    expect(repriced.version.subtotalPaise).toBe(1_900_000n);
  });

  it('a quote created from an AI proposal carries the policy flags and proposal review reasons to the approver', async () => {
    const ctx = await ownerCtx(h);
    const lead = await createLead(db);
    const draft = await createDraft(db, lead.id, {
      items: [{ serviceId: SERVICE.WHITEN, qty: 1 }],
      flags: ['ai_price_ignored'],
      reviewReasons: [{ code: 'UNKNOWN_SERVICE', position: 1 }],
    });
    const { quote, version } = await createQuote(ctx, {
      leadId: lead.id,
      draftId: draft.id,
      items: [{ serviceId: SERVICE.WHITEN, qty: 1 }],
      discount: { kind: 'NONE', value: 0n },
      scopeText: 'Whitening course with review visit.',
      timelineText: 'Two weeks',
    });
    const v1 = await db.quoteVersion.findUniqueOrThrow({ where: { id: version.id } });
    expect(v1.aiPolicyFlags).toEqual(['ai_price_ignored']);
    expect(v1.reviewReasons).toEqual([{ code: 'UNKNOWN_SERVICE', position: 1, source: 'ai_proposal' }]);
    // Server price, never anything from the draft.
    expect(v1.subtotalPaise).toBeGreaterThan(0n);
    expect(quote.needsPricingReview).toBe(false);
    const approval = await db.approval.findFirstOrThrow({ where: { quoteVersionId: version.id } });
    expect(approval.flags).toEqual(['ai_price_ignored']);
    const audit = (await auditActions(db, quote.id))[0]!;
    expect(audit.summary).toMatchObject({ fromDraft: true, aiPolicyFlags: ['ai_price_ignored'] });

    // A draft of another lead cannot be used.
    const other = await createLead(db);
    await expect(
      createQuote(ctx, { leadId: other.id, draftId: draft.id, items: [{ serviceId: SERVICE.WHITEN, qty: 1 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'x', timelineText: 'y' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('a line without a price sets needsPricingReview, and approval is refused until a revision fixes it', async () => {
    const ctx = await ownerCtx(h);
    const lead = await createLead(db);
    const active = await db.pricingVersion.findFirstOrThrow({ where: { workspaceId: WS_A, active: true }, include: { entries: true } });
    // A service with no entry in the active price list.
    const orphan = await db.service.create({ data: { workspaceId: WS_A, code: 'NOPRICE', name: 'Unpriced service', description: '', unitLabel: 'unit' } });
    expect(active.entries.some((e) => e.serviceId === orphan.id)).toBe(false);

    const { quote } = await createQuote(ctx, {
      leadId: lead.id,
      items: [
        { serviceId: SERVICE.CONSULT, qty: 1 },
        { serviceId: orphan.id, qty: 1 },
      ],
      discount: { kind: 'NONE', value: 0n },
      scopeText: 'Consult',
      timelineText: 'Today',
    });
    expect(quote.needsPricingReview).toBe(true);
    const v1 = await db.quoteVersion.findFirstOrThrow({ where: { quoteId: quote.id }, include: { items: true } });
    expect(v1.items).toHaveLength(1);
    expect(v1.reviewReasons).toEqual([{ code: 'PRICE_MISSING', serviceId: orphan.id }]);

    await expect(approveQuote(ctx, quote.id, { expectedVersion: 1 })).rejects.toMatchObject({ status: 422, code: 'PRICING_REVIEW_REQUIRED' });
    const fixed = await reviseQuote(ctx, quote.id, { expectedVersion: 1, items: [{ serviceId: SERVICE.CONSULT, qty: 1 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'Consult', timelineText: 'Today' });
    expect(fixed.quote.needsPricingReview).toBe(false);
    expect((await approveQuote(ctx, quote.id, { expectedVersion: 2 })).quote.status).toBe('APPROVED');
  });

  it('cancel revokes shares, invalidates approvals and cancels queued sends', async () => {
    const ctx = await ownerCtx(h);
    const lead = await createLead(db);
    const { quote, version } = await createQuote(ctx, { leadId: lead.id, items: [{ serviceId: SERVICE.CONSULT, qty: 1 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'Consult', timelineText: 'Today' });
    await approveQuote(ctx, quote.id, { expectedVersion: 1 });
    const share = await createQuoteShare(ctx, quote.id, {});
    const approval = await db.approval.findFirstOrThrow({ where: { quoteVersionId: version.id, status: 'APPROVED' } });
    const queued = await queueDispatch(db, { leadId: lead.id, quoteVersionId: version.id, approvalId: approval.id, tag: 'cancel' });

    const cancelled = await cancelQuote(ctx, quote.id, { expectedVersion: 1 });
    expect(cancelled.quote.status).toBe('CANCELLED');
    expect((await db.quoteShare.findUniqueOrThrow({ where: { id: share.share.id } })).revokedAt).not.toBeNull();
    expect(await db.approval.findUniqueOrThrow({ where: { id: approval.id } })).toMatchObject({ status: 'INVALIDATED', invalidationReason: 'QUOTE_CANCELLED' });
    expect(await db.dispatchAttempt.findUniqueOrThrow({ where: { id: queued.attempt.id } })).toMatchObject({ state: 'CANCELLED', reasonCode: 'QUOTE_CANCELLED' });
    await expect(cancelQuote(ctx, quote.id, { expectedVersion: 1 })).rejects.toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
  });

  it('a share token is shown once and only its sha256 is stored', async () => {
    const ctx = await ownerCtx(h);
    const lead = await createLead(db);
    const { quote } = await createQuote(ctx, { leadId: lead.id, items: [{ serviceId: SERVICE.CONSULT, qty: 1 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'Consult', timelineText: 'Today' });
    await expect(createQuoteShare(ctx, quote.id, {})).rejects.toMatchObject({ status: 422, code: 'QUOTE_NOT_SHAREABLE' });
    await approveQuote(ctx, quote.id, { expectedVersion: 1 });
    const { token, share } = await createQuoteShare(ctx, quote.id, {});
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await db.quoteShare.findUniqueOrThrow({ where: { id: share.id } });
    expect(row.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    const everything = JSON.stringify(await db.quoteShare.findMany()) + JSON.stringify(await db.auditEvent.findMany({ where: { targetId: quote.id } }));
    expect(everything).not.toContain(token);
  });

  it('foreign ids are 404 and capabilities are enforced', async () => {
    const ctx = await ownerCtx(h);
    const foreignLead = await createLead(db, WS_B);
    await expect(
      createQuote(ctx, { leadId: foreignLead.id, items: [{ serviceId: SERVICE.CONSULT, qty: 1 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'x', timelineText: 'y' }),
    ).rejects.toMatchObject({ status: 404 });
    const lead = await createLead(db);
    await expect(
      createQuote(ctx, { leadId: lead.id, items: [{ serviceId: SERVICE_B, qty: 1 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'x', timelineText: 'y' }),
    ).rejects.toMatchObject({ status: 404 });

    // Workspace B's quote is invisible to A's owner.
    const ownerB = await userCtx(db, h.clock, 'rohan');
    const leadB = await createLead(db, WS_B);
    const quoteB = await createQuote(ownerB, { leadId: leadB.id, items: [{ serviceId: SERVICE_B, qty: 1 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'PT', timelineText: '6 weeks' });
    await expect(getQuoteDetail(ctx, quoteB.quote.id)).rejects.toMatchObject({ status: 404 });
    await expect(approveQuote(ctx, quoteB.quote.id, { expectedVersion: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(reviseQuote(ctx, quoteB.quote.id, { expectedVersion: 1, items: [{ serviceId: SERVICE.CONSULT, qty: 1 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'x', timelineText: 'y' })).rejects.toMatchObject({ status: 404 });

    // A MEMBER edits quotes but cannot approve (approvals.decide is the owner's).
    const member = await userCtx(db, h.clock, 'pooja', WS_KESARI_SLUG);
    const kesariService = await db.service.findFirstOrThrow({ where: { workspaceId: member.workspaceId! } });
    const kesariLead = await createLead(db, member.workspaceId!);
    const kq = await createQuote(member, { leadId: kesariLead.id, items: [{ serviceId: kesariService.id, qty: 1 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'Order', timelineText: '1 week' });
    await expect(approveQuote(member, kq.quote.id, { expectedVersion: 1 })).rejects.toMatchObject({ status: 403 });
    expect((await db.quote.findUniqueOrThrow({ where: { id: kq.quote.id } })).status).toBe('DRAFT');
  });
});

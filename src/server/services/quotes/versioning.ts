/**
 * Quote lifecycle (T15, plan §5.4, §6.1, §8, AT6, P16). The only writer of Quote, QuoteVersion
 * and QuoteItem rows.
 *
 *  - A version is a snapshot: prices come from the server price list (`computeQuoteTotals`, never
 *    from the input), and the lines, totals, tax and pricing rules are persisted on the version and
 *    never recomputed. A catalog change after issue changes nothing that was issued.
 *  - Create gives DRAFT v1. Every edit (items, quantities, discount, scope, timeline, validity)
 *    gives version N+1 and moves the quote to DRAFT, CAS-guarded by the version number the editor
 *    saw (`expectedVersion`, 409 when stale). In the same transaction the material edit releases
 *    everything bound to the old version: open approvals are INVALIDATED, QUEUED dispatch attempts
 *    are CANCELLED(`SUPERSEDED`) with their jobs, and open share links are superseded.
 *    A revision keeps the price list of the version it revises unless `repriceToActive`.
 *  - Approve is a CAS on `status = DRAFT AND currentVersionNo = expected`, refused while
 *    `needsPricingReview` (a line without a price, a total above the sanity cap) or once the
 *    version's validity has passed; it turns the version's PENDING Approval into APPROVED.
 *  - Cancel (DRAFT/APPROVED/SENT/VIEWED) revokes links, invalidates approvals, cancels queued sends.
 *  - Expiry: APPROVED, SENT and VIEWED quotes become EXPIRED at `now >= validUntil`. Each version
 *    schedules the `quote.expireSweep` job for its validity; reads show the effective status
 *    before the sweep runs, without writing.
 * Every mutation is one immediate transaction with its AuditEvent (targetType Quote), which is
 * also the quote's state timeline.
 */
import type { DiscountKind, Prisma, PrismaClient, Quote, QuoteItem, QuoteStatus, QuoteVersion } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { ConflictError, DomainRuleError, NotFoundError, QuoteVersionConflictError } from '@/lib/errors';
import { idempotencyKey } from '@/lib/ids';
import type { DiscountInput } from '@/lib/money';
import { serializePaise } from '@/lib/money';
import { QUOTE_MAX_LINES, QUOTE_TEXT_LIMITS, QUOTE_VALIDITY_DAYS } from '@/lib/schemas/quotes';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { assertSameWorkspace, type ScopedTx } from '@/server/db/scoped';
import { withTx } from '@/server/db/tx';
import { enqueueJob, type JobStore } from '@/server/jobs/queue';
import type { TxClient } from '@/server/jobs/types';
import { approveQuoteVersionApproval, invalidateQuoteApprovals, openQuoteVersionApproval, type InvalidationReason } from '@/server/services/approvals/quote-approvals';
import { recordAudit } from '@/server/services/audit/record';
import { computeQuoteTotals, quoteItemsData, quoteVersionPricingData, type ComputedQuote, type QuoteLineRequest } from '@/server/services/pricing/compute-totals';
import { readPricingSettings } from '@/server/services/pricing/settings';
import { enqueueQuoteRenderPdf } from '@/server/pdf/artifacts';
import { readDocumentSnapshot, withDocumentSnapshot, type DocumentSnapshot } from './render-model';
import { revokeQuoteShares, supersedeQuoteShares } from './share';
import { EXPIRING_STATUSES, nextQuoteStatus, revisionTrigger } from './state-machine';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export const QUOTE_EXPIRE_SWEEP_JOB = 'quote.expireSweep';
export const QUOTE_EXPIRY_KEY_PREFIX = 'quote-expiry';

/** AI proposal review reasons carried onto a quote created from a draft (plan §8: unknown ids go to review). */
const PROPOSAL_REASON_CODES = new Set(['UNKNOWN_SERVICE', 'QTY_OUT_OF_BOUNDS', 'DUPLICATE_SERVICE', 'NO_ITEMS']);

// ---- Inputs and validation -----------------------------------------------------------------------

export type QuoteContentInput = {
  items: readonly QuoteLineRequest[];
  discount: DiscountInput;
  scopeText: string;
  timelineText: string;
  /** Days from now until the version lapses; defaults to the workspace's quote validity. */
  validityDays?: number;
};
export type CreateQuoteInput = QuoteContentInput & { leadId: string; draftId?: string | null };
export type ReviseQuoteInput = QuoteContentInput & { expectedVersion: number; repriceToActive?: boolean };

type Content = { items: QuoteLineRequest[]; discount: DiscountInput; scopeText: string; timelineText: string; validityDays: number | undefined };

const rule = (code: string, userMessage: string, field: string) => new DomainRuleError({ code, userMessage, safeDetails: { field } });

export function validateQuoteContent(input: QuoteContentInput): Content {
  const scopeText = input.scopeText.trim();
  const timelineText = input.timelineText.trim();
  if (scopeText.length < 1 || scopeText.length > QUOTE_TEXT_LIMITS.scope) {
    throw rule('QUOTE_SCOPE_INVALID', `Describe the scope of work (1 to ${QUOTE_TEXT_LIMITS.scope} characters).`, 'scopeText');
  }
  if (timelineText.length < 1 || timelineText.length > QUOTE_TEXT_LIMITS.timeline) {
    throw rule('QUOTE_TIMELINE_INVALID', `Give a timeline (1 to ${QUOTE_TEXT_LIMITS.timeline} characters).`, 'timelineText');
  }
  if (input.items.length < 1 || input.items.length > QUOTE_MAX_LINES) {
    throw rule('QUOTE_LINES_INVALID', `A quote has 1 to ${QUOTE_MAX_LINES} services.`, 'items');
  }
  const seen = new Set<string>();
  for (const item of input.items) {
    if (seen.has(item.serviceId)) throw rule('DUPLICATE_SERVICE_LINE', 'Each service can appear once; change its quantity instead.', 'items');
    seen.add(item.serviceId);
  }
  const days = input.validityDays;
  if (days !== undefined && (!Number.isInteger(days) || days < QUOTE_VALIDITY_DAYS.min || days > QUOTE_VALIDITY_DAYS.max)) {
    throw rule('VALIDITY_INVALID', `Quote validity must be ${QUOTE_VALIDITY_DAYS.min} to ${QUOTE_VALIDITY_DAYS.max} days.`, 'validityDays');
  }
  return { items: input.items.map((i) => ({ serviceId: i.serviceId, qty: i.qty })), discount: input.discount, scopeText, timelineText, validityDays: days };
}

// ---- Status ---------------------------------------------------------------------------------------

/** The status a reader should see: APPROVED/SENT/VIEWED past validUntil read as EXPIRED before the sweep runs. */
export function effectiveQuoteStatus(quote: { status: QuoteStatus; validUntil: Date | null }, now: Date): QuoteStatus {
  if (quote.validUntil !== null && EXPIRING_STATUSES.includes(quote.status) && now.getTime() >= quote.validUntil.getTime()) return 'EXPIRED';
  return quote.status;
}

const versionConflict = (current: number, expected: number) =>
  new QuoteVersionConflictError({
    userMessage: `This quote is now at version ${current}. Reload to see it before you continue.`,
    safeDetails: { currentVersion: current, expectedVersion: expected },
  });

// ---- Expiry scheduling ------------------------------------------------------------------------------

/**
 * Schedules the expiry sweep for a validity deadline: one job per workspace and UTC minute
 * (`quote-expiry:<workspaceId>:<minute>`), run at the end of that minute so every quote due in it
 * has lapsed. Duplicates collapse on the idempotency key.
 */
export async function enqueueQuoteExpirySweep(db: JobStore, clock: Clock, input: { workspaceId: string; dueAt: Date; correlationId: string; causationId?: string | null }) {
  const minuteStart = Math.floor(input.dueAt.getTime() / MINUTE_MS) * MINUTE_MS;
  const bucket = new Date(minuteStart).toISOString().slice(0, 16);
  return enqueueJob(db, clock, {
    type: QUOTE_EXPIRE_SWEEP_JOB,
    payload: { dueAt: new Date(minuteStart + MINUTE_MS).toISOString() },
    workspaceId: input.workspaceId,
    idempotencyKey: idempotencyKey(QUOTE_EXPIRY_KEY_PREFIX, input.workspaceId, bucket),
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    runAt: new Date(minuteStart + MINUTE_MS),
    kind: 'default',
  });
}

// ---- Shared write steps ---------------------------------------------------------------------------

type VersionWrite = {
  quoteId: string;
  versionNo: number;
  priced: ComputedQuote;
  content: Content;
  validUntil: Date;
  aiPolicyFlags: string[];
  extraReviewReasons: Prisma.InputJsonValue[];
  /** T16: sender, recipient and branding facts the quote document prints (render-model.ts). */
  document: DocumentSnapshot;
};

async function writeVersion(tx: ScopedTx, ctx: AppCtx, w: VersionWrite): Promise<QuoteVersion> {
  const pricing = quoteVersionPricingData(w.priced);
  return tx.quoteVersion.create({
    data: {
      workspaceId: requireWorkspace(ctx),
      quoteId: w.quoteId,
      versionNo: w.versionNo,
      ...pricing,
      snapshot: withDocumentSnapshot(pricing.snapshot, w.document),
      reviewReasons: [...(pricing.reviewReasons as Prisma.InputJsonValue[]), ...w.extraReviewReasons],
      scopeText: w.content.scopeText,
      timelineText: w.content.timelineText,
      validUntil: w.validUntil,
      aiPolicyFlags: w.aiPolicyFlags,
      createdBy: ctx.actor?.userId ?? `system:${ctx.kind}`,
      createdAt: ctx.clock.now(),
      items: { create: quoteItemsData(w.priced) },
    },
  });
}

const approvalFlags = (aiPolicyFlags: readonly string[], needsPricingReview: boolean) => [...aiPolicyFlags, ...(needsPricingReview ? ['needs_pricing_review'] : [])];

type Released = { approvals: number; dispatchAttempts: number; shares: number };

/**
 * Releases everything bound to the quote's versions: open approvals INVALIDATED, QUEUED dispatch
 * attempts CANCELLED with their jobs (an attempt already SENDING is in flight and left to its
 * settle, E6), and share links superseded (revision) or revoked (cancel).
 */
async function releaseBoundWork(tx: ScopedTx, ctx: AppCtx, quoteId: string, mode: { approvals: InvalidationReason; attempts: string; shares: 'supersede' | 'revoke' }): Promise<Released> {
  const now = ctx.clock.now();
  const versionIds = (await tx.quoteVersion.findMany({ where: { quoteId }, select: { id: true } })).map((v) => v.id);
  const approvals = await invalidateQuoteApprovals(tx, ctx, { quoteId, versionIds, reason: mode.approvals });

  const queued = await tx.dispatchAttempt.findMany({ where: { quoteVersionId: { in: versionIds }, state: 'QUEUED' }, select: { id: true, jobId: true, messageId: true } });
  let dispatchAttempts = 0;
  if (queued.length > 0) {
    const cancelled = await tx.dispatchAttempt.updateMany({ where: { id: { in: queued.map((a) => a.id) }, state: 'QUEUED' }, data: { state: 'CANCELLED', reasonCode: mode.attempts } });
    dispatchAttempts = cancelled.count;
    const jobIds = [...new Set(queued.map((a) => a.jobId))];
    await tx.job.updateMany({ where: { id: { in: jobIds }, status: 'QUEUED' }, data: { status: 'CANCELLED', finishedAt: now, updatedAt: now } });
    await tx.job.updateMany({ where: { id: { in: jobIds }, status: 'RUNNING', cancelRequestedAt: null }, data: { cancelRequestedAt: now, updatedAt: now } });
    await tx.message.updateMany({ where: { id: { in: queued.map((a) => a.messageId) }, status: 'PENDING' }, data: { status: 'NOT_SENT' } });
  }
  const shares = mode.shares === 'supersede' ? await supersedeQuoteShares(tx, quoteId, now) : await revokeQuoteShares(tx, quoteId, now);
  return { approvals, dispatchAttempts, shares };
}

async function nextQuoteNumber(tx: ScopedTx): Promise<string> {
  let n = (await tx.quote.count()) + 1;
  for (;;) {
    const number = `Q-${String(n).padStart(4, '0')}`;
    if ((await tx.quote.count({ where: { number } })) === 0) return number;
    n += 1;
  }
}

async function loadQuote(tx: ScopedTx, ctx: AppCtx, quoteId: string): Promise<Quote> {
  await assertSameWorkspace(tx, ctx, { quoteId });
  const quote = await tx.quote.findFirst({ where: { id: quoteId } });
  if (!quote || quote.currentVersionId === null) throw new NotFoundError();
  return quote;
}

function validUntilFrom(now: Date, days: number): Date {
  return new Date(now.getTime() + days * DAY_MS);
}

// ---- Mutations ------------------------------------------------------------------------------------

export type QuoteWriteResult = { quote: Quote; version: QuoteVersion };

export async function createQuote(ctx: AppCtx, input: CreateQuoteInput): Promise<QuoteWriteResult> {
  requireCapability(ctx, 'quotes.edit');
  const workspaceId = requireWorkspace(ctx);
  const content = validateQuoteContent(input);
  await assertSameWorkspace(ctx.db, ctx, { leadId: input.leadId });
  const lead = await ctx.db.lead.findFirst({ where: { id: input.leadId }, select: { id: true, mergedIntoLeadId: true } });
  if (!lead) throw new NotFoundError();
  if (lead.mergedIntoLeadId !== null) throw rule('LEAD_MERGED', 'This lead was merged into another lead. Quote the remaining lead instead.', 'leadId');

  let aiPolicyFlags: string[] = [];
  let proposalReasons: Prisma.InputJsonValue[] = [];
  if (input.draftId) {
    const draft = await ctx.db.aiDraft.findFirst({ where: { id: input.draftId, leadId: input.leadId }, select: { aiPolicyFlags: true, reviewReasons: true } });
    if (!draft) throw new NotFoundError({ message: 'draft not found for this lead' });
    aiPolicyFlags = Array.isArray(draft.aiPolicyFlags) ? draft.aiPolicyFlags.filter((f): f is string => typeof f === 'string') : [];
    proposalReasons = (Array.isArray(draft.reviewReasons) ? draft.reviewReasons : [])
      .filter((r): r is Prisma.JsonObject => typeof r === 'object' && r !== null && !Array.isArray(r) && PROPOSAL_REASON_CODES.has(String((r as Prisma.JsonObject).code)))
      .map((r) => ({ ...r, source: 'ai_proposal' }));
  }

  // Outside the transaction: server pricing (it may commit a DENIED audit for an over-cap discount).
  const priced = await computeQuoteTotals(ctx, { items: content.items, discount: content.discount, auditTarget: { type: 'Lead', id: input.leadId } });
  const settings = await readPricingSettings(ctx.db);

  return withTx(ctx.db, async (tx) => {
    await assertSameWorkspace(tx, ctx, { leadId: input.leadId, serviceId: content.items.map((i) => i.serviceId), pricingVersionId: priced.pricingVersion.id });
    const now = ctx.clock.now();
    const validUntil = validUntilFrom(now, content.validityDays ?? settings.quoteValidityDays);
    const number = await nextQuoteNumber(tx);
    const created = await tx.quote.create({
      data: { workspaceId, leadId: input.leadId, number, status: 'DRAFT', createdBy: ctx.actor?.userId ?? `system:${ctx.kind}`, createdAt: now, updatedAt: now },
    });
    const document = await readDocumentSnapshot(tx as unknown as PrismaClient, { workspaceId, leadId: input.leadId });
    const version = await writeVersion(tx, ctx, { quoteId: created.id, versionNo: 1, priced, content, validUntil, aiPolicyFlags, extraReviewReasons: proposalReasons, document });
    const quote = await tx.quote.update({
      where: { id: created.id },
      data: { currentVersionId: version.id, currentVersionNo: 1, validUntil, needsPricingReview: priced.needsPricingReview, updatedAt: now },
    });
    await openQuoteVersionApproval(tx, ctx, { quoteId: quote.id, quoteVersionId: version.id, flags: approvalFlags(aiPolicyFlags, priced.needsPricingReview) });
    await recordAudit(tx, ctx, {
      action: 'quote.create',
      targetType: 'Quote',
      targetId: quote.id,
      summary: {
        number,
        versionNo: 1,
        lines: priced.lines.length,
        unpriced: priced.unpriced.length,
        needsPricingReview: priced.needsPricingReview,
        pricingVersion: priced.pricingVersion.version,
        fromDraft: Boolean(input.draftId),
        aiPolicyFlags,
      },
    });
    await enqueueQuoteExpirySweep(tx as unknown as JobStore, ctx.clock, { workspaceId, dueAt: validUntil, correlationId: ctx.correlationId });
    // T16: every new version gets its PDF rendered by the worker (C1).
    await enqueueQuoteRenderPdf(tx as unknown as JobStore, ctx.clock, { workspaceId, quoteVersionId: version.id, correlationId: ctx.correlationId });
    return { quote, version };
  });
}

export async function reviseQuote(ctx: AppCtx, quoteId: string, input: ReviseQuoteInput): Promise<QuoteWriteResult & { invalidated: Released }> {
  requireCapability(ctx, 'quotes.edit');
  const workspaceId = requireWorkspace(ctx);
  const content = validateQuoteContent(input);
  // Early checks for a clear answer before pricing; all of them are repeated inside the transaction.
  const current = await loadQuote(ctx.db, ctx, quoteId);
  nextQuoteStatus(current.status, revisionTrigger(current.status));
  if (current.currentVersionNo !== input.expectedVersion) throw versionConflict(current.currentVersionNo, input.expectedVersion);
  const currentVersion = await ctx.db.quoteVersion.findFirst({ where: { id: current.currentVersionId! }, select: { pricingVersionId: true, aiPolicyFlags: true } });
  if (!currentVersion) throw new NotFoundError();

  const priced = await computeQuoteTotals(ctx, {
    items: content.items,
    discount: content.discount,
    ...(input.repriceToActive ? {} : { pricingVersionId: currentVersion.pricingVersionId }),
    auditTarget: { type: 'Quote', id: quoteId },
  });
  const settings = await readPricingSettings(ctx.db);
  const aiPolicyFlags = Array.isArray(currentVersion.aiPolicyFlags) ? currentVersion.aiPolicyFlags.filter((f): f is string => typeof f === 'string') : [];

  return withTx(ctx.db, async (tx) => {
    const quote = await loadQuote(tx, ctx, quoteId);
    const from = quote.status;
    if (quote.currentVersionNo !== input.expectedVersion) throw versionConflict(quote.currentVersionNo, input.expectedVersion);
    const to = nextQuoteStatus(from, revisionTrigger(from));
    await assertSameWorkspace(tx, ctx, { serviceId: content.items.map((i) => i.serviceId), pricingVersionId: priced.pricingVersion.id });

    const now = ctx.clock.now();
    const versionNo = quote.currentVersionNo + 1;
    const validUntil = validUntilFrom(now, content.validityDays ?? settings.quoteValidityDays);
    const invalidated = await releaseBoundWork(tx, ctx, quoteId, { approvals: 'QUOTE_REVISED', attempts: 'SUPERSEDED', shares: 'supersede' });
    const document = await readDocumentSnapshot(tx as unknown as PrismaClient, { workspaceId, leadId: quote.leadId });
    const version = await writeVersion(tx, ctx, { quoteId, versionNo, priced, content, validUntil, aiPolicyFlags, extraReviewReasons: [], document });
    const cas = await tx.quote.updateMany({
      where: { id: quoteId, status: from, currentVersionNo: input.expectedVersion },
      data: { status: to, currentVersionId: version.id, currentVersionNo: versionNo, validUntil, needsPricingReview: priced.needsPricingReview, sentVia: null, updatedAt: now },
    });
    if (cas.count !== 1) throw versionConflict(quote.currentVersionNo, input.expectedVersion);
    await openQuoteVersionApproval(tx, ctx, { quoteId, quoteVersionId: version.id, flags: approvalFlags(aiPolicyFlags, priced.needsPricingReview) });
    await recordAudit(tx, ctx, {
      action: 'quote.revise',
      targetType: 'Quote',
      targetId: quoteId,
      summary: {
        fromStatus: from,
        versionNo,
        lines: priced.lines.length,
        unpriced: priced.unpriced.length,
        needsPricingReview: priced.needsPricingReview,
        pricingVersion: priced.pricingVersion.version,
        repriced: Boolean(input.repriceToActive),
        invalidatedApprovals: invalidated.approvals,
        cancelledDispatchAttempts: invalidated.dispatchAttempts,
        supersededShares: invalidated.shares,
      },
    });
    await enqueueQuoteExpirySweep(tx as unknown as JobStore, ctx.clock, { workspaceId, dueAt: validUntil, correlationId: ctx.correlationId });
    // T16: every new version gets its PDF rendered by the worker (C1).
    await enqueueQuoteRenderPdf(tx as unknown as JobStore, ctx.clock, { workspaceId, quoteVersionId: version.id, correlationId: ctx.correlationId });
    const updated = await tx.quote.findFirstOrThrow({ where: { id: quoteId } });
    return { quote: updated, version, invalidated };
  });
}

export async function approveQuote(ctx: AppCtx, quoteId: string, input: { expectedVersion: number }): Promise<QuoteWriteResult & { approvalId: string }> {
  requireCapability(ctx, 'approvals.decide');
  return withTx(ctx.db, async (tx) => {
    const quote = await loadQuote(tx, ctx, quoteId);
    if (quote.currentVersionNo !== input.expectedVersion) throw versionConflict(quote.currentVersionNo, input.expectedVersion);
    const to = nextQuoteStatus(quote.status, 'APPROVE');
    if (quote.needsPricingReview) {
      throw new DomainRuleError({
        code: 'PRICING_REVIEW_REQUIRED',
        userMessage: 'This version needs a pricing review (a service without a price or a total above the limit). Revise it before approving.',
        safeDetails: { versionNo: quote.currentVersionNo },
      });
    }
    const now = ctx.clock.now();
    if (quote.validUntil === null || now.getTime() >= quote.validUntil.getTime()) {
      throw new DomainRuleError({ code: 'QUOTE_VALIDITY_PASSED', userMessage: 'This version is past its validity date. Revise it to set a new one.', safeDetails: { versionNo: quote.currentVersionNo } });
    }
    const cas = await tx.quote.updateMany({ where: { id: quoteId, status: 'DRAFT', currentVersionNo: input.expectedVersion }, data: { status: to, updatedAt: now } });
    if (cas.count !== 1) throw versionConflict(quote.currentVersionNo, input.expectedVersion);
    const version = await tx.quoteVersion.findFirstOrThrow({ where: { id: quote.currentVersionId! } });
    const flags = Array.isArray(version.aiPolicyFlags) ? version.aiPolicyFlags.filter((f): f is string => typeof f === 'string') : [];
    const approval = await approveQuoteVersionApproval(tx, ctx, { quoteId, quoteVersionId: version.id, flags });
    await recordAudit(tx, ctx, { action: 'quote.approve', targetType: 'Quote', targetId: quoteId, summary: { versionNo: version.versionNo, approvalId: approval.id } });
    const updated = await tx.quote.findFirstOrThrow({ where: { id: quoteId } });
    return { quote: updated, version, approvalId: approval.id };
  });
}

export async function cancelQuote(ctx: AppCtx, quoteId: string, input: { expectedVersion: number }): Promise<{ quote: Quote; released: Released }> {
  requireCapability(ctx, 'quotes.edit');
  return withTx(ctx.db, async (tx) => {
    const quote = await loadQuote(tx, ctx, quoteId);
    if (quote.currentVersionNo !== input.expectedVersion) throw versionConflict(quote.currentVersionNo, input.expectedVersion);
    const to = nextQuoteStatus(quote.status, 'CANCEL');
    const now = ctx.clock.now();
    const cas = await tx.quote.updateMany({ where: { id: quoteId, status: quote.status, currentVersionNo: input.expectedVersion }, data: { status: to, updatedAt: now } });
    if (cas.count !== 1) throw new ConflictError();
    const released = await releaseBoundWork(tx, ctx, quoteId, { approvals: 'QUOTE_CANCELLED', attempts: 'QUOTE_CANCELLED', shares: 'revoke' });
    await recordAudit(tx, ctx, {
      action: 'quote.cancel',
      targetType: 'Quote',
      targetId: quoteId,
      summary: { fromStatus: quote.status, versionNo: quote.currentVersionNo, invalidatedApprovals: released.approvals, cancelledDispatchAttempts: released.dispatchAttempts, revokedShares: released.shares },
    });
    return { quote: await tx.quote.findFirstOrThrow({ where: { id: quoteId } }), released };
  });
}

/**
 * Moves every APPROVED, SENT or VIEWED quote of the context's workspace whose validUntil has
 * passed (`now >= validUntil`) to EXPIRED, one CAS and one `quote.expire` audit row each. Takes
 * the caller's transaction (the sweep job's fenced settle) or opens one. Returns the count.
 */
export async function expireDueQuotesIn(tx: TxClient, ctx: AppCtx): Promise<number> {
  const workspaceId = requireWorkspace(ctx);
  const now = ctx.clock.now();
  const due = await tx.quote.findMany({
    where: { workspaceId, status: { in: [...EXPIRING_STATUSES] }, validUntil: { lte: now } },
    select: { id: true, status: true, currentVersionNo: true },
  });
  let expired = 0;
  for (const q of due) {
    const to = nextQuoteStatus(q.status, 'EXPIRE');
    const cas = await tx.quote.updateMany({ where: { id: q.id, workspaceId, status: q.status, validUntil: { lte: now } }, data: { status: to, updatedAt: now } });
    if (cas.count !== 1) continue;
    expired += 1;
    await recordAudit(tx, ctx, { action: 'quote.expire', targetType: 'Quote', targetId: q.id, workspaceId, summary: { fromStatus: q.status, versionNo: q.currentVersionNo } });
  }
  return expired;
}

export async function expireDueQuotes(ctx: AppCtx): Promise<number> {
  return withTx(ctx.db, (tx) => expireDueQuotesIn(tx as unknown as TxClient, ctx));
}

// ---- Reads -------------------------------------------------------------------------------------------

export type QuoteListRow = {
  id: string;
  number: string;
  status: QuoteStatus;
  effectiveStatus: QuoteStatus;
  lead: { id: string; displayName: string };
  currentVersionNo: number;
  totalPaise: bigint | null;
  validUntil: Date | null;
  needsPricingReview: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export const QUOTE_LIST_LIMIT = 200;

export async function listQuotes(ctx: AppCtx, input: { status?: QuoteStatus }): Promise<QuoteListRow[]> {
  requireWorkspace(ctx);
  const now = ctx.clock.now();
  const rows = await ctx.db.quote.findMany({
    where: input.status ? { status: input.status } : {},
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: QUOTE_LIST_LIMIT,
    include: { lead: { select: { id: true, displayName: true } }, currentVersion: { select: { totalPaise: true } } },
  });
  return rows.map((q) => ({
    id: q.id,
    number: q.number,
    status: q.status,
    effectiveStatus: effectiveQuoteStatus(q, now),
    lead: q.lead,
    currentVersionNo: q.currentVersionNo,
    totalPaise: q.currentVersion?.totalPaise ?? null,
    validUntil: q.validUntil,
    needsPricingReview: q.needsPricingReview,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
  }));
}

export type QuoteTimelineEntry = { id: string; action: string; actorName: string | null; actorKind: string; result: string; createdAt: Date; summary: Prisma.JsonValue };

export type QuoteDetail = {
  quote: Quote;
  effectiveStatus: QuoteStatus;
  lead: { id: string; displayName: string; category: string | null; city: string | null };
  workspace: { name: string; timezone: string };
  versions: Array<QuoteVersion & { items: QuoteItem[]; createdByName: string | null }>;
  approvals: Array<{ id: string; quoteVersionId: string | null; status: string; flags: Prisma.JsonValue; requestedAt: Date; decidedAt: Date | null; decidedByName: string | null; invalidationReason: string | null }>;
  shares: Array<{ id: string; quoteVersionId: string; expiresAt: Date; revokedAt: Date | null; supersededAt: Date | null; createdAt: Date; createdBy: string }>;
  timeline: QuoteTimelineEntry[];
  activePricingVersion: { id: string; version: number } | null;
  permissions: { canEdit: boolean; canApprove: boolean; canShare: boolean };
};

export async function getQuoteDetail(ctx: AppCtx, quoteId: string): Promise<QuoteDetail> {
  const workspaceId = requireWorkspace(ctx);
  const db = ctx.db;
  // The scoped client adds the workspace to the filter: another workspace's quote is simply not found (404).
  const quote = await db.quote.findFirst({ where: { id: quoteId } });
  if (!quote) throw new NotFoundError();
  const [lead, workspace, versions, approvals, shares, timeline, active] = await Promise.all([
    db.lead.findFirstOrThrow({ where: { id: quote.leadId }, select: { id: true, displayName: true, category: true, city: true } }),
    db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true, timezone: true } }),
    db.quoteVersion.findMany({ where: { quoteId }, orderBy: { versionNo: 'desc' }, include: { items: { orderBy: { position: 'asc' } } } }),
    db.approval.findMany({ where: { quoteId }, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }] }),
    db.quoteShare.findMany({ where: { quoteId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    db.auditEvent.findMany({ where: { targetType: 'Quote', targetId: quoteId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    db.pricingVersion.findFirst({ where: { active: true }, select: { id: true, version: true } }),
  ]);
  const userIds = [...new Set([...versions.map((v) => v.createdBy), ...approvals.map((a) => a.decidedBy ?? ''), ...timeline.map((t) => t.actorUserId ?? '')].filter((x) => x.length > 0))];
  const users = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  return {
    quote,
    effectiveStatus: effectiveQuoteStatus(quote, ctx.clock.now()),
    lead,
    workspace,
    versions: versions.map((v) => ({ ...v, createdByName: nameOf.get(v.createdBy) ?? null })),
    approvals: approvals.map((a) => ({
      id: a.id,
      quoteVersionId: a.quoteVersionId,
      status: a.status,
      flags: a.flags,
      requestedAt: a.requestedAt,
      decidedAt: a.decidedAt,
      decidedByName: a.decidedBy ? (nameOf.get(a.decidedBy) ?? null) : null,
      invalidationReason: a.invalidationReason,
    })),
    shares: shares.map((s) => ({ id: s.id, quoteVersionId: s.quoteVersionId, expiresAt: s.expiresAt, revokedAt: s.revokedAt, supersededAt: s.supersededAt, createdAt: s.createdAt, createdBy: s.createdBy })),
    timeline: timeline.map((t) => ({
      id: t.id,
      action: t.action,
      actorName: t.actorUserId ? (nameOf.get(t.actorUserId) ?? null) : null,
      actorKind: t.actorKind,
      result: t.result,
      createdAt: t.createdAt,
      summary: t.summary,
    })),
    activePricingVersion: active,
    permissions: { canEdit: hasCapability(ctx, 'quotes.edit'), canApprove: hasCapability(ctx, 'approvals.decide'), canShare: hasCapability(ctx, 'dispatch.send') },
  };
}

/** What the quote editor offers: services priced in the active list, plus the limits it must respect. */
export type QuoteEditorCatalog = {
  activePricingVersion: { id: string; version: number } | null;
  services: Array<{ id: string; code: string; name: string; unitLabel: string; unitPricePaise: bigint; minQty: number; maxQty: number; maxDiscountBps: number | null }>;
  settings: { maxDiscountBps: number; quoteValidityDays: number; taxMode: string; taxLabel: string | null; taxBps: number | null };
  actorMaxDiscountBps: number | null;
};

export async function getQuoteEditorCatalog(ctx: AppCtx): Promise<QuoteEditorCatalog> {
  requireWorkspace(ctx);
  const active = await ctx.db.pricingVersion.findFirst({ where: { active: true }, include: { entries: true } });
  const settings = await readPricingSettings(ctx.db);
  const services = active ? await ctx.db.service.findMany({ where: { id: { in: active.entries.map((e) => e.serviceId) }, archivedAt: null }, orderBy: { code: 'asc' } }) : [];
  const entryOf = new Map((active?.entries ?? []).map((e) => [e.serviceId, e]));
  return {
    activePricingVersion: active ? { id: active.id, version: active.version } : null,
    services: services.map((s) => {
      const e = entryOf.get(s.id)!;
      return { id: s.id, code: s.code, name: s.name, unitLabel: s.unitLabel, unitPricePaise: e.unitPricePaise, minQty: e.minQty, maxQty: e.maxQty, maxDiscountBps: s.maxDiscountBps };
    }),
    settings: { maxDiscountBps: settings.maxDiscountBps, quoteValidityDays: settings.quoteValidityDays, taxMode: settings.taxMode, taxLabel: settings.taxLabel, taxBps: settings.taxBps },
    actorMaxDiscountBps: hasCapability(ctx, 'pricing.override') ? null : ctx.maxDiscountBps,
  };
}

export type NewQuoteSources = {
  leads: Array<{ id: string; displayName: string; city: string | null; category: string | null }>;
  selectedLeadId: string | null;
  draft: { id: string; createdAt: Date; generatorLabel: string; status: string; aiPolicyFlags: string[]; items: QuoteLineRequest[]; scopeText: string | null; timelineText: string | null } | null;
};

export const NEW_QUOTE_LEAD_LIMIT = 100;

/** Leads to quote and, for the chosen lead, its newest draft that carries a proposal ("new from proposal"). */
export async function getNewQuoteSources(ctx: AppCtx, input: { leadId?: string | null; draftId?: string | null }): Promise<NewQuoteSources> {
  requireWorkspace(ctx);
  const leads = await ctx.db.lead.findMany({
    where: { mergedIntoLeadId: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: NEW_QUOTE_LEAD_LIMIT,
    select: { id: true, displayName: true, city: true, category: true },
  });
  let selectedLeadId: string | null = null;
  if (input.leadId) {
    const lead = await ctx.db.lead.findFirst({ where: { id: input.leadId, mergedIntoLeadId: null }, select: { id: true, displayName: true, city: true, category: true } });
    if (lead) {
      selectedLeadId = lead.id;
      if (!leads.some((l) => l.id === lead.id)) leads.unshift(lead);
    }
  }
  let draft: NewQuoteSources['draft'] = null;
  if (selectedLeadId) {
    // JSON columns are never filtered on (plan §5): read the newest drafts and take the first with a proposal.
    const rows = await ctx.db.aiDraft.findMany({
      where: { leadId: selectedLeadId, ...(input.draftId ? { id: input.draftId } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10,
    });
    const row = rows.find((r) => r.proposal !== null && typeof r.proposal === 'object' && Array.isArray((r.proposal as { items?: unknown }).items));
    const proposal = row?.proposal as { items: QuoteLineRequest[]; scopeText?: string | null; timelineText?: string | null } | undefined;
    if (row && proposal) {
      draft = {
        id: row.id,
        createdAt: row.createdAt,
        generatorLabel: row.generatorLabel,
        status: row.status,
        aiPolicyFlags: Array.isArray(row.aiPolicyFlags) ? row.aiPolicyFlags.filter((f): f is string => typeof f === 'string') : [],
        items: proposal.items.map((i) => ({ serviceId: String(i.serviceId), qty: Number(i.qty) })),
        scopeText: proposal.scopeText ?? null,
        timelineText: proposal.timelineText ?? null,
      };
    }
  }
  return { leads, selectedLeadId, draft };
}

// ---- DTOs (money as paise strings, times as ISO) ------------------------------------------------

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function serializeQuote(q: Quote, now: Date) {
  return {
    id: q.id,
    number: q.number,
    leadId: q.leadId,
    status: q.status,
    effectiveStatus: effectiveQuoteStatus(q, now),
    currentVersionId: q.currentVersionId,
    currentVersionNo: q.currentVersionNo,
    needsPricingReview: q.needsPricingReview,
    sentVia: q.sentVia,
    validUntil: iso(q.validUntil),
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
  };
}

export function serializeVersion(v: QuoteVersion & { items?: QuoteItem[]; createdByName?: string | null }) {
  return {
    id: v.id,
    versionNo: v.versionNo,
    pricingVersionId: v.pricingVersionId,
    snapshot: v.snapshot,
    scopeText: v.scopeText,
    timelineText: v.timelineText,
    discountKind: v.discountKind as DiscountKind,
    discountValue: v.discountValue.toString(),
    taxLabel: v.taxLabel,
    taxBps: v.taxBps,
    subtotalPaise: serializePaise(v.subtotalPaise),
    discountPaise: serializePaise(v.discountPaise),
    taxablePaise: serializePaise(v.taxablePaise),
    taxPaise: serializePaise(v.taxPaise),
    totalPaise: serializePaise(v.totalPaise),
    validUntil: v.validUntil.toISOString(),
    sentAt: iso(v.sentAt),
    aiPolicyFlags: v.aiPolicyFlags,
    reviewReasons: v.reviewReasons,
    createdAt: v.createdAt.toISOString(),
    createdByName: v.createdByName ?? null,
    items: (v.items ?? []).map((i) => ({
      id: i.id,
      serviceId: i.serviceId,
      serviceNameSnapshot: i.serviceNameSnapshot,
      unitLabel: i.unitLabel,
      qty: i.qty,
      unitPricePaise: serializePaise(i.unitPricePaise),
      lineTotalPaise: serializePaise(i.lineTotalPaise),
      position: i.position,
    })),
  };
}

export function serializeListRow(r: QuoteListRow) {
  return { ...r, totalPaise: r.totalPaise === null ? null : serializePaise(r.totalPaise), validUntil: iso(r.validUntil), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

export function serializeDetail(d: QuoteDetail, now: Date) {
  return {
    quote: serializeQuote(d.quote, now),
    effectiveStatus: d.effectiveStatus,
    lead: d.lead,
    workspace: d.workspace,
    versions: d.versions.map(serializeVersion),
    approvals: d.approvals.map((a) => ({ ...a, requestedAt: a.requestedAt.toISOString(), decidedAt: iso(a.decidedAt) })),
    shares: d.shares.map((s) => ({
      id: s.id,
      quoteVersionId: s.quoteVersionId,
      state: s.revokedAt ? 'REVOKED' : s.supersededAt ? 'SUPERSEDED' : now.getTime() >= s.expiresAt.getTime() ? 'EXPIRED' : 'ACTIVE',
      expiresAt: s.expiresAt.toISOString(),
      revokedAt: iso(s.revokedAt),
      supersededAt: iso(s.supersededAt),
      createdAt: s.createdAt.toISOString(),
    })),
    timeline: d.timeline.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })),
    activePricingVersion: d.activePricingVersion,
    permissions: d.permissions,
  };
}

export function serializeCatalog(c: QuoteEditorCatalog) {
  return { ...c, services: c.services.map((s) => ({ ...s, unitPricePaise: serializePaise(s.unitPricePaise) })) };
}

export type QuoteDetailDto = ReturnType<typeof serializeDetail>;
export type QuoteListRowDto = ReturnType<typeof serializeListRow>;
export type QuoteEditorCatalogDto = ReturnType<typeof serializeCatalog>;
export type QuoteVersionDto = ReturnType<typeof serializeVersion>;

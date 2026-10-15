/**
 * Manual sharing of a quotation (T22, P15, plan §6.1 "APPROVED -> SENT ... 'Copy link' / 'Mark as
 * sent manually', sentVia = MANUAL_LINK"). When the business hands the quotation over itself (the
 * copied share link, or the PDF through its own channel), the quote moves APPROVED -> SENT through
 * the state machine, so DRAFT, EXPIRED and every other status answer 409 INVALID_TRANSITION, and a
 * stale version answers 409. In the same transaction: the current version's `sentAt`, the lead's
 * sales stage forward to QUOTE_SENT (never backwards), and one `quote.send` audit with
 * `via = MANUAL_LINK`. A repeat on a quote that is already SENT or VIEWED is a no-op (no second
 * audit), so a second "Copy link" click is harmless.
 *
 * `loadQuoteShareEvidence` is the share panel's view evidence (C4): browser opens counted from the
 * page beacon (link previews and bots never count), link fetches, and whether a link was opened
 * while the quote was not yet marked sent (the "Mark as sent?" hint, ADR-57). Opens never claim a
 * person read the quotation.
 */
import type { Quote } from '@/generated/prisma/client';
import { NotFoundError, QuoteVersionConflictError } from '@/lib/errors';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { assertSameWorkspace } from '@/server/db/scoped';
import { withTx } from '@/server/db/tx';
import { recordAudit } from '@/server/services/audit/record';
import { nextQuoteStatus } from './state-machine';
import { effectiveQuoteStatus } from './versioning';

export type ManualSendTrigger = 'COPY_LINK' | 'MARK_SENT';

const STAGES_BEFORE_QUOTE_SENT = ['NEW', 'CONTACTED', 'REPLIED'] as const;

export async function markQuoteSentManually(ctx: AppCtx, quoteId: string, input: { expectedVersion: number; via: ManualSendTrigger }): Promise<{ quote: Quote; changed: boolean }> {
  requireCapability(ctx, 'dispatch.send');
  const workspaceId = requireWorkspace(ctx);
  return withTx(ctx.db, async (tx) => {
    await assertSameWorkspace(tx, ctx, { quoteId });
    const quote = await tx.quote.findFirst({ where: { id: quoteId } });
    if (!quote || quote.currentVersionId === null) throw new NotFoundError();
    if (quote.currentVersionNo !== input.expectedVersion) {
      throw new QuoteVersionConflictError({ safeDetails: { currentVersion: quote.currentVersionNo, expectedVersion: input.expectedVersion } });
    }
    const now = ctx.clock.now();
    const status = effectiveQuoteStatus(quote, now);
    // Already handed over (by a dispatch, an earlier click or a view): nothing to record again.
    if (status === 'SENT' || status === 'VIEWED') return { quote, changed: false };
    const to = nextQuoteStatus(status, 'SEND');

    const cas = await tx.quote.updateMany({
      where: { id: quote.id, status: 'APPROVED', currentVersionNo: input.expectedVersion },
      data: { status: to, sentVia: 'MANUAL_LINK', updatedAt: now },
    });
    if (cas.count !== 1) throw new QuoteVersionConflictError();
    await tx.quoteVersion.updateMany({ where: { id: quote.currentVersionId, sentAt: null }, data: { sentAt: now } });
    await tx.lead.updateMany({
      where: { id: quote.leadId, salesStage: { in: [...STAGES_BEFORE_QUOTE_SENT] } },
      data: { salesStage: 'QUOTE_SENT', stageVersion: { increment: 1 } },
    });
    await recordAudit(tx, ctx, {
      action: 'quote.send',
      targetType: 'Quote',
      targetId: quote.id,
      workspaceId,
      simulated: ctx.mode === 'demo',
      summary: { versionNo: quote.currentVersionNo, via: 'MANUAL_LINK', trigger: input.via },
    });
    return { quote: await tx.quote.findFirstOrThrow({ where: { id: quote.id } }), changed: true };
  });
}

export type QuoteShareEvidence = {
  /** Page beacons from a browser or an unknown agent (link previews and bots excluded). */
  opens: number;
  lastOpenAt: Date | null;
  /** Plain page loads of any agent (a preview bot counts here, never as an open). */
  fetches: number;
  /** A link was opened while the quote was still APPROVED (not yet marked sent). */
  openedWhileUnsent: boolean;
};

export async function loadQuoteShareEvidence(ctx: AppCtx, quoteId: string): Promise<QuoteShareEvidence> {
  requireWorkspace(ctx);
  const quote = await ctx.db.quote.findFirst({ where: { id: quoteId }, select: { id: true } });
  if (!quote) throw new NotFoundError();
  const shares = await ctx.db.quoteShare.findMany({ where: { quoteId }, select: { id: true } });
  const shareIds = shares.map((s) => s.id);
  if (shareIds.length === 0) return { opens: 0, lastOpenAt: null, fetches: 0, openedWhileUnsent: false };
  const openWhere = { quoteShareId: { in: shareIds }, kind: 'BEACON' as const, uaClass: { in: ['BROWSER' as const, 'UNKNOWN' as const] } };
  const [opens, last, fetches, unsent] = await Promise.all([
    ctx.db.quoteViewEvent.count({ where: openWhere }),
    ctx.db.quoteViewEvent.findFirst({ where: openWhere, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ctx.db.quoteViewEvent.count({ where: { quoteShareId: { in: shareIds }, kind: 'FETCH' } }),
    ctx.db.auditEvent.count({ where: { action: 'quote.view.unsent', targetType: 'Quote', targetId: quoteId } }),
  ]);
  return { opens, lastOpenAt: last?.createdAt ?? null, fetches, openedWhileUnsent: unsent > 0 };
}

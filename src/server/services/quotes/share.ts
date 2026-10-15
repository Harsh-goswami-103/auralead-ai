/**
 * Quote share links (T15, C2, C3, P16). A share credential is 32 random bytes (base64url); only
 * its sha256 is stored (`QuoteShare.tokenHash`), and the token is returned exactly once, to the
 * caller that created it. It is bound to the quote's current version.
 *
 *  - Created only for an APPROVED, SENT or VIEWED quote that is still within its validity.
 *    Creating a link never changes the quote's state (plan §6.1: "creating a share link alone
 *    does not transition"; "Copy link / Mark as sent" is the explicit SENT step, T22).
 *  - `expiresAt` is at most the version's validUntil (P16): the default is validUntil, a shorter
 *    `expiresInDays` is honored, a longer one is clamped.
 *  - Revoke sets `revokedAt` (the public page answers 404, C3). A new version supersedes every
 *    open link (`supersededAt`, 410) and cancel revokes them; both happen in the versioning
 *    transaction through `supersedeQuoteShares` / `revokeQuoteShares`.
 *  - Quote expiry does not touch links: EXPIRED is a property of the quote (P16).
 * The public read, view beacon and accept are T16's (`/quote/[token]`).
 */
import type { QuoteShare } from '@/generated/prisma/client';
import { DomainRuleError, NotFoundError } from '@/lib/errors';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { assertSameWorkspace, type ScopedTx } from '@/server/db/scoped';
import { withTx } from '@/server/db/tx';
import { generateToken } from '@/server/security/tokens';
import { recordAudit } from '@/server/services/audit/record';
import { EXPIRING_STATUSES } from './state-machine';

const DAY_MS = 86_400_000;

export type QuoteShareView = Pick<QuoteShare, 'id' | 'quoteId' | 'quoteVersionId' | 'expiresAt' | 'revokedAt' | 'supersededAt' | 'createdAt' | 'createdBy'>;

const view = (s: QuoteShare): QuoteShareView => ({
  id: s.id,
  quoteId: s.quoteId,
  quoteVersionId: s.quoteVersionId,
  expiresAt: s.expiresAt,
  revokedAt: s.revokedAt,
  supersededAt: s.supersededAt,
  createdAt: s.createdAt,
  createdBy: s.createdBy,
});

/** The public URL of a share token (`/quote/[token]`, served by T16). */
export function quoteShareUrl(appOrigin: string, token: string): string {
  return `${appOrigin.replace(/\/+$/, '')}/quote/${token}`;
}

/** P16: a link never outlives the quote's validity. */
export function shareExpiry(now: Date, validUntil: Date, expiresInDays?: number): Date {
  if (expiresInDays === undefined) return validUntil;
  const requested = new Date(now.getTime() + expiresInDays * DAY_MS);
  return requested.getTime() < validUntil.getTime() ? requested : validUntil;
}

export async function createQuoteShare(ctx: AppCtx, quoteId: string, input: { expiresInDays?: number }): Promise<{ share: QuoteShareView; token: string }> {
  requireCapability(ctx, 'dispatch.send');
  const workspaceId = requireWorkspace(ctx);
  if (input.expiresInDays !== undefined && (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1)) {
    throw new DomainRuleError({ code: 'SHARE_EXPIRY_INVALID', userMessage: 'A link must stay valid for at least one day.', safeDetails: { field: 'expiresInDays' } });
  }
  return withTx(ctx.db, async (tx) => {
    await assertSameWorkspace(tx, ctx, { quoteId });
    const quote = await tx.quote.findFirst({ where: { id: quoteId } });
    if (!quote || quote.currentVersionId === null || quote.validUntil === null) throw new NotFoundError();
    const now = ctx.clock.now();
    if (!EXPIRING_STATUSES.includes(quote.status) || now.getTime() >= quote.validUntil.getTime()) {
      throw new DomainRuleError({
        code: 'QUOTE_NOT_SHAREABLE',
        userMessage:
          quote.status === 'DRAFT'
            ? 'Approve this quote before sharing it.'
            : 'Only an approved, sent or viewed quote within its validity can be shared. Revise it to issue a new version.',
        safeDetails: { status: quote.status },
      });
    }
    const { token, tokenHash } = generateToken();
    const share = await tx.quoteShare.create({
      data: {
        workspaceId,
        quoteId,
        quoteVersionId: quote.currentVersionId,
        tokenHash,
        expiresAt: shareExpiry(now, quote.validUntil, input.expiresInDays),
        createdBy: ctx.actor?.userId ?? `system:${ctx.kind}`,
        createdAt: now,
      },
    });
    await recordAudit(tx, ctx, {
      action: 'quote.share.create',
      targetType: 'Quote',
      targetId: quoteId,
      summary: { shareId: share.id, versionNo: quote.currentVersionNo, expiresAt: share.expiresAt.toISOString() },
    });
    return { share: view(share), token };
  });
}

export async function revokeQuoteShare(ctx: AppCtx, quoteId: string, shareId: string): Promise<{ share: QuoteShareView; changed: boolean }> {
  requireCapability(ctx, 'dispatch.send');
  return withTx(ctx.db, async (tx) => {
    await assertSameWorkspace(tx, ctx, { quoteId });
    const share = await tx.quoteShare.findFirst({ where: { id: shareId, quoteId } });
    if (!share) throw new NotFoundError();
    if (share.revokedAt !== null) return { share: view(share), changed: false };
    const updated = await tx.quoteShare.update({ where: { id: share.id }, data: { revokedAt: ctx.clock.now() } });
    await recordAudit(tx, ctx, { action: 'quote.share.revoke', targetType: 'Quote', targetId: quoteId, summary: { shareId } });
    return { share: view(updated), changed: true };
  });
}

/** A new version supersedes every open link of the quote (410 on the public page). */
export async function supersedeQuoteShares(tx: ScopedTx, quoteId: string, now: Date): Promise<number> {
  const r = await tx.quoteShare.updateMany({ where: { quoteId, revokedAt: null, supersededAt: null }, data: { supersededAt: now } });
  return r.count;
}

/** Cancel revokes every link of the quote that is not already revoked (404 on the public page, C3). */
export async function revokeQuoteShares(tx: ScopedTx, quoteId: string, now: Date): Promise<number> {
  const r = await tx.quoteShare.updateMany({ where: { quoteId, revokedAt: null }, data: { revokedAt: now } });
  return r.count;
}

export function serializeShare(s: QuoteShareView, now: Date) {
  const state = s.revokedAt ? 'REVOKED' : s.supersededAt ? 'SUPERSEDED' : now.getTime() >= s.expiresAt.getTime() ? 'EXPIRED' : 'ACTIVE';
  return {
    id: s.id,
    quoteVersionId: s.quoteVersionId,
    state,
    expiresAt: s.expiresAt.toISOString(),
    revokedAt: s.revokedAt?.toISOString() ?? null,
    supersededAt: s.supersededAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}
export type QuoteShareDto = ReturnType<typeof serializeShare>;

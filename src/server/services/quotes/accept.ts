/**
 * Public quote acceptance (T16, C5, ADR-10, plan §6.1 SENT/VIEWED -> ACCEPTED).
 *
 * The request carries the token (the path token and the body token must match), the form nonce
 * the page rendered, `HMAC(SHARE_NONCE_KEY, tokenHash || expectedVersionId)`, and the version the
 * reader saw. The route has already checked Origin = APP_ORIGIN. Then, in one immediate
 * transaction:
 *   - the link is resolved (404 / 410 exactly as the page, C3);
 *   - an acceptance already recorded for this version returns the same receipt (idempotent; two
 *     parallel accepts serialize on the write lock, so one writes and one reads);
 *   - the expected version must be the link's version and the quote's current version (409);
 *   - the quote must be SENT or VIEWED and within validity (409 / 410);
 *   - QuoteAcceptance (UNIQUE per version), Quote ACCEPTED with acceptedVersionId, the lead's
 *     sales stage moved forward to CONVERTED, and one `quote.accept` audit row commit together.
 * GET never reaches this code.
 */
import type { Prisma, QuoteAcceptance, SalesStage } from '@/generated/prisma/client';
import { ConflictError, CsrfError, DomainRuleError, QuoteVersionConflictError } from '@/lib/errors';
import { withTx } from '@/server/db/tx';
import { verifyFormNonce } from '@/server/security/csrf';
import { hashToken, isWellFormedToken } from '@/server/security/tokens';
import { recordAudit } from '@/server/services/audit/record';
import { resolveShare, shareNotFound, type PublicDeps } from './public-share';
import { nextQuoteStatus } from './state-machine';

export const ACCEPTOR_NAME_LIMITS = { min: 2, max: 120 } as const;

/** Sales stages a quote acceptance may move forward from (forward-only; LOST stays LOST). */
const CONVERTIBLE_STAGES: readonly SalesStage[] = ['NEW', 'CONTACTED', 'REPLIED', 'QUOTE_SENT'];

export type AcceptInput = { token: string; formNonce: string; expectedVersionId: string; acceptorName: string };

export type AcceptReceipt = {
  receiptId: string;
  quoteNumber: string;
  versionNo: number;
  acceptedAt: string;
  acceptorName: string;
  senderName: string;
};

function receiptOf(row: QuoteAcceptance, quote: { number: string }, versionNo: number, senderName: string): AcceptReceipt {
  return { receiptId: row.id, quoteNumber: quote.number, versionNo, acceptedAt: row.acceptedAt.toISOString(), acceptorName: row.acceptorName, senderName };
}

export async function acceptSharedQuote(
  deps: PublicDeps,
  pathToken: string,
  input: AcceptInput,
  viewer: { userAgent: string | null; ipHash: string },
): Promise<{ receipt: AcceptReceipt; created: boolean }> {
  if (!isWellFormedToken(pathToken) || input.token !== pathToken) throw shareNotFound();
  if (!verifyFormNonce(deps.shareNonceKey, hashToken(pathToken), input.expectedVersionId, input.formNonce)) {
    throw new CsrfError({ code: 'FORM_NONCE_INVALID', message: 'accept form nonce missing or invalid', userMessage: 'This acceptance form is out of date. Reload the page and try again.' });
  }
  const acceptorName = input.acceptorName.replace(/\s+/g, ' ').trim();
  if (acceptorName.length < ACCEPTOR_NAME_LIMITS.min || acceptorName.length > ACCEPTOR_NAME_LIMITS.max) {
    throw new DomainRuleError({ code: 'ACCEPTOR_NAME_INVALID', userMessage: `Enter your full name (${ACCEPTOR_NAME_LIMITS.min} to ${ACCEPTOR_NAME_LIMITS.max} characters).`, safeDetails: { field: 'acceptorName' } });
  }

  return withTx(deps.db, async (tx) => {
    const now = deps.clock.now();
    const { share, quote, workspace, status } = await resolveShare(tx, pathToken, now);
    const version = await tx.quoteVersion.findFirstOrThrow({ where: { id: share.quoteVersionId, workspaceId: share.workspaceId }, select: { id: true, versionNo: true } });

    if (share.quoteVersionId === input.expectedVersionId) {
      const existing = await tx.quoteAcceptance.findUnique({ where: { quoteVersionId: input.expectedVersionId } });
      if (existing) return { receipt: receiptOf(existing, quote, version.versionNo, workspace.name), created: false };
    }
    if (share.quoteVersionId !== input.expectedVersionId || quote.currentVersionId !== input.expectedVersionId) {
      throw new QuoteVersionConflictError({
        userMessage: 'This quotation has changed since the page was loaded. Reload to see the current version.',
        safeDetails: { versionNo: quote.currentVersionNo },
      });
    }
    const to = nextQuoteStatus(status, 'ACCEPT');

    const acceptance = await tx.quoteAcceptance.create({
      data: {
        workspaceId: share.workspaceId,
        quoteId: quote.id,
        quoteVersionId: share.quoteVersionId,
        acceptorName,
        ipHash: viewer.ipHash,
        userAgent: (viewer.userAgent ?? '').slice(0, 300),
        acceptedAt: now,
      },
    });
    const cas = await tx.quote.updateMany({
      where: { id: quote.id, workspaceId: share.workspaceId, status: { in: ['SENT', 'VIEWED'] }, currentVersionId: share.quoteVersionId, validUntil: { gt: now } },
      data: { status: to, acceptedVersionId: share.quoteVersionId, updatedAt: now },
    });
    if (cas.count !== 1) throw new ConflictError({ userMessage: 'This quotation changed while you were accepting it. Reload and try again.' });
    const stage = await tx.lead.updateMany({
      where: { id: quote.leadId, workspaceId: share.workspaceId, salesStage: { in: [...CONVERTIBLE_STAGES] } },
      data: { salesStage: 'CONVERTED', updatedAt: now } as Prisma.LeadUncheckedUpdateManyInput,
    });
    await recordAudit(
      tx,
      { kind: 'public', actor: null, workspaceId: share.workspaceId, correlationId: deps.correlationId, clock: deps.clock },
      {
        action: 'quote.accept',
        targetType: 'Quote',
        targetId: quote.id,
        summary: { fromStatus: status, versionNo: version.versionNo, shareId: share.id, acceptanceId: acceptance.id, leadConverted: stage.count === 1, fields: ['acceptorName'] },
      },
    );
    return { receipt: receiptOf(acceptance, quote, version.versionNo, workspace.name), created: true };
  });
}

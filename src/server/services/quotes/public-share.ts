/**
 * The public side of a quote share link (T16, C2, C3, C4, ADR-09, ADR-10). No cookies, no
 * session: the path token is the credential. Only sha256(token) is ever looked up or stored.
 *
 * Resolution (one function for the page, the beacon, the PDF and acceptance):
 *   malformed or unknown token, revoked link, cancelled quote, unissued (DRAFT) quote -> the same
 *     NotFoundError (404); revocation must not confirm that a link ever existed;
 *   superseded link (a newer version exists)                                      -> 410 naming the sender;
 *   link past its expiresAt, or quote past its validUntil                          -> 410 naming the sender;
 *   otherwise the live share with its quote (APPROVED, SENT, VIEWED or ACCEPTED on this version).
 *
 * View evidence (C4): a page GET appends QuoteViewEvent(FETCH) and nothing else. The page's beacon
 * POST appends QuoteViewEvent(BEACON); on a SENT quote from a browser-class user agent it moves the
 * quote to VIEWED (label "Opened (may be automated)"); a link-preview or bot agent is recorded but
 * moves nothing; on an APPROVED quote it records the hint "Mark as sent?" (P15).
 * Writes run as the PUBLIC actor in the share's workspace, each in one transaction with its audit.
 */
import type { Prisma, PrismaClient, Quote, QuoteShare, QuoteStatus, UaClass } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { NotFoundError, ShareLinkGoneError } from '@/lib/errors';
import { formatDate } from '@/lib/format/date';
import { withTx } from '@/server/db/tx';
import { formNonce } from '@/server/security/csrf';
import { hashToken, isWellFormedToken } from '@/server/security/tokens';
import { recordAudit, type AuditCtx } from '@/server/services/audit/record';
import { loadQuoteRenderModel, type QuoteRenderModel } from './render-model';
import { nextQuoteStatus } from './state-machine';
import { effectiveQuoteStatus } from './versioning';

export const VIEW_LABEL = 'Opened (may be automated)';
export const MARK_SENT_HINT = 'Mark as sent?';

export type PublicDeps = {
  db: PrismaClient;
  clock: Clock;
  mode: 'demo' | 'live';
  correlationId: string;
  shareNonceKey: string;
};

type Db = PrismaClient | Prisma.TransactionClient;

export type GoneReason = 'EXPIRED' | 'SUPERSEDED';

/** 410 for an expired or superseded link; carries the sender name the page shows. */
export class ShareGoneError extends ShareLinkGoneError {
  readonly reason: GoneReason;
  readonly senderName: string;
  constructor(reason: GoneReason, senderName: string) {
    super({
      code: reason === 'EXPIRED' ? 'SHARE_LINK_EXPIRED' : 'SHARE_LINK_SUPERSEDED',
      message: `share link ${reason.toLowerCase()}`,
      userMessage:
        reason === 'EXPIRED'
          ? `This quotation link from ${senderName} has expired. Contact ${senderName} for a current link.`
          : `${senderName} has issued a newer version of this quotation. Ask ${senderName} for the new link.`,
      safeDetails: { reason },
    });
    this.reason = reason;
    this.senderName = senderName;
  }
}

/** The one 404 for every "no such link" case (C3). */
export function shareNotFound(): NotFoundError {
  return new NotFoundError({ message: 'share link not found', userMessage: 'This quotation link is not valid.' });
}

export type ResolvedShare = {
  share: QuoteShare;
  quote: Quote;
  workspace: { id: string; name: string };
  /** The status a reader sees on this version: APPROVED, SENT, VIEWED or ACCEPTED. */
  status: Extract<QuoteStatus, 'APPROVED' | 'SENT' | 'VIEWED' | 'ACCEPTED'>;
};

export async function resolveShare(db: Db, token: string, now: Date): Promise<ResolvedShare> {
  if (typeof token !== 'string' || !isWellFormedToken(token)) throw shareNotFound();
  const share = await (db as PrismaClient).quoteShare.findUnique({ where: { tokenHash: hashToken(token) }, include: { quote: true } });
  if (!share || share.revokedAt !== null) throw shareNotFound();
  const quote = share.quote;
  if (quote.status === 'CANCELLED') throw shareNotFound();
  const workspace = await (db as PrismaClient).workspace.findUnique({ where: { id: share.workspaceId }, select: { id: true, name: true } });
  if (!workspace) throw shareNotFound();

  if (share.supersededAt !== null) throw new ShareGoneError('SUPERSEDED', workspace.name);
  if (now.getTime() >= share.expiresAt.getTime()) throw new ShareGoneError('EXPIRED', workspace.name);
  if (quote.status === 'ACCEPTED') {
    if (quote.acceptedVersionId === share.quoteVersionId) return { share, quote, workspace, status: 'ACCEPTED' };
    throw new ShareGoneError('SUPERSEDED', workspace.name);
  }
  if (share.quoteVersionId !== quote.currentVersionId) throw new ShareGoneError('SUPERSEDED', workspace.name);
  const effective = effectiveQuoteStatus(quote, now);
  if (effective === 'EXPIRED') throw new ShareGoneError('EXPIRED', workspace.name);
  if (effective !== 'APPROVED' && effective !== 'SENT' && effective !== 'VIEWED') throw shareNotFound();
  return { share, quote, workspace, status: effective };
}

// ---- User agent classes (C4 second filter) ------------------------------------------------------

const LINK_PREVIEW = /facebookexternalhit|facebot|whatsapp|telegrambot|slackbot|slack-imgproxy|twitterbot|linkedinbot|discordbot|skypeuripreview|pinterest|embedly|vkshare|redditbot|applebot|googleimageproxy|yahoomailproxy|outlook|microsoft office|ms-office|google-pagerenderer|iframely|bitlybot|quora link preview|snapchat|viber|line\//i;
const BOT = /bot\b|bot\/|crawler|spider|crawl|curl\/|wget\/|python-requests|python-urllib|aiohttp|httpx|go-http-client|java\/|okhttp|libwww|node-fetch|axios\/|undici|headlesschrome|phantomjs|preview|scanner|monitor|proofpoint|mimecast|barracuda|validator/i;

export function classifyUserAgent(ua: string | null | undefined): UaClass {
  const value = (ua ?? '').trim();
  if (!value) return 'UNKNOWN';
  if (LINK_PREVIEW.test(value)) return 'LINK_PREVIEW';
  if (BOT.test(value)) return 'BOT';
  if (/^Mozilla\/5\.0 /.test(value)) return 'BROWSER';
  return 'UNKNOWN';
}

function publicAudit(deps: PublicDeps, workspaceId: string): AuditCtx {
  return { kind: 'public', actor: null, workspaceId, correlationId: deps.correlationId, clock: deps.clock };
}

// ---- Page read (GET) ------------------------------------------------------------------------------

export type PublicQuoteData = {
  model: QuoteRenderModel;
  status: ResolvedShare['status'];
  senderName: string;
  /** Present when the quote can be accepted on this page (SENT or VIEWED, within validity). */
  accept: { formNonce: string; expectedVersionId: string } | null;
  acceptance: { acceptorName: string; acceptedOn: string; versionLabel: string } | null;
};

/**
 * Resolves the link for the public page and appends one FETCH view event. It never changes the
 * quote (GET never mutates state, C4).
 */
export async function readPublicQuote(deps: PublicDeps, token: string, viewer: { userAgent: string | null; ipHash: string }): Promise<PublicQuoteData> {
  const now = deps.clock.now();
  const resolved = await resolveShare(deps.db, token, now);
  const { share, workspace, status } = resolved;
  await deps.db.quoteViewEvent.create({
    data: { workspaceId: share.workspaceId, quoteShareId: share.id, quoteVersionId: share.quoteVersionId, kind: 'FETCH', uaClass: classifyUserAgent(viewer.userAgent), ipHash: viewer.ipHash, createdAt: now },
  });
  const model = await loadQuoteRenderModel(deps.db, { workspaceId: share.workspaceId, quoteVersionId: share.quoteVersionId }, deps.mode);
  let acceptance: PublicQuoteData['acceptance'] = null;
  if (status === 'ACCEPTED') {
    const row = await deps.db.quoteAcceptance.findUnique({ where: { quoteVersionId: share.quoteVersionId } });
    if (row) acceptance = { acceptorName: row.acceptorName, acceptedOn: formatDate(row.acceptedAt, model.timeZone), versionLabel: model.versionLabel };
  }
  const accept = status === 'SENT' || status === 'VIEWED' ? { formNonce: formNonce(deps.shareNonceKey, share.tokenHash, share.quoteVersionId), expectedVersionId: share.quoteVersionId } : null;
  return { model, status, senderName: workspace.name, accept, acceptance };
}

// ---- Beacon (POST) --------------------------------------------------------------------------------

export type BeaconResult = { recorded: true; status: QuoteStatus; label: string | null; hint: string | null };

export async function recordQuoteBeacon(deps: PublicDeps, token: string, viewer: { userAgent: string | null; ipHash: string }): Promise<BeaconResult> {
  const uaClass = classifyUserAgent(viewer.userAgent);
  return withTx(deps.db, async (tx) => {
    const now = deps.clock.now();
    const { share, quote } = await resolveShare(tx, token, now);
    const earlierBeacons = await tx.quoteViewEvent.count({ where: { quoteShareId: share.id, quoteVersionId: share.quoteVersionId, kind: 'BEACON' } });
    await tx.quoteViewEvent.create({
      data: { workspaceId: share.workspaceId, quoteShareId: share.id, quoteVersionId: share.quoteVersionId, kind: 'BEACON', uaClass, ipHash: viewer.ipHash, createdAt: now },
    });
    const human = uaClass === 'BROWSER' || uaClass === 'UNKNOWN';
    if (!human) return { recorded: true, status: quote.status, label: null, hint: null };

    if (quote.status === 'SENT') {
      const to = nextQuoteStatus('SENT', 'VIEW');
      const cas = await tx.quote.updateMany({ where: { id: quote.id, workspaceId: share.workspaceId, status: 'SENT', currentVersionId: share.quoteVersionId }, data: { status: to, updatedAt: now } });
      if (cas.count === 1) {
        await recordAudit(tx, publicAudit(deps, share.workspaceId), {
          action: 'quote.view',
          targetType: 'Quote',
          targetId: quote.id,
          summary: { label: VIEW_LABEL, versionNo: quote.currentVersionNo, uaClass, shareId: share.id },
        });
        return { recorded: true, status: to, label: VIEW_LABEL, hint: null };
      }
    }
    if (quote.status === 'APPROVED') {
      if (earlierBeacons === 0) {
        await recordAudit(tx, publicAudit(deps, share.workspaceId), {
          action: 'quote.view.unsent',
          targetType: 'Quote',
          targetId: quote.id,
          summary: { hint: MARK_SENT_HINT, label: VIEW_LABEL, versionNo: quote.currentVersionNo, uaClass, shareId: share.id },
        });
      }
      return { recorded: true, status: 'APPROVED', label: VIEW_LABEL, hint: MARK_SENT_HINT };
    }
    const status = (await tx.quote.findUniqueOrThrow({ where: { id: quote.id }, select: { status: true } })).status;
    return { recorded: true, status, label: status === 'VIEWED' ? VIEW_LABEL : null, hint: null };
  });
}

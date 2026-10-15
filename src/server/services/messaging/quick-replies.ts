/**
 * Quick replies and inbound keywords (C15, P3, P4, R23, R45; plan §4.3 C9).
 *
 * Payload ids are versioned and set per send: `AL_QR_QUOTE_V1`, `AL_QR_CALL_V1`, `AL_QR_STOP_V1`.
 * Classification of one inbound WhatsApp message (pure):
 *  - a quick reply (template `button` or interactive `button_reply` / `list_reply`) with a known
 *    payload is that intent; with no payload echoed (UNVERIFIED provider behavior) its button text
 *    is matched against a fixed list (the fallback); an unknown payload goes to human review;
 *  - any message whose whole text, or a button's text, is a STOP keyword (fixed multilingual list
 *    incl. Hindi) is a Stop: never missed, and processed synchronously by the webhook route (C9);
 *  - a whole-text START keyword is a re-opt-in (`recordStartKeywordConsent`);
 *  - anything else is an ordinary inbound message. Keywords never match inside longer text.
 *
 * Handling (inside the `webhook.process` transaction, after the inbound Message is stored):
 *  - QUOTE with an approved current quote: the quotation PDF is queued as an in-window document
 *    reply (P2: a media document, never a link). The version's human approval is bound to it when
 *    it has not been used for a send yet (as approve-and-send binds it); otherwise it is an
 *    automated reply when workspace auto-send is on, or a draft waiting for approval.
 *  - QUOTE without one (P3): the lead's DRAFT quote (created from its last proposal before this
 *    transaction when it had none) gets its approval flagged `customer_requested`; no holding
 *    message unless auto-send is on, then one fixed in-window text. No proposal: review.
 *  - CALL (P4): one CallRequest per inbound event (replays create none); an https booking link,
 *    when configured, becomes a reply that follows the auto-send or approval rules.
 * Every reply goes through the dispatch outbox with `sendIntent = CUSTOMER_REQUESTED_REPLY`, so
 * the shared eligibility function decides at dispatch time (consent, window, suppression, pauses).
 */
import type { Channel, MessageKind, Prisma } from '@/generated/prisma/client';
import type { AppCtx } from '@/server/auth/context';
import { requireWorkspace } from '@/server/auth/guards';
import type { ScopedTx } from '@/server/db/scoped';
import { messagePayloadHash, type PayloadReadDb } from '@/server/services/approvals/payload-hash';
import { recordAudit } from '@/server/services/audit/record';
import { recordQuickReplyCallRequest } from '@/server/services/call-requests/call-requests';
import { effectiveQuoteStatus } from '@/server/services/quotes/versioning';
import { queueOutboundMessage, type DispatchDeps } from './dispatch';

export const QUICK_REPLY_PAYLOADS = { QUOTE: 'AL_QR_QUOTE_V1', CALL: 'AL_QR_CALL_V1', STOP: 'AL_QR_STOP_V1' } as const;
export type QuickReply = keyof typeof QUICK_REPLY_PAYLOADS;

/** Whole-message Stop keywords (ADR-06; fixed list, compared after folding). */
export const STOP_KEYWORDS: readonly string[] = ['stop', 'stop all', 'stopall', 'unsubscribe', 'opt out', 'optout', 'opt-out', 'बंद', 'बंद करें', 'बंद करो', 'रोकें', 'रोको'];
export const START_KEYWORDS: readonly string[] = ['start', 'subscribe', 'शुरू', 'शुरू करें'];
/** Button texts of our quick-reply templates, used only when the payload was not echoed. */
export const BUTTON_TEXT_FALLBACK: Readonly<Record<string, QuickReply>> = {
  'send my quote': 'QUOTE',
  'send quote': 'QUOTE',
  'get a quote': 'QUOTE',
  'get quote': 'QUOTE',
  'कोटेशन भेजें': 'QUOTE',
  'call me': 'CALL',
  'request a call': 'CALL',
  'call back': 'CALL',
  'कॉल करें': 'CALL',
  'stop promotions': 'STOP',
};

export const QUICK_REPLY_INITIATOR = 'system:webhook.process';
export const HOLDING_MESSAGE_TEXT = 'Thank you for your request. We are preparing your quotation and will share it here shortly.';

export type InboundIntent = 'STOP' | 'START' | 'QUOTE' | 'CALL' | 'UNKNOWN_QUICK_REPLY' | 'MESSAGE';
export type InboundView = {
  kind: Extract<MessageKind, 'TEXT' | 'INTERACTIVE_REPLY' | 'DOCUMENT'>;
  /** Text body, or the button title of a quick reply. */
  body: string | null;
  isQuickReply: boolean;
  payload: string | null;
  /** The provider message type, as received. */
  type: string;
};
export type Classification = { intent: InboundIntent; matchedBy: 'PAYLOAD' | 'BUTTON_TEXT' | 'KEYWORD' | null };

/** NFKC, lower case, single spaces, trailing punctuation (incl. the danda) removed. */
export function foldKeyword(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?,।]+$/u, '')
    .trim();
}

const STOP_SET = new Set(STOP_KEYWORDS.map(foldKeyword));
const START_SET = new Set(START_KEYWORDS.map(foldKeyword));
const PAYLOAD_TO_INTENT: Readonly<Record<string, QuickReply>> = Object.fromEntries(Object.entries(QUICK_REPLY_PAYLOADS).map(([k, v]) => [v, k as QuickReply]));

/** The stored view of an inbound WhatsApp message (shape per the webhook schema). */
export function inboundView(message: {
  type: string;
  text?: { body: string } | undefined;
  button?: { text: string; payload?: string | undefined } | undefined;
  interactive?: { button_reply?: { id: string; title: string } | undefined; list_reply?: { id: string; title: string } | undefined } | undefined;
}): InboundView {
  if (message.type === 'button' && message.button) {
    return { kind: 'INTERACTIVE_REPLY', body: message.button.text, isQuickReply: true, payload: message.button.payload ?? null, type: message.type };
  }
  const reply = message.interactive?.button_reply ?? message.interactive?.list_reply;
  if (message.type === 'interactive' && reply) {
    return { kind: 'INTERACTIVE_REPLY', body: reply.title, isQuickReply: true, payload: reply.id, type: message.type };
  }
  if (message.type === 'text' && message.text) return { kind: 'TEXT', body: message.text.body, isQuickReply: false, payload: null, type: message.type };
  if (message.type === 'document') return { kind: 'DOCUMENT', body: null, isQuickReply: false, payload: null, type: message.type };
  // Media, location, reactions and other types: a valid inbound message without a text body.
  return { kind: 'TEXT', body: null, isQuickReply: false, payload: null, type: message.type };
}

export function classifyInbound(view: InboundView): Classification {
  const folded = view.body === null ? '' : foldKeyword(view.body);
  if (view.isQuickReply) {
    const byPayload = view.payload === null ? undefined : PAYLOAD_TO_INTENT[view.payload];
    if (byPayload) return { intent: byPayload, matchedBy: 'PAYLOAD' };
    // A Stop is never missed, whatever the payload says.
    if (STOP_SET.has(folded) || BUTTON_TEXT_FALLBACK[folded] === 'STOP') return { intent: 'STOP', matchedBy: 'BUTTON_TEXT' };
    if (view.payload === null || view.payload === '') {
      const byText = BUTTON_TEXT_FALLBACK[folded];
      if (byText) return { intent: byText, matchedBy: 'BUTTON_TEXT' };
    }
    return { intent: 'UNKNOWN_QUICK_REPLY', matchedBy: null };
  }
  if (folded !== '' && STOP_SET.has(folded)) return { intent: 'STOP', matchedBy: 'KEYWORD' };
  if (folded !== '' && START_SET.has(folded)) return { intent: 'START', matchedBy: 'KEYWORD' };
  return { intent: 'MESSAGE', matchedBy: null };
}

export function stopReasonFor(c: Classification): 'STOP_BUTTON' | 'STOP_KEYWORD' {
  return c.matchedBy === 'KEYWORD' ? 'STOP_KEYWORD' : 'STOP_BUTTON';
}

/** A booking URL is used only when it is an absolute https URL (P4). */
export function httpsBookingUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.toString() : null;
  } catch {
    return null;
  }
}

// ---- Handling (inside the webhook.process transaction) -------------------------------------------

export type QuickReplyContext = {
  tx: ScopedTx;
  ctx: AppCtx;
  leadId: string;
  conversationId: string;
  inboundMessageId: string;
  /** The WebhookEvent id: dedupe key of every reply this event causes. */
  eventId: string;
  settings: { autoSendEnabled: boolean; bookingUrl: string | null };
  deps: DispatchDeps;
  simulated: boolean;
};

type Tx = Prisma.TransactionClient;
const LIVE_STATUSES = new Set(['APPROVED', 'SENT', 'VIEWED']);

function flagsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((f): f is string => typeof f === 'string') : [];
}

/** An outbound DRAFT reply with a PENDING approval flagged for the queue (nothing is sent until a person approves it). */
async function draftForApproval(q: QuickReplyContext, content: { kind: MessageKind; body: string; quoteVersionId?: string | null }, flags: string[]): Promise<{ messageId: string; approvalId: string }> {
  const workspaceId = requireWorkspace(q.ctx);
  const now = q.ctx.clock.now();
  const message = await q.tx.message.create({
    data: {
      workspaceId,
      conversationId: q.conversationId,
      direction: 'OUT',
      channel: 'WHATSAPP' satisfies Channel,
      kind: content.kind,
      body: content.body,
      quoteVersionId: content.quoteVersionId ?? null,
      status: 'DRAFT',
      statusRank: 0,
      simulated: q.ctx.mode === 'demo',
      generatorLabel: 'system',
      replyToInboundId: q.inboundMessageId,
      createdAt: now,
    },
    select: { id: true },
  });
  const approval = await q.tx.approval.create({
    data: { workspaceId, kind: 'OUTBOUND_MESSAGE', status: 'PENDING', messageId: message.id, flags, requestedAt: now },
    select: { id: true },
  });
  return { messageId: message.id, approvalId: approval.id };
}

async function queueReply(q: QuickReplyContext, content: { kind: MessageKind; body: string; quoteVersionId?: string | null }, dedupe: string, approvalId: string | null = null) {
  return queueOutboundMessage(
    q.tx,
    q.ctx,
    {
      kind: content.kind,
      body: content.body,
      quoteVersionId: content.quoteVersionId ?? null,
      generatorLabel: 'system',
      leadId: q.leadId,
      channel: 'WHATSAPP',
      sendIntent: 'CUSTOMER_REQUESTED_REPLY',
      initiatedBy: QUICK_REPLY_INITIATOR,
      approvalId,
      dedupeKey: `${dedupe}:${q.eventId}`,
    },
    q.deps,
  );
}

export type QuoteRequestAction = 'QUOTE_DOCUMENT_QUEUED' | 'QUOTE_DOCUMENT_REVIEW' | 'QUOTE_DRAFT_FLAGGED' | 'REVIEW_NO_PROPOSAL';
export type QuoteRequestResult = { action: QuoteRequestAction; quoteId: string | null; messageId: string | null; holdingMessageId: string | null };

/** The lead's newest quote whose current version may be sent now (approved, sent or viewed, in validity, PDF rendered). */
export async function findSendableQuote(db: Pick<ScopedTx, 'quote' | 'quoteVersion' | 'quoteArtifact'>, leadId: string, now: Date) {
  const quotes = await db.quote.findMany({ where: { leadId, status: { in: ['APPROVED', 'SENT', 'VIEWED'] } }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }] });
  for (const quote of quotes) {
    if (quote.currentVersionId === null || !LIVE_STATUSES.has(effectiveQuoteStatus(quote, now))) continue;
    const artifact = await db.quoteArtifact.findFirst({ where: { quoteVersionId: quote.currentVersionId }, select: { id: true } });
    if (!artifact) continue;
    const version = await db.quoteVersion.findFirstOrThrow({ where: { id: quote.currentVersionId }, select: { id: true, versionNo: true } });
    return { quote, version };
  }
  return null;
}

export async function findDraftQuote(db: Pick<ScopedTx, 'quote'>, leadId: string) {
  return db.quote.findFirst({ where: { leadId, status: 'DRAFT', currentVersionId: { not: null } }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }] });
}

export async function handleQuoteRequest(q: QuickReplyContext): Promise<QuoteRequestResult> {
  const workspaceId = requireWorkspace(q.ctx);
  const now = q.ctx.clock.now();
  const sendable = await findSendableQuote(q.tx, q.leadId, now);
  let result: QuoteRequestResult;

  if (sendable) {
    const ws = await q.tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } });
    const content = { kind: 'DOCUMENT' as const, body: `Quotation ${sendable.quote.number} (version ${sendable.version.versionNo}) from ${ws.name}`, quoteVersionId: sendable.version.id };
    const approval = await q.tx.approval.findFirst({ where: { kind: 'QUOTE_VERSION', quoteVersionId: sendable.version.id, status: 'APPROVED', messageId: null }, select: { id: true } });
    if (approval) {
      // The version's human approval, not yet used for any send, covers this document (as approve-and-send binds it).
      const queued = await queueReply(q, content, 'qr-quote', approval.id);
      const payloadHash = await messagePayloadHash(q.tx as unknown as PayloadReadDb, { workspaceId, messageId: queued.messageId }, q.deps.contactKeyPepper);
      await q.tx.approval.update({ where: { id: approval.id }, data: { messageId: queued.messageId, payloadHash } });
      result = { action: 'QUOTE_DOCUMENT_QUEUED', quoteId: sendable.quote.id, messageId: queued.messageId, holdingMessageId: null };
    } else if (q.settings.autoSendEnabled) {
      const queued = await queueReply(q, content, 'qr-quote');
      result = { action: 'QUOTE_DOCUMENT_QUEUED', quoteId: sendable.quote.id, messageId: queued.messageId, holdingMessageId: null };
    } else {
      const draft = await draftForApproval(q, content, ['customer_requested']);
      result = { action: 'QUOTE_DOCUMENT_REVIEW', quoteId: sendable.quote.id, messageId: draft.messageId, holdingMessageId: null };
    }
  } else {
    const draftQuote = await findDraftQuote(q.tx, q.leadId);
    let action: QuoteRequestAction = 'REVIEW_NO_PROPOSAL';
    if (draftQuote) {
      const pending = await q.tx.approval.findFirst({ where: { kind: 'QUOTE_VERSION', quoteVersionId: draftQuote.currentVersionId!, status: 'PENDING' }, select: { id: true, flags: true } });
      if (pending) {
        const flags = flagsOf(pending.flags);
        if (!flags.includes('customer_requested')) await q.tx.approval.update({ where: { id: pending.id }, data: { flags: [...flags, 'customer_requested'] } });
      }
      action = 'QUOTE_DRAFT_FLAGGED';
    }
    let holdingMessageId: string | null = null;
    if (q.settings.autoSendEnabled) holdingMessageId = (await queueReply(q, { kind: 'TEXT', body: HOLDING_MESSAGE_TEXT }, 'qr-ack')).messageId;
    result = { action, quoteId: draftQuote?.id ?? null, messageId: null, holdingMessageId };
  }

  await recordAudit(q.tx as unknown as Tx, q.ctx, {
    action: 'quick_reply.quote_requested',
    targetType: 'Lead',
    targetId: q.leadId,
    simulated: q.simulated,
    summary: { ...result, inboundMessageId: q.inboundMessageId, autoSend: q.settings.autoSendEnabled },
  });
  return result;
}

export type CallRequestResult = { callRequestId: string; created: boolean; replyMessageId: string | null; replyState: 'QUEUED' | 'AWAITING_APPROVAL' | 'NONE' };

export async function handleCallRequest(q: QuickReplyContext): Promise<CallRequestResult> {
  const { callRequestId, created } = await recordQuickReplyCallRequest(q.tx, q.ctx, {
    leadId: q.leadId,
    conversationId: q.conversationId,
    sourceEventId: q.eventId,
    requestedAt: q.ctx.clock.now(),
    simulated: q.simulated,
  });
  const url = httpsBookingUrl(q.settings.bookingUrl);
  if (!created || url === null) return { callRequestId, created, replyMessageId: null, replyState: 'NONE' };
  const content = { kind: 'TEXT' as const, body: `Thank you, we will call you back. You can also pick a time that suits you here: ${url}` };
  if (q.settings.autoSendEnabled) {
    const queued = await queueReply(q, content, 'qr-call');
    return { callRequestId, created, replyMessageId: queued.messageId, replyState: 'QUEUED' };
  }
  const draft = await draftForApproval(q, content, ['customer_requested', 'call_request']);
  return { callRequestId, created, replyMessageId: draft.messageId, replyState: 'AWAITING_APPROVAL' };
}

/** An unknown quick-reply payload: stored and visible, no automated action, a person decides (C15). */
export async function recordQuickReplyReview(q: Pick<QuickReplyContext, 'tx' | 'ctx' | 'leadId' | 'inboundMessageId' | 'simulated'>, view: InboundView): Promise<void> {
  await recordAudit(q.tx as unknown as Tx, q.ctx, {
    action: 'quick_reply.review',
    targetType: 'Message',
    targetId: q.inboundMessageId,
    simulated: q.simulated,
    summary: { reasonCode: 'UNKNOWN_QUICK_REPLY', leadId: q.leadId, payloadPresent: view.payload !== null, providerType: view.type },
  });
}

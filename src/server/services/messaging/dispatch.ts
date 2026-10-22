/**
 * The dispatch outbox (C7, ADR-05, plan §4.4, §6.3; E4-E7, O3). Every outbound WhatsApp or email
 * send is a DispatchAttempt row driven by a `dispatch.whatsapp` / `dispatch.email` job.
 *
 * Creation (one transaction each, no network):
 *  - `approveAndSendQuote`: approves the quote's current version when it is still DRAFT (the same
 *    CAS and guards as `approveQuote`), creates the outbound Message, binds an APPROVED approval
 *    carrying the payload hash (O3), and queues attempt 1 and its job. Idempotent per (version,
 *    channel): concurrent or repeated calls return the same ids.
 *  - `createMessageDraft` + `approveAndSendMessage`: the same for a message without a quote.
 *  - `queueOutboundMessage`: automated or bulk callers (T21, T23) inside their own transaction.
 *  `sendIntent` and `initiatedBy` are persisted on the Message and the attempt and never change (E4).
 *  Each of them refuses an EMPLOYEE actor (or a job running an EMPLOYEE's send) for a lead handed
 *  over to the client with 409 HANDED_OVER (`assertNotHandedOver`, ADR-124); not an eligibility
 *  reason, so the preflight below is unchanged.
 *
 * Worker side (the handler in jobs/handlers/dispatch-run.ts), three short transactions:
 *  1. `preflightDispatch` (fenced): attempt still QUEUED; quote version still current and live;
 *     PDF present; approval still APPROVED and its payload hash unchanged (APPROVAL_STALE);
 *     the shared eligibility function with the attempt's persisted intent; provider throttle
 *     window. Outcome: SENDING (committed before the call), SKIPPED, CANCELLED or deferred.
 *  2. provider call, outside any transaction.
 *  3. `settleSent` / `settleFailed` / `settleAmbiguous` inside the job's fenced settle: attempt
 *     state, Message projection, lead stage forward-only, quote CAS (E6), audit. RETRYABLE and
 *     PRE_SEND failures queue attempt N+1, which runs the whole preflight again (E7).
 */
import type { Channel, MessageKind, Prisma, SendIntent } from '@/generated/prisma/client';
import { formatINR } from '@/lib/money';
import { DomainRuleError, InvalidTransitionError, NotFoundError, QuoteVersionConflictError, ValidationError } from '@/lib/errors';
import { idempotencyKey } from '@/lib/ids';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { assertSameWorkspace, type ScopedTx } from '@/server/db/scoped';
import { withTx } from '@/server/db/tx';
import { enqueueJob, type JobStore } from '@/server/jobs/queue';
import { pdfFileName } from '@/server/pdf/artifacts';
import { hmacSha256, safeEqual } from '@/server/security/hmac';
import { approveQuoteVersionApproval } from '@/server/services/approvals/quote-approvals';
import { destinationKeyFor, messagePayloadHash, type PayloadReadDb } from '@/server/services/approvals/payload-hash';
import { recordAudit } from '@/server/services/audit/record';
import { assertNotHandedOver } from '@/server/services/leads/handoff-guard';
import { nextQuoteStatus } from '@/server/services/quotes/state-machine';
import { effectiveQuoteStatus } from '@/server/services/quotes/versioning';
import { projectSent, projectUnsent } from './delivery-state';
import { checkDispatchEligibility, DEFERRABLE_REASONS, evaluateDispatchEligibility, loadEligibilityInput, startOfLocalDay, type DispatchKind, type ReasonCode } from './eligibility';
import { suppressContact } from './suppression';

type Tx = Prisma.TransactionClient;

export const DISPATCH_JOB_TYPES = { WHATSAPP: 'dispatch.whatsapp', EMAIL: 'dispatch.email' } as const satisfies Record<Channel, string>;
export const DISPATCH_PAYLOAD_VERSION = 1;
/** How long a paused (global or workspace) attempt waits before its next preflight. */
export const PAUSE_RECHECK_MS = 60_000;
export const ARTIFACT_RECHECK_MS = 5_000;
/** `initiatedBy` of the automated email a skipped WhatsApp send falls back to (plan §7). */
export const FALLBACK_INITIATOR = 'system:dispatch.fallback';

/** Provider throttle reason codes (error maps) and how far they reach (ADR-41: 429 sets a throttle window). */
export const THROTTLE_REASONS: Readonly<Record<string, 'workspace' | 'pair'>> = {
  RATE_LIMITED: 'workspace',
  PROVIDER_QUOTA: 'workspace',
  PAIR_RATE_LIMITED: 'pair',
};

/** Skip reasons on the WhatsApp side that an email fallback may answer (pauses, opt-outs and takeovers never fall back). */
const FALLBACK_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>(['NO_WHATSAPP_OPT_IN', 'WINDOW_CLOSED', 'TEMPLATE_NOT_APPROVED', 'QUALITY_PAUSED', 'NOT_CONFIGURED']);

export type DispatchDeps = { contactKeyPepper: string };

const LIVE_QUOTE_STATUSES = new Set(['APPROVED', 'SENT', 'VIEWED']);
const LEAD_STAGE_ORDER = ['NEW', 'CONTACTED', 'REPLIED', 'QUOTE_SENT', 'CONVERTED'] as const;

export function dispatchJobType(channel: Channel): string {
  return DISPATCH_JOB_TYPES[channel];
}

export function dispatchKindOf(message: { channel: Channel; kind: MessageKind; templateId: string | null }): DispatchKind {
  if (message.channel === 'EMAIL') return 'EMAIL';
  return message.templateId !== null || message.kind === 'TEMPLATE' ? 'WA_TEMPLATE' : 'WA_FREEFORM';
}

export function attemptKey(messageId: string, attemptNo: number): string {
  return idempotencyKey('dispatch-attempt', messageId, attemptNo);
}

// ---- Unsubscribe links (M2, D4: every email carries one; T20 serves /unsubscribe and /api/unsubscribe) ----

export type UnsubscribeClaims = { workspaceId: string; contactKey: string };

const b64url = (buf: Buffer) => buf.toString('base64url');

/** The signing key for unsubscribe tokens, derived from SESSION_SECRET. */
export function deriveUnsubscribeKey(sessionSecret: string): Buffer {
  return hmacSha256(sessionSecret, 'auralead.unsubscribe.v1');
}

export function signUnsubscribeToken(key: Buffer, claims: UnsubscribeClaims): string {
  const payload = b64url(Buffer.from(JSON.stringify({ v: 1, w: claims.workspaceId, c: claims.contactKey }), 'utf8'));
  return `${payload}.${b64url(hmacSha256(key, payload))}`;
}

export function verifyUnsubscribeToken(key: Buffer, token: string): UnsubscribeClaims | null {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!safeEqual(b64url(hmacSha256(key, parts[0])), parts[1])) return null;
  try {
    const raw = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { v?: unknown; w?: unknown; c?: unknown };
    if (raw.v !== 1 || typeof raw.w !== 'string' || typeof raw.c !== 'string') return null;
    return { workspaceId: raw.w, contactKey: raw.c };
  } catch {
    return null;
  }
}

export function unsubscribeLinks(appOrigin: string, token: string): { pageUrl: string; oneClickUrl: string; headers: Record<string, string> } {
  const origin = appOrigin.replace(/\/+$/, '');
  const pageUrl = `${origin}/unsubscribe/${token}`;
  const oneClickUrl = `${origin}/api/unsubscribe?token=${encodeURIComponent(token)}`;
  return { pageUrl, oneClickUrl, headers: { 'List-Unsubscribe': `<${oneClickUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
}

export function withUnsubscribeFooter(text: string, workspaceName: string, pageUrl: string): string {
  return `${text}\n\n--\nTo stop emails from ${workspaceName}, open ${pageUrl}`;
}

// ---- Content -----------------------------------------------------------------------------------

export function quoteEmailContent(input: { workspaceName: string; leadName: string; number: string; versionNo: number; totalPaise: bigint; validUntil: Date; timeZone: string }): {
  subject: string;
  body: string;
} {
  const valid = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: input.timeZone }).format(input.validUntil);
  return {
    subject: `Quotation ${input.number} from ${input.workspaceName}`,
    body: [
      `Hello ${input.leadName},`,
      '',
      `Please find attached quotation ${input.number} (version ${input.versionNo}) from ${input.workspaceName}.`,
      `Total: ${formatINR(input.totalPaise)}. Valid until ${valid}.`,
      '',
      `Reply to this email with any questions.`,
    ].join('\n'),
  };
}

// ---- Creation ----------------------------------------------------------------------------------

export type QueuedDispatch = { conversationId: string; messageId: string; attemptId: string; jobId: string };
export type ApproveAndSendResult = { approvalId: string; messageId: string; attemptId: string; jobId: string; created: boolean };

type MessageContent = {
  kind: MessageKind;
  body?: string | null;
  subject?: string | null;
  templateId?: string | null;
  variables?: Record<string, string> | null;
  quoteVersionId?: string | null;
  generatorLabel?: string | null;
};

async function ensureConversation(tx: ScopedTx, ctx: AppCtx, leadId: string, channel: Channel, contactKey: string): Promise<{ id: string }> {
  const open = await tx.conversation.findFirst({ where: { leadId, channel, closedAt: null }, select: { id: true } });
  if (open) return open;
  return tx.conversation.create({ data: { workspaceId: requireWorkspace(ctx), leadId, channel, contactKey, createdAt: ctx.clock.now() }, select: { id: true } });
}

async function createOutboundMessage(
  tx: ScopedTx,
  ctx: AppCtx,
  input: MessageContent & { leadId: string; channel: Channel; status: 'DRAFT' | 'PENDING'; sendIntent: SendIntent | null; initiatedBy: string | null },
  deps: DispatchDeps,
): Promise<{ messageId: string; conversationId: string }> {
  const lead = await tx.lead.findFirst({ where: { id: input.leadId }, select: { id: true, phoneE164: true, emailNormalized: true } });
  if (!lead) throw new NotFoundError();
  const key = destinationKeyFor(deps.contactKeyPepper, input.channel, lead);
  if (key === null) {
    throw new DomainRuleError({
      code: 'CONTACT_MISSING',
      userMessage: input.channel === 'WHATSAPP' ? 'This lead has no valid WhatsApp number.' : 'This lead has no valid email address.',
    });
  }
  const conversation = await ensureConversation(tx, ctx, lead.id, input.channel, key);
  const message = await tx.message.create({
    data: {
      workspaceId: requireWorkspace(ctx),
      conversationId: conversation.id,
      direction: 'OUT',
      channel: input.channel,
      kind: input.kind,
      body: input.body ?? null,
      subject: input.subject ?? null,
      templateId: input.templateId ?? null,
      variables: input.variables ?? undefined,
      quoteVersionId: input.quoteVersionId ?? null,
      status: input.status,
      statusRank: 0,
      simulated: ctx.mode === 'demo',
      generatorLabel: input.generatorLabel ?? 'human',
      sendIntent: input.sendIntent,
      initiatedBy: input.initiatedBy,
      createdBy: ctx.actor?.userId ?? null,
      createdAt: ctx.clock.now(),
    },
    select: { id: true },
  });
  return { messageId: message.id, conversationId: conversation.id };
}

/** Attempt 1 and its job for a PENDING outbound message (inside the caller's transaction). */
async function queueFirstAttempt(
  tx: ScopedTx,
  ctx: AppCtx,
  input: { messageId: string; conversationId: string; channel: Channel; quoteVersionId: string | null; approvalId: string | null; sendIntent: SendIntent; initiatedBy: string; jobKey: string; runAt?: Date },
): Promise<{ attemptId: string; jobId: string }> {
  const workspaceId = requireWorkspace(ctx);
  const { job } = await enqueueJob(tx as unknown as JobStore, ctx.clock, {
    type: dispatchJobType(input.channel),
    payload: { messageId: input.messageId },
    payloadVersion: DISPATCH_PAYLOAD_VERSION,
    workspaceId,
    idempotencyKey: input.jobKey,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId ?? null,
    serialKey: input.conversationId,
    kind: 'send',
    ...(input.runAt ? { runAt: input.runAt } : {}),
  });
  const attempt = await tx.dispatchAttempt.create({
    data: {
      workspaceId,
      messageId: input.messageId,
      quoteVersionId: input.quoteVersionId,
      approvalId: input.approvalId,
      channel: input.channel,
      attemptNo: 1,
      state: 'QUEUED',
      sendIntent: input.sendIntent,
      initiatedBy: input.initiatedBy,
      idempotencyKey: attemptKey(input.messageId, 1),
      jobId: job.id,
      createdAt: ctx.clock.now(),
      updatedAt: ctx.clock.now(),
    },
    select: { id: true },
  });
  return { attemptId: attempt.id, jobId: job.id };
}

async function existingDispatch(tx: ScopedTx, jobKey: string): Promise<Omit<ApproveAndSendResult, 'created'> | null> {
  const job = await tx.job.findFirst({ where: { idempotencyKey: jobKey }, select: { id: true } });
  if (!job) return null;
  const attempt = await tx.dispatchAttempt.findFirst({ where: { jobId: job.id }, orderBy: { attemptNo: 'asc' }, select: { id: true, messageId: true, approvalId: true } });
  if (!attempt) return null;
  return { approvalId: attempt.approvalId ?? '', messageId: attempt.messageId, attemptId: attempt.id, jobId: job.id };
}

export type QueueOutboundInput = MessageContent & {
  leadId: string;
  channel: Channel;
  sendIntent: SendIntent;
  initiatedBy: string;
  approvalId?: string | null;
  /** Job idempotency key: one dispatch per key (replays return the existing ids). */
  dedupeKey: string;
  runAt?: Date;
};

/**
 * Queues one outbound message for automated, bulk or customer-requested sends inside the caller's
 * transaction (T21 reply jobs, T23 DELIVERY stage and bulk). Eligibility is decided at dispatch.
 */
export async function queueOutboundMessage(tx: ScopedTx, ctx: AppCtx, input: QueueOutboundInput, deps: DispatchDeps): Promise<QueuedDispatch & { created: boolean }> {
  await assertSameWorkspace(tx, ctx, { leadId: input.leadId, templateId: input.templateId ?? null, quoteVersionId: input.quoteVersionId ?? null, approvalId: input.approvalId ?? null });
  const jobKey = idempotencyKey('dispatch', 'outbound', input.dedupeKey);
  const existing = await existingDispatch(tx, jobKey);
  if (existing) {
    const message = await tx.message.findFirstOrThrow({ where: { id: existing.messageId }, select: { conversationId: true } });
    return { conversationId: message.conversationId, messageId: existing.messageId, attemptId: existing.attemptId, jobId: existing.jobId, created: false };
  }
  // ADR-124: an operator (or a job running an operator's send) never queues to a handed-over lead.
  await assertNotHandedOver(tx, ctx, input.leadId, { initiatedBy: input.initiatedBy });
  const { messageId, conversationId } = await createOutboundMessage(tx, ctx, { ...input, status: 'PENDING' }, deps);
  const queued = await queueFirstAttempt(tx, ctx, {
    messageId,
    conversationId,
    channel: input.channel,
    quoteVersionId: input.quoteVersionId ?? null,
    approvalId: input.approvalId ?? null,
    sendIntent: input.sendIntent,
    initiatedBy: input.initiatedBy,
    jobKey,
    runAt: input.runAt,
  });
  await recordAudit(tx, ctx, {
    action: 'dispatch.queue',
    targetType: 'Message',
    targetId: messageId,
    simulated: ctx.mode === 'demo',
    summary: { channel: input.channel, sendIntent: input.sendIntent, attemptId: queued.attemptId, hasQuote: Boolean(input.quoteVersionId) },
  });
  return { conversationId, messageId, ...queued, created: true };
}

export type ApproveAndSendQuoteInput = {
  quoteId: string;
  expectedVersion: number;
  channel: Channel;
  /** WhatsApp: the approved template that carries the quotation document. */
  templateId?: string | null;
  variables?: Record<string, string> | null;
};

/**
 * Approve-and-send (plan §4.4, §6.1, §6.3; AT12): one transaction approves the current version
 * (when DRAFT), creates the Message, binds an approval with the payload hash and queues attempt 1.
 */
export async function approveAndSendQuote(ctx: AppCtx, input: ApproveAndSendQuoteInput, deps: DispatchDeps): Promise<ApproveAndSendResult> {
  requireCapability(ctx, 'approvals.decide');
  requireCapability(ctx, 'dispatch.send');
  const workspaceId = requireWorkspace(ctx);
  const actorId = ctx.actor?.userId ?? `system:${ctx.kind}`;
  return withTx(ctx.db, async (tx) => {
    await assertSameWorkspace(tx, ctx, { quoteId: input.quoteId, templateId: input.templateId ?? null });
    const quote = await tx.quote.findFirst({ where: { id: input.quoteId } });
    if (!quote || quote.currentVersionId === null) throw new NotFoundError();
    if (quote.currentVersionNo !== input.expectedVersion) {
      throw new QuoteVersionConflictError({ safeDetails: { currentVersion: quote.currentVersionNo, expectedVersion: input.expectedVersion } });
    }
    const versionId = quote.currentVersionId;
    const jobKey = idempotencyKey('dispatch', 'quote', versionId, input.channel);
    const existing = await existingDispatch(tx, jobKey);
    if (existing) return { ...existing, created: false };
    await assertNotHandedOver(tx, ctx, quote.leadId);

    const now = ctx.clock.now();
    const version = await tx.quoteVersion.findFirstOrThrow({ where: { id: versionId } });
    const artifact = await tx.quoteArtifact.findFirst({ where: { quoteVersionId: versionId }, select: { id: true } });
    if (!artifact) {
      throw new DomainRuleError({ code: 'QUOTE_PDF_NOT_READY', userMessage: 'The quotation PDF is still being prepared. Try again in a few seconds.', retryAfterSeconds: 5 });
    }
    if (quote.validUntil === null || now.getTime() >= quote.validUntil.getTime()) {
      throw new DomainRuleError({ code: 'QUOTE_VALIDITY_PASSED', userMessage: 'This version is past its validity date. Revise it to set a new one.' });
    }

    let quoteApprovalId: string;
    if (quote.status === 'DRAFT') {
      const to = nextQuoteStatus(quote.status, 'APPROVE');
      if (quote.needsPricingReview) {
        throw new DomainRuleError({ code: 'PRICING_REVIEW_REQUIRED', userMessage: 'This version needs a pricing review before it can be approved.' });
      }
      const cas = await tx.quote.updateMany({ where: { id: quote.id, status: 'DRAFT', currentVersionNo: input.expectedVersion }, data: { status: to, updatedAt: now } });
      if (cas.count !== 1) throw new QuoteVersionConflictError();
      const flags = Array.isArray(version.aiPolicyFlags) ? version.aiPolicyFlags.filter((f): f is string => typeof f === 'string') : [];
      quoteApprovalId = (await approveQuoteVersionApproval(tx, ctx, { quoteId: quote.id, quoteVersionId: versionId, flags })).id;
      await recordAudit(tx, ctx, { action: 'quote.approve', targetType: 'Quote', targetId: quote.id, summary: { versionNo: version.versionNo, approvalId: quoteApprovalId, approveAndSend: true } });
    } else {
      // Only an APPROVED quote can be sent; SENT, VIEWED and the terminal states answer 409.
      nextQuoteStatus(quote.status, 'SEND');
      const approved = await tx.approval.findFirst({ where: { kind: 'QUOTE_VERSION', quoteVersionId: versionId, status: 'APPROVED' }, select: { id: true } });
      if (!approved) throw new InvalidTransitionError({ message: 'approved quote without an approval row' });
      quoteApprovalId = approved.id;
    }

    const lead = await tx.lead.findFirstOrThrow({ where: { id: quote.leadId }, select: { displayName: true } });
    let content: MessageContent;
    if (input.channel === 'WHATSAPP') {
      if (!input.templateId) throw new ValidationError({ code: 'TEMPLATE_REQUIRED', message: 'a WhatsApp quotation needs a template', userMessage: 'Choose the WhatsApp template that carries the quotation.' });
      content = { kind: 'TEMPLATE', templateId: input.templateId, variables: input.variables ?? {}, quoteVersionId: versionId };
    } else {
      const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true, timezone: true } });
      const email = quoteEmailContent({
        workspaceName: ws.name,
        leadName: lead.displayName,
        number: quote.number,
        versionNo: version.versionNo,
        totalPaise: version.totalPaise,
        validUntil: version.validUntil,
        timeZone: ws.timezone,
      });
      content = { kind: 'EMAIL', subject: email.subject, body: email.body, quoteVersionId: versionId };
    }

    const { messageId, conversationId } = await createOutboundMessage(
      tx,
      ctx,
      { ...content, leadId: quote.leadId, channel: input.channel, status: 'PENDING', sendIntent: 'MANUAL_SINGLE', initiatedBy: actorId },
      deps,
    );
    const payloadHash = await messagePayloadHash(tx as unknown as PayloadReadDb, { workspaceId, messageId }, deps.contactKeyPepper);
    // The version's own approval carries the first message it was sent with; a second channel gets its own row.
    const unbound = await tx.approval.findFirst({ where: { id: quoteApprovalId, messageId: null }, select: { id: true } });
    let approvalId: string;
    if (unbound) {
      await tx.approval.update({ where: { id: unbound.id }, data: { messageId, payloadHash } });
      approvalId = unbound.id;
    } else {
      approvalId = (
        await tx.approval.create({
          data: {
            workspaceId,
            kind: 'OUTBOUND_MESSAGE',
            status: 'APPROVED',
            quoteId: quote.id,
            quoteVersionId: versionId,
            messageId,
            payloadHash,
            flags: [],
            requestedAt: now,
            decidedBy: actorId,
            decidedAt: now,
          },
          select: { id: true },
        })
      ).id;
    }
    const queued = await queueFirstAttempt(tx, ctx, {
      messageId,
      conversationId,
      channel: input.channel,
      quoteVersionId: versionId,
      approvalId,
      sendIntent: 'MANUAL_SINGLE',
      initiatedBy: actorId,
      jobKey,
    });
    await recordAudit(tx, ctx, {
      action: 'dispatch.queue',
      targetType: 'Quote',
      targetId: quote.id,
      simulated: ctx.mode === 'demo',
      summary: { channel: input.channel, versionNo: version.versionNo, messageId, attemptId: queued.attemptId, approvalId, sendIntent: 'MANUAL_SINGLE' },
    });
    return { approvalId, messageId, attemptId: queued.attemptId, jobId: queued.jobId, created: true };
  });
}

export type MessageDraftInput = {
  leadId: string;
  channel: Channel;
  kind: 'TEXT' | 'TEMPLATE' | 'EMAIL';
  body?: string | null;
  subject?: string | null;
  templateId?: string | null;
  variables?: Record<string, string> | null;
  generatorLabel?: string | null;
};

function validateDraft(input: MessageDraftInput): void {
  const bad = (message: string) => new ValidationError({ code: 'MESSAGE_INVALID', message, userMessage: message });
  if (input.channel === 'EMAIL') {
    if (input.kind !== 'EMAIL') throw bad('An email message must be of kind EMAIL.');
    if (!input.subject?.trim() || !input.body?.trim()) throw bad('An email needs a subject and a body.');
  } else if (input.kind === 'TEMPLATE') {
    if (!input.templateId) throw bad('A WhatsApp template message needs a template.');
  } else if (input.kind === 'TEXT') {
    if (!input.body?.trim()) throw bad('A WhatsApp text message needs a body.');
  } else {
    throw bad('A WhatsApp message must be of kind TEXT or TEMPLATE.');
  }
}

/** A DRAFT outbound message with a PENDING OUTBOUND_MESSAGE approval (the approval queue item). */
export async function createMessageDraft(ctx: AppCtx, input: MessageDraftInput, deps: DispatchDeps): Promise<{ messageId: string; approvalId: string; conversationId: string }> {
  requireCapability(ctx, 'leads.write');
  validateDraft(input);
  const workspaceId = requireWorkspace(ctx);
  return withTx(ctx.db, async (tx) => {
    await assertSameWorkspace(tx, ctx, { leadId: input.leadId, templateId: input.templateId ?? null });
    await assertNotHandedOver(tx, ctx, input.leadId);
    const { messageId, conversationId } = await createOutboundMessage(tx, ctx, { ...input, status: 'DRAFT', sendIntent: null, initiatedBy: null }, deps);
    const approval = await tx.approval.create({
      data: { workspaceId, kind: 'OUTBOUND_MESSAGE', status: 'PENDING', messageId, flags: [], requestedAt: ctx.clock.now() },
      select: { id: true },
    });
    await recordAudit(tx, ctx, { action: 'message.draft', targetType: 'Message', targetId: messageId, summary: { channel: input.channel, kind: input.kind } });
    return { messageId, approvalId: approval.id, conversationId };
  });
}

/** Approves a DRAFT message as it stands now (payload hash) and queues its send. Idempotent. */
export async function approveAndSendMessage(ctx: AppCtx, input: { messageId: string }, deps: DispatchDeps): Promise<ApproveAndSendResult> {
  requireCapability(ctx, 'approvals.decide');
  requireCapability(ctx, 'dispatch.send');
  const workspaceId = requireWorkspace(ctx);
  const actorId = ctx.actor?.userId ?? `system:${ctx.kind}`;
  return withTx(ctx.db, async (tx) => {
    await assertSameWorkspace(tx, ctx, { messageId: input.messageId });
    const message = await tx.message.findFirst({ where: { id: input.messageId, direction: 'OUT' } });
    if (!message) throw new NotFoundError();
    const jobKey = idempotencyKey('dispatch', 'message', message.id);
    const existing = await existingDispatch(tx, jobKey);
    if (existing) return { ...existing, created: false };
    if (message.status !== 'DRAFT') throw new InvalidTransitionError({ message: `message is ${message.status}, not DRAFT` });
    const conversation = await tx.conversation.findFirstOrThrow({ where: { id: message.conversationId }, select: { leadId: true } });
    await assertNotHandedOver(tx, ctx, conversation.leadId);

    const now = ctx.clock.now();
    const payloadHash = await messagePayloadHash(tx as unknown as PayloadReadDb, { workspaceId, messageId: message.id }, deps.contactKeyPepper);
    const pending = await tx.approval.findFirst({ where: { kind: 'OUTBOUND_MESSAGE', messageId: message.id, status: 'PENDING' }, select: { id: true } });
    const approvalId = pending
      ? (await tx.approval.update({ where: { id: pending.id }, data: { status: 'APPROVED', decidedBy: actorId, decidedAt: now, payloadHash }, select: { id: true } })).id
      : (
          await tx.approval.create({
            data: { workspaceId, kind: 'OUTBOUND_MESSAGE', status: 'APPROVED', messageId: message.id, payloadHash, flags: [], requestedAt: now, decidedBy: actorId, decidedAt: now },
            select: { id: true },
          })
        ).id;
    await tx.message.update({ where: { id: message.id }, data: { status: 'PENDING', sendIntent: 'MANUAL_SINGLE', initiatedBy: actorId } });
    const queued = await queueFirstAttempt(tx, ctx, {
      messageId: message.id,
      conversationId: message.conversationId,
      channel: message.channel,
      quoteVersionId: message.quoteVersionId,
      approvalId,
      sendIntent: 'MANUAL_SINGLE',
      initiatedBy: actorId,
      jobKey,
    });
    await recordAudit(tx, ctx, {
      action: 'dispatch.queue',
      targetType: 'Message',
      targetId: message.id,
      simulated: ctx.mode === 'demo',
      summary: { channel: message.channel, attemptId: queued.attemptId, approvalId, sendIntent: 'MANUAL_SINGLE' },
    });
    return { approvalId, messageId: message.id, ...queued, created: true };
  });
}

// ---- Preflight ---------------------------------------------------------------------------------

export type SendPlan = {
  workspaceId: string;
  attemptId: string;
  attemptNo: number;
  idempotencyKey: string;
  messageId: string;
  conversationId: string;
  leadId: string;
  channel: Channel;
  kind: DispatchKind;
  sendIntent: SendIntent;
  initiatedBy: string;
  approvalId: string | null;
  quoteVersionId: string | null;
  /** E.164 phone or normalized email at preflight time. */
  to: string;
  destinationKey: string;
  /** The template row as synced (T32: raw components and the mapping, for header and quick-reply payloads). */
  template: { name: string; language: string; components: unknown; variableMap: unknown } | null;
  variables: Record<string, string>;
  body: string | null;
  subject: string | null;
  artifact: { path: string; sha256: string; bytes: number; filename: string } | null;
  workspace: { name: string; slug: string };
};

export type PreflightResult =
  | { kind: 'send'; plan: SendPlan }
  | { kind: 'skipped'; reasons: string[]; attemptId: string }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'deferred'; runAt: Date; reason: string }
  | { kind: 'artifact-pending'; attemptId: string; messageId: string }
  | { kind: 'done' };

export type PreflightDeps = DispatchDeps & {
  /** `outbound.lock` present or OUTBOUND_PAUSED=1 (O1). */
  externalOutboundPause: boolean;
  /** False when the registry built no transport (LIVE without a usable integration): skipped NOT_CONFIGURED. */
  transportAvailable: boolean;
  /**
   * Why there is no transport (T32). CREDENTIAL_UNREADABLE is recorded beside NOT_CONFIGURED on the
   * skipped attempt, so the inbox can say "Credential unreadable, re-enter".
   */
  transportProblem?: { code: string } | null;
};

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
  return out;
}

async function closeAttempt(tx: ScopedTx, ctx: AppCtx, attempt: { id: string; messageId: string }, state: 'SKIPPED' | 'CANCELLED', reasons: string[], details: readonly string[] = []): Promise<void> {
  const now = ctx.clock.now();
  await tx.dispatchAttempt.updateMany({ where: { id: attempt.id, state: 'QUEUED' }, data: { state, reasonCode: reasons[0] ?? state, errorRedacted: [...reasons, ...details].join(','), updatedAt: now } });
  await projectUnsent(tx as unknown as Tx, { workspaceId: requireWorkspace(ctx), messageId: attempt.messageId }, 'NOT_SENT');
  await recordAudit(tx, ctx, {
    action: state === 'SKIPPED' ? 'dispatch.skipped' : 'dispatch.cancelled',
    targetType: 'DispatchAttempt',
    targetId: attempt.id,
    simulated: ctx.mode === 'demo',
    summary: { reasons, ...(details.length > 0 ? { details: [...details] } : {}) },
  });
}

/** The latest end of a provider throttle window that applies to this send, if one is open. */
async function throttleUntil(tx: ScopedTx, now: Date, ref: { channel: Channel; conversationId: string; jobId: string }): Promise<Date | null> {
  const throttled = await tx.dispatchAttempt.findMany({
    where: {
      channel: ref.channel,
      state: 'FAILED',
      failureClass: 'RETRYABLE',
      reasonCode: { in: Object.keys(THROTTLE_REASONS) },
      jobId: { not: ref.jobId },
      updatedAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
    },
    select: { jobId: true, reasonCode: true, message: { select: { conversationId: true } } },
  });
  const relevant = throttled.filter((a) => THROTTLE_REASONS[a.reasonCode ?? ''] === 'workspace' || a.message.conversationId === ref.conversationId);
  if (relevant.length === 0) return null;
  const jobs = await tx.job.findMany({ where: { id: { in: [...new Set(relevant.map((a) => a.jobId))] }, status: 'QUEUED', runAt: { gt: now } }, select: { runAt: true } });
  if (jobs.length === 0) return null;
  return new Date(Math.max(...jobs.map((j) => j.runAt.getTime())));
}

function deferralRunAt(reasons: readonly ReasonCode[], now: Date, timeZone: string): Date {
  let at = now.getTime() + PAUSE_RECHECK_MS;
  if (reasons.includes('CAP_REACHED')) {
    const nextDay = startOfLocalDay(new Date(now.getTime() + 24 * 60 * 60 * 1000), timeZone).getTime();
    at = Math.max(at, nextDay);
  }
  return new Date(at);
}

/**
 * Runs inside the job's fenced, tenant-scoped transaction. Writes only what the outcome needs:
 * SENDING (pass), SKIPPED / CANCELLED (+ Message NOT_SENT, audit, maybe an email fallback), or
 * nothing (deferral: the attempt stays QUEUED and the job moves its runAt).
 */
export async function preflightDispatch(tx: ScopedTx, ctx: AppCtx, ref: { messageId: string; jobId: string }, deps: PreflightDeps): Promise<PreflightResult> {
  const workspaceId = requireWorkspace(ctx);
  const now = ctx.clock.now();
  const attempt = await tx.dispatchAttempt.findFirst({ where: { messageId: ref.messageId, jobId: ref.jobId }, orderBy: { attemptNo: 'desc' } });
  if (!attempt) return { kind: 'cancelled', reason: 'ATTEMPT_MISSING' };
  if (attempt.state === 'CANCELLED') return { kind: 'cancelled', reason: attempt.reasonCode ?? 'CANCELLED' };
  if (attempt.state !== 'QUEUED') return { kind: 'done' };

  const message = await tx.message.findFirstOrThrow({ where: { id: attempt.messageId } });
  const conversation = await tx.conversation.findFirstOrThrow({ where: { id: message.conversationId } });
  const lead = await tx.lead.findFirstOrThrow({ where: { id: conversation.leadId }, select: { id: true, phoneE164: true, emailNormalized: true } });
  const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true, slug: true, timezone: true } });

  // Version binding (T-e2, E6): only the current version of a live quote is ever sent.
  let artifact: SendPlan['artifact'] = null;
  if (attempt.quoteVersionId) {
    const version = await tx.quoteVersion.findFirstOrThrow({ where: { id: attempt.quoteVersionId }, select: { quoteId: true, versionNo: true } });
    const quote = await tx.quote.findFirstOrThrow({ where: { id: version.quoteId } });
    const status = effectiveQuoteStatus(quote, now);
    if (quote.currentVersionId !== attempt.quoteVersionId || !LIVE_QUOTE_STATUSES.has(status)) {
      const reason = status === 'CANCELLED' ? 'QUOTE_CANCELLED' : status === 'EXPIRED' ? 'QUOTE_EXPIRED' : 'SUPERSEDED';
      await closeAttempt(tx, ctx, attempt, 'CANCELLED', [reason]);
      return { kind: 'cancelled', reason };
    }
    const row = await tx.quoteArtifact.findFirst({ where: { quoteVersionId: attempt.quoteVersionId } });
    if (!row) return { kind: 'artifact-pending', attemptId: attempt.id, messageId: message.id };
    artifact = { path: row.path, sha256: row.sha256, bytes: row.bytes, filename: pdfFileName(quote.number, version.versionNo) };
  }

  // O3: the approval must still stand and still describe exactly this payload.
  if (attempt.approvalId) {
    const approval = await tx.approval.findFirst({ where: { id: attempt.approvalId }, select: { status: true, payloadHash: true } });
    const current = await messagePayloadHash(tx as unknown as PayloadReadDb, { workspaceId, messageId: message.id }, deps.contactKeyPepper);
    if (!approval || approval.status !== 'APPROVED' || approval.payloadHash === null || approval.payloadHash !== current) {
      await closeAttempt(tx, ctx, attempt, 'SKIPPED', ['APPROVAL_STALE']);
      return { kind: 'skipped', reasons: ['APPROVAL_STALE'], attemptId: attempt.id };
    }
  }

  const kind = dispatchKindOf(message);
  const input = await loadEligibilityInput(
    tx,
    ctx,
    {
      leadId: lead.id,
      channel: message.channel,
      kind,
      conversationId: conversation.id,
      sendIntent: attempt.sendIntent,
      initiatedBy: attempt.initiatedBy,
      approvalId: attempt.approvalId,
      templateId: message.templateId,
      ...(message.modeVersionAtCreate !== null ? { expectedModeVersion: message.modeVersionAtCreate } : {}),
    },
    { contactKeyPepper: deps.contactKeyPepper, externalOutboundPause: deps.externalOutboundPause },
  );
  if (!deps.transportAvailable) input.integrationReady = false;
  const result = evaluateDispatchEligibility(input, ctx.clock);
  if (!result.eligible) {
    if (result.deferrable) return { kind: 'deferred', runAt: deferralRunAt(result.reasons, now, workspace.timezone), reason: result.reasons.join(',') };
    // A skip is caused by a non-deferrable reason; name it first so a pause never reads as the cause.
    const skipReasons = [...result.reasons.filter((r) => !DEFERRABLE_REASONS.has(r)), ...result.reasons.filter((r) => DEFERRABLE_REASONS.has(r))];
    const details = deps.transportProblem && result.reasons.includes('NOT_CONFIGURED') && deps.transportProblem.code !== 'INTEGRATION_NOT_CONFIGURED' ? [deps.transportProblem.code] : [];
    await closeAttempt(tx, ctx, attempt, 'SKIPPED', skipReasons, details);
    if (message.channel === 'WHATSAPP') await maybeEmailFallback(tx, ctx, { attempt, message, leadId: lead.id, reasons: result.reasons }, deps);
    return { kind: 'skipped', reasons: result.reasons, attemptId: attempt.id };
  }

  const throttled = await throttleUntil(tx, now, { channel: message.channel, conversationId: conversation.id, jobId: ref.jobId });
  if (throttled) return { kind: 'deferred', runAt: throttled, reason: 'PROVIDER_THROTTLED' };

  const to = message.channel === 'WHATSAPP' ? lead.phoneE164 : lead.emailNormalized;
  const destinationKey = destinationKeyFor(deps.contactKeyPepper, message.channel, lead);
  if (to === null || destinationKey === null) {
    await closeAttempt(tx, ctx, attempt, 'SKIPPED', ['CONTACT_MISSING']);
    return { kind: 'skipped', reasons: ['CONTACT_MISSING'], attemptId: attempt.id };
  }
  const template = message.templateId ? await tx.whatsAppTemplate.findFirst({ where: { id: message.templateId }, select: { name: true, language: true, components: true, variableMap: true } }) : null;

  const moved = await tx.dispatchAttempt.updateMany({ where: { id: attempt.id, state: 'QUEUED' }, data: { state: 'SENDING', updatedAt: now } });
  if (moved.count !== 1) return { kind: 'done' };
  return {
    kind: 'send',
    plan: {
      workspaceId,
      attemptId: attempt.id,
      attemptNo: attempt.attemptNo,
      idempotencyKey: attempt.idempotencyKey,
      messageId: message.id,
      conversationId: conversation.id,
      leadId: lead.id,
      channel: message.channel,
      kind,
      sendIntent: attempt.sendIntent,
      initiatedBy: attempt.initiatedBy,
      approvalId: attempt.approvalId,
      quoteVersionId: attempt.quoteVersionId,
      to,
      destinationKey,
      template,
      variables: stringRecord(message.variables),
      body: message.body,
      subject: message.subject,
      artifact,
      workspace: { name: workspace.name, slug: workspace.slug },
    },
  };
}

/**
 * Email fallback (plan §7): only when the workspace enabled it, the WhatsApp skip is one email can
 * answer, there is email content, and the email side is independently eligible for an AUTOMATED
 * send (so attested B2B, which is manual-only, never qualifies).
 */
async function maybeEmailFallback(
  tx: ScopedTx,
  ctx: AppCtx,
  input: { attempt: { id: string }; message: { id: string; quoteVersionId: string | null; body: string | null; kind: MessageKind }; leadId: string; reasons: readonly ReasonCode[] },
  deps: PreflightDeps,
): Promise<void> {
  const settings = await tx.workspaceSettings.findFirst({ select: { emailFallbackEnabled: true } });
  if (!settings?.emailFallbackEnabled) return;
  if (!input.reasons.every((r) => FALLBACK_REASONS.has(r))) return;
  const audit = (action: string, summary: Record<string, unknown>) =>
    recordAudit(tx, ctx, { action, targetType: 'Message', targetId: input.message.id, simulated: ctx.mode === 'demo', summary });

  let content: MessageContent | null = null;
  if (input.message.quoteVersionId) {
    const version = await tx.quoteVersion.findFirstOrThrow({ where: { id: input.message.quoteVersionId } });
    const quote = await tx.quote.findFirstOrThrow({ where: { id: version.quoteId }, select: { number: true } });
    const lead = await tx.lead.findFirstOrThrow({ where: { id: input.leadId }, select: { displayName: true } });
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: requireWorkspace(ctx) }, select: { name: true, timezone: true } });
    const email = quoteEmailContent({ workspaceName: ws.name, leadName: lead.displayName, number: quote.number, versionNo: version.versionNo, totalPaise: version.totalPaise, validUntil: version.validUntil, timeZone: ws.timezone });
    content = { kind: 'EMAIL', subject: email.subject, body: email.body, quoteVersionId: version.id };
  } else if (input.message.kind === 'TEXT' && input.message.body) {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: requireWorkspace(ctx) }, select: { name: true } });
    content = { kind: 'EMAIL', subject: `A message from ${ws.name}`, body: input.message.body };
  }
  if (content === null) {
    await audit('dispatch.fallback_refused', { reasons: ['NO_EMAIL_CONTENT'] });
    return;
  }
  const email = await checkDispatchEligibility(
    tx,
    ctx,
    { leadId: input.leadId, channel: 'EMAIL', kind: 'EMAIL', sendIntent: 'AUTOMATED', initiatedBy: FALLBACK_INITIATOR },
    { contactKeyPepper: deps.contactKeyPepper, externalOutboundPause: deps.externalOutboundPause },
  );
  if (!email.eligible && !email.deferrable) {
    await audit('dispatch.fallback_refused', { reasons: email.reasons });
    return;
  }
  const queued = await queueOutboundMessage(
    tx,
    ctx,
    { ...content, leadId: input.leadId, channel: 'EMAIL', sendIntent: 'AUTOMATED', initiatedBy: FALLBACK_INITIATOR, dedupeKey: `fallback:${input.attempt.id}` },
    deps,
  );
  await audit('dispatch.fallback_email', { fromAttemptId: input.attempt.id, emailMessageId: queued.messageId, whatsappReasons: input.reasons });
}

// ---- Settle (inside the job's fenced settle transaction) ----------------------------------------

type SettleCtx = Pick<AppCtx, 'kind' | 'actor' | 'workspaceId' | 'correlationId' | 'clock' | 'mode'>;

async function advanceLeadStage(tx: Tx, workspaceId: string, leadId: string, target: 'CONTACTED' | 'QUOTE_SENT'): Promise<void> {
  const lower = LEAD_STAGE_ORDER.slice(0, LEAD_STAGE_ORDER.indexOf(target));
  await tx.lead.updateMany({ where: { id: leadId, workspaceId, salesStage: { in: [...lower] } }, data: { salesStage: target, stageVersion: { increment: 1 } } });
}

export async function settleSent(tx: Tx, ctx: SettleCtx, plan: SendPlan, sent: { providerMessageId: string; simulated: boolean }): Promise<void> {
  const now = ctx.clock.now();
  const { workspaceId } = plan;
  const moved = await tx.dispatchAttempt.updateMany({
    where: { id: plan.attemptId, workspaceId, state: 'SENDING' },
    data: { state: 'SENT', providerMessageId: sent.providerMessageId, updatedAt: now },
  });
  await projectSent(tx, { workspaceId, messageId: plan.messageId }, { ...sent, providerTs: now });
  // T21: one more business message since the customer's last inbound (12.3; reset by the next inbound).
  if (moved.count === 1) await tx.conversation.updateMany({ where: { id: plan.conversationId, workspaceId }, data: { unansweredOutboundCount: { increment: 1 } } });
  await advanceLeadStage(tx, workspaceId, plan.leadId, plan.quoteVersionId ? 'QUOTE_SENT' : 'CONTACTED');
  await recordAudit(tx, ctx, {
    action: 'dispatch.sent',
    targetType: 'DispatchAttempt',
    targetId: plan.attemptId,
    workspaceId,
    simulated: sent.simulated,
    summary: { channel: plan.channel, attemptNo: plan.attemptNo, sendIntent: plan.sendIntent, kind: plan.kind },
  });

  if (plan.quoteVersionId) {
    const version = await tx.quoteVersion.findFirstOrThrow({ where: { id: plan.quoteVersionId, workspaceId }, select: { quoteId: true, versionNo: true, sentAt: true } });
    if (version.sentAt === null) await tx.quoteVersion.updateMany({ where: { id: plan.quoteVersionId, workspaceId }, data: { sentAt: now } });
    // E6 CAS: only the attempt's own version, still current and APPROVED, moves to SENT.
    const cas = await tx.quote.updateMany({
      where: { id: version.quoteId, workspaceId, currentVersionId: plan.quoteVersionId, status: 'APPROVED' },
      data: { status: nextQuoteStatus('APPROVED', 'SEND'), sentVia: 'DISPATCH', updatedAt: now },
    });
    if (cas.count === 1) {
      await recordAudit(tx, ctx, { action: 'quote.send', targetType: 'Quote', targetId: version.quoteId, workspaceId, simulated: sent.simulated, summary: { versionNo: version.versionNo, channel: plan.channel, attemptId: plan.attemptId } });
    } else {
      const quote = await tx.quote.findFirstOrThrow({ where: { id: version.quoteId, workspaceId }, select: { currentVersionId: true, status: true } });
      if (quote.currentVersionId !== plan.quoteVersionId) {
        await recordAudit(tx, ctx, {
          action: 'quote.sent_superseded_version',
          targetType: 'Quote',
          targetId: version.quoteId,
          workspaceId,
          simulated: sent.simulated,
          summary: { versionNo: version.versionNo, quoteStatus: quote.status, attemptId: plan.attemptId },
        });
      }
    }
  }
}

export type FailedSettle = { failureClass: 'PRE_SEND' | 'RETRYABLE' | 'PERMANENT'; reasonCode: string; error: string; suppress: boolean; manualRetryAfterMs: number | null };

/**
 * FAILED with its class (E7). `retryNext` queues attempt N+1 on the same job (PRE_SEND and
 * RETRYABLE while attempts remain); otherwise the Message is FAILED. An opt-out reported by the
 * provider (131050) is written through the suppression service, whose journal line is exported by
 * the reconcile job queued in this transaction.
 */
export async function settleFailed(tx: Tx, ctx: SettleCtx, plan: SendPlan, failure: FailedSettle, opts: { retryNext: boolean; jobId: string }, deps: DispatchDeps): Promise<void> {
  const now = ctx.clock.now();
  const { workspaceId } = plan;
  await tx.dispatchAttempt.updateMany({
    where: { id: plan.attemptId, workspaceId, state: 'SENDING' },
    data: { state: 'FAILED', failureClass: failure.failureClass, reasonCode: failure.reasonCode, errorRedacted: failure.error, updatedAt: now },
  });
  if (opts.retryNext) {
    await tx.dispatchAttempt.create({
      data: {
        workspaceId,
        messageId: plan.messageId,
        quoteVersionId: plan.quoteVersionId,
        approvalId: plan.approvalId,
        channel: plan.channel,
        attemptNo: plan.attemptNo + 1,
        state: 'QUEUED',
        sendIntent: plan.sendIntent,
        initiatedBy: plan.initiatedBy,
        idempotencyKey: attemptKey(plan.messageId, plan.attemptNo + 1),
        jobId: opts.jobId,
        createdAt: now,
        updatedAt: now,
      },
    });
  } else {
    await projectUnsent(tx, { workspaceId, messageId: plan.messageId }, 'FAILED');
  }
  await recordAudit(tx, ctx, {
    action: 'dispatch.failed',
    targetType: 'DispatchAttempt',
    targetId: plan.attemptId,
    workspaceId,
    simulated: ctx.mode === 'demo',
    summary: {
      channel: plan.channel,
      attemptNo: plan.attemptNo,
      failureClass: failure.failureClass,
      reasonCode: failure.reasonCode,
      retryQueued: opts.retryNext,
      manualRetryAfterMs: failure.manualRetryAfterMs,
    },
  });
  if (failure.suppress) {
    const lead = await tx.lead.findFirstOrThrow({ where: { id: plan.leadId, workspaceId }, select: { phoneE164: true, emailNormalized: true } });
    const value = plan.channel === 'WHATSAPP' ? lead.phoneE164 : lead.emailNormalized;
    if (value !== null) {
      await suppressContact(
        tx,
        { ...ctx, workspaceId },
        'enqueue-reconcile',
        { channel: plan.channel, contact: { kind: plan.channel === 'WHATSAPP' ? 'phone' : 'email', value }, reason: 'MARKETING_STOPPED', sourceEventId: plan.attemptId, simulated: ctx.mode === 'demo' },
        deps.contactKeyPepper,
      );
    }
  }
}

/** Timeout or reset after the write: AMBIGUOUS, "Delivery unknown", never resent automatically. */
export async function settleAmbiguous(tx: Tx, ctx: SettleCtx, plan: SendPlan, outcome: { reasonCode: string; error: string }): Promise<void> {
  const now = ctx.clock.now();
  const { workspaceId } = plan;
  await tx.dispatchAttempt.updateMany({
    where: { id: plan.attemptId, workspaceId, state: 'SENDING' },
    data: { state: 'AMBIGUOUS', reasonCode: outcome.reasonCode, errorRedacted: outcome.error, updatedAt: now },
  });
  await projectUnsent(tx, { workspaceId, messageId: plan.messageId }, 'UNKNOWN');
  await recordAudit(tx, ctx, {
    action: 'dispatch.ambiguous',
    targetType: 'DispatchAttempt',
    targetId: plan.attemptId,
    workspaceId,
    simulated: ctx.mode === 'demo',
    summary: { channel: plan.channel, attemptNo: plan.attemptNo, reasonCode: outcome.reasonCode },
  });
}

/** The PDF never appeared within the job's attempts: the attempt is cancelled, nothing was sent. */
export async function settleArtifactMissing(tx: Tx, ctx: SettleCtx, ref: { workspaceId: string; attemptId: string; messageId: string }): Promise<void> {
  const now = ctx.clock.now();
  await tx.dispatchAttempt.updateMany({ where: { id: ref.attemptId, workspaceId: ref.workspaceId, state: 'QUEUED' }, data: { state: 'CANCELLED', reasonCode: 'ARTIFACT_MISSING', updatedAt: now } });
  await projectUnsent(tx, { workspaceId: ref.workspaceId, messageId: ref.messageId }, 'NOT_SENT');
  await recordAudit(tx, ctx, { action: 'dispatch.cancelled', targetType: 'DispatchAttempt', targetId: ref.attemptId, workspaceId: ref.workspaceId, summary: { reasons: ['ARTIFACT_MISSING'] } });
}

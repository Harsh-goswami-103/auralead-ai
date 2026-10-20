/**
 * The User Inbox (T22, R31, 06-design §11.2 "User Inbox", §11.3 rows Inbox / Composer / Delivery /
 * Takeover, F5, F6, F7). Read models for the thread list and one thread, and the composer's two
 * actions. Pages read through this module; the composer and mode routes call it.
 *
 * What the browser gets is decided here, never computed in the UI (plan §7):
 *  - the window state (`windowEndsAt`) from `Conversation.lastInboundProviderAt` (C19, exclusive);
 *  - the composer's eligibility from the shared dispatch eligibility function for a person's
 *    single send (MANUAL_SINGLE), labelled "Final check happens at send" by the UI;
 *  - each message's delivery state (`Message.status`, "Delivery unknown" for UNKNOWN), with a note
 *    from its dispatch attempts: "AI reply cancelled by takeover" (SKIPPED HUMAN_TAKEOVER or
 *    MODE_CHANGED), superseded by a newer customer message, blocked reasons, deferrals;
 *  - events: takeover, resume, AI mode changes, escalations, call requests, unknown buttons.
 *
 * Composer send (`sendComposerMessage`): the person who presses Send approves the message (needs
 * `approvals.decide` and `dispatch.send`). In one transaction the shared eligibility check runs; a
 * refusal (for example WINDOW_CLOSED one millisecond past the boundary) answers 422 `SEND_REFUSED`
 * with the reasons and the next action (an approved template, or review) and queues nothing, so the
 * UI keeps the draft and never shows "Sent". Otherwise the message is queued through the outbox
 * (`queueOutboundMessage`, sendIntent MANUAL_SINGLE, initiatedBy the sender) with an APPROVED
 * OUTBOUND_MESSAGE approval carrying the payload hash (O3), keyed by the client's request key so a
 * double click or a retry queues one dispatch. The worker's preflight re-checks everything at send.
 * "Save for review" (`saveComposerDraft`) keeps the text as a DRAFT with a PENDING approval.
 */
import type { Channel, ConversationAiMode, DispatchState, MessageDirection, MessageKind, MessageStatus, Prisma, SendIntent } from '@/generated/prisma/client';
import type { AppConfig } from '@/lib/config';
import { DomainRuleError, NotFoundError, ValidationError } from '@/lib/errors';
import { truncateAtWord } from '@/lib/format/text';
import { idempotencyKey } from '@/lib/ids';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { readOutboundLock } from '@/server/services/admin/outbound-pause';
import { messagePayloadHash, type PayloadReadDb } from '@/server/services/approvals/payload-hash';
import { dispatchReasonLabel } from '@/server/services/approvals/queue';
import { recordAudit } from '@/server/services/audit/record';
import { effectiveQuoteStatus } from '@/server/services/quotes/versioning';
import { REPLY_INITIATOR } from './conversations';
import { DELIVERY_UNKNOWN_LABEL, deliveryLabel } from './delivery-state';
import { createMessageDraft, dispatchKindOf, queueOutboundMessage } from './dispatch';
import { checkDispatchEligibility, REASON_LABELS, type ReasonCode } from './eligibility';
import { isWindowOpen, windowEndsAt } from './window';

export type InboxDeps = { contactKeyPepper: string; externalOutboundPause: boolean };

/** Route and page dependencies from the boot config (`outbound.lock` or OUTBOUND_PAUSED=1 count as a global pause). */
export function inboxDepsFromConfig(config: AppConfig): InboxDeps {
  const pepper = config.secrets.suppressionPepper;
  if (!pepper) throw new Error('SUPPRESSION_PEPPER is not configured (run `npm run setup`).');
  return { contactKeyPepper: pepper, externalOutboundPause: config.outboundPaused || readOutboundLock(config.paths.outboundLockFile).present };
}

export const INBOX_THREAD_LIMIT = 200;
export const THREAD_MESSAGE_LIMIT = 200;
export const COMPOSER_LIMITS = { text: 4096, subject: 200, emailBody: 10_000 } as const;

const QUICK_REPLY_LABELS: Readonly<Record<string, string>> = {
  QUOTE: 'Tapped "Get quote"',
  CALL: 'Tapped "Request a call"',
  STOP: 'Tapped "Stop"',
  START: 'Sent START',
  UNKNOWN_QUICK_REPLY: 'Tapped an unknown button (needs review)',
};

function quickReplyOf(variables: Prisma.JsonValue | null): string | null {
  if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) return null;
  const q = (variables as { quickReply?: unknown }).quickReply;
  return typeof q === 'string' ? q : null;
}

function previewOf(m: { body: string | null; subject: string | null; kind: MessageKind; variables: Prisma.JsonValue | null; direction: MessageDirection }): string {
  const quick = m.direction === 'IN' ? quickReplyOf(m.variables) : null;
  if (quick) return QUICK_REPLY_LABELS[quick] ?? 'Tapped a button';
  if (m.body) return truncateAtWord(m.body, 140);
  if (m.subject) return truncateAtWord(m.subject, 140);
  if (m.kind === 'TEMPLATE') return 'Template message';
  if (m.kind === 'DOCUMENT') return 'Quotation PDF';
  return 'Message';
}

// ---- Thread list -----------------------------------------------------------------------------------

export type InboxThreadRow = {
  conversationId: string;
  leadId: string;
  leadName: string;
  simulated: boolean;
  channel: Channel;
  aiMode: ConversationAiMode;
  humanTakeover: boolean;
  lastMessage: { direction: MessageDirection; preview: string; status: MessageStatus; simulated: boolean; at: Date } | null;
  lastActivityAt: Date;
  windowOpen: boolean;
  windowEndsAt: Date | null;
  pendingApprovals: number;
  /** FAILED or "Delivery unknown" outbound messages. */
  attentionDeliveries: number;
  openCallRequests: number;
  needsYou: boolean;
};

export type InboxList = { rows: InboxThreadRow[]; counts: { all: number; needsYou: number }; serverNow: Date; timezone: string };

export async function listInboxThreads(ctx: AppCtx, input: { filter?: 'all' | 'needs_you' }): Promise<InboxList> {
  requireCapability(ctx, 'leads.read');
  const workspaceId = requireWorkspace(ctx);
  const now = ctx.clock.now();
  const db = ctx.db;
  const workspace = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { timezone: true } });
  const conversations = await db.conversation.findMany({
    where: { closedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: INBOX_THREAD_LIMIT,
    include: { lead: { select: { id: true, displayName: true, simulated: true } } },
  });
  const ids = conversations.map((c) => c.id);
  const [latest, pending, attention, calls] = await Promise.all([
    db.message.findMany({ where: { conversationId: { in: ids }, status: { not: 'NOT_SENT' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], distinct: ['conversationId'] }),
    db.approval.findMany({ where: { status: 'PENDING', kind: 'OUTBOUND_MESSAGE', message: { conversationId: { in: ids } } }, select: { message: { select: { conversationId: true } } } }),
    db.message.findMany({ where: { conversationId: { in: ids }, direction: 'OUT', status: { in: ['FAILED', 'UNKNOWN'] } }, select: { conversationId: true } }),
    db.callRequest.findMany({ where: { conversationId: { in: ids }, status: 'OPEN' }, select: { conversationId: true } }),
  ]);
  const count = (list: Array<string | null | undefined>) => {
    const m = new Map<string, number>();
    for (const id of list) if (id) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  };
  const latestOf = new Map(latest.map((m) => [m.conversationId, m]));
  const pendingOf = count(pending.map((p) => p.message?.conversationId));
  const attentionOf = count(attention.map((a) => a.conversationId));
  const callsOf = count(calls.map((c) => c.conversationId));

  const all: InboxThreadRow[] = conversations.map((c) => {
    const last = latestOf.get(c.id);
    const open = c.channel === 'WHATSAPP' && isWindowOpen(c.lastInboundProviderAt, now);
    const pendingApprovals = pendingOf.get(c.id) ?? 0;
    const attentionDeliveries = attentionOf.get(c.id) ?? 0;
    const openCallRequests = callsOf.get(c.id) ?? 0;
    return {
      conversationId: c.id,
      leadId: c.lead.id,
      leadName: c.lead.displayName,
      simulated: c.lead.simulated,
      channel: c.channel,
      aiMode: c.aiMode,
      humanTakeover: c.humanTakeover,
      lastMessage: last ? { direction: last.direction, preview: previewOf(last), status: last.status, simulated: last.simulated, at: last.providerTs ?? last.createdAt } : null,
      lastActivityAt: last ? (last.providerTs ?? last.createdAt) : c.createdAt,
      windowOpen: open,
      windowEndsAt: open ? windowEndsAt(c.lastInboundProviderAt) : null,
      pendingApprovals,
      attentionDeliveries,
      openCallRequests,
      needsYou: pendingApprovals > 0 || attentionDeliveries > 0 || openCallRequests > 0 || c.humanTakeover,
    };
  });
  all.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime() || a.conversationId.localeCompare(b.conversationId));
  const needsYou = all.filter((r) => r.needsYou);
  return { rows: input.filter === 'needs_you' ? needsYou : all, counts: { all: all.length, needsYou: needsYou.length }, serverNow: now, timezone: workspace.timezone };
}

// ---- One thread ------------------------------------------------------------------------------------

export type ThreadMessage = {
  id: string;
  direction: MessageDirection;
  kind: MessageKind;
  body: string | null;
  subject: string | null;
  templateName: string | null;
  quote: { number: string; versionNo: number } | null;
  quickReply: string | null;
  quickReplyLabel: string | null;
  status: MessageStatus;
  statusLabel: string;
  simulated: boolean;
  generatorLabel: string | null;
  sendIntent: SendIntent | null;
  automated: boolean;
  at: Date;
  approval: { id: string; status: string; flags: string[] } | null;
  attempt: { state: DispatchState; reasonCode: string | null; reasons: string[] } | null;
  /** Set while the send waits (pause, internal cap, provider throttle): the UI shows "Deferred until <time>". */
  deferredUntil: Date | null;
  /** One line explaining the outcome when the status alone does not (cancelled by takeover, blocked reason, deferral). */
  note: string | null;
};

export type ThreadEvent = { id: string; at: Date; kind: 'MODE' | 'ESCALATION' | 'CALL_REQUEST' | 'REVIEW'; label: string };

export type ComposerState = {
  channel: Channel;
  freeform: { eligible: boolean; deferrable: boolean; reasons: ReasonCode[]; labels: string[]; windowEndsAt: Date | null };
  templates: Array<{ id: string; name: string; language: string; category: string; variables: string[] }>;
  /** Why a template send cannot be used (null when an approved template can be sent). */
  templateGate: { category: 'configuration' | 'eligibility'; reason: string } | null;
};

export type InboxThread = {
  conversation: {
    id: string;
    channel: Channel;
    aiMode: ConversationAiMode;
    humanTakeover: boolean;
    modeVersion: number;
    lastInboundProviderAt: Date | null;
    unansweredOutboundCount: number;
    autoSendEnabled: boolean;
    autoAvailable: boolean;
  };
  lead: {
    id: string;
    displayName: string;
    city: string | null;
    category: string | null;
    salesStage: string;
    score: number | null;
    firstSource: string;
    simulated: boolean;
    phoneLast4: string | null;
    emailMasked: string | null;
  };
  quotes: Array<{ id: string; number: string; status: string; versionNo: number }>;
  messages: ThreadMessage[];
  events: ThreadEvent[];
  composer: ComposerState;
  permissions: { canSend: boolean; canDraft: boolean; canChangeMode: boolean; canSimulate: boolean };
  workspace: { name: string; slug: string; timezone: string };
  serverNow: Date;
};

const TAKEOVER_REASONS = new Set(['HUMAN_TAKEOVER', 'MODE_CHANGED']);

function noteFor(m: { direction: MessageDirection; initiatedBy: string | null; status: MessageStatus }, attempt: { state: DispatchState; reasonCode: string | null; errorRedacted: string | null } | null): string | null {
  if (m.direction === 'IN') return null;
  if (m.status === 'UNKNOWN') return `${DELIVERY_UNKNOWN_LABEL}: not retried automatically to avoid a duplicate.`;
  if (!attempt) return m.status === 'DRAFT' ? 'Not sent. Waiting for approval.' : null;
  const reasons = (attempt.errorRedacted ?? attempt.reasonCode ?? '').split(',').filter((r) => r.length > 0);
  if (attempt.state === 'SKIPPED' && reasons.some((r) => TAKEOVER_REASONS.has(r)) && m.initiatedBy === REPLY_INITIATOR) {
    return reasons.includes('HUMAN_TAKEOVER') ? 'AI reply cancelled by takeover' : 'AI reply cancelled: the conversation mode changed';
  }
  if (attempt.state === 'CANCELLED' && attempt.reasonCode === 'NEWER_INBOUND') return 'Superseded by a newer customer message';
  // T32: the channel's saved credential no longer decrypts (recorded beside NOT_CONFIGURED).
  if (attempt.state === 'SKIPPED' && reasons.includes('CREDENTIAL_UNREADABLE')) return 'Not sent: Credential unreadable, re-enter.';
  if (attempt.state === 'SKIPPED' || attempt.state === 'CANCELLED') return `Not sent: ${dispatchReasonLabel(attempt.reasonCode) ?? 'blocked before sending'}.`;
  if (attempt.state === 'FAILED') return `Failed: ${dispatchReasonLabel(attempt.reasonCode) ?? 'provider error'}.`;
  return null;
}

const MODE_EVENT_LABELS: Readonly<Record<string, (s: Record<string, unknown>) => string>> = {
  'conversation.takeover': () => 'You took over this conversation. AI replies paused.',
  'conversation.resume': () => 'AI resumed on this conversation.',
  'conversation.ai_mode': (s) => `AI mode changed to ${modeLabel(String(s.to ?? ''))}.`,
  'conversation.escalated': (s) => `Escalated to a person (${String(s.intent ?? 'needs review').replace(/_/g, ' ')}).`,
};

export function modeLabel(mode: string): string {
  return mode === 'OFF' ? 'Off' : mode === 'AUTO' ? 'Auto' : 'Draft for approval';
}

function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [user, domain] = email.split('@');
  if (!user || !domain) return null;
  return `${user.slice(0, 1)}***@${domain}`;
}

async function composerState(ctx: AppCtx, conversation: { id: string; leadId: string; channel: Channel }, deps: InboxDeps): Promise<ComposerState> {
  const eDeps = { contactKeyPepper: deps.contactKeyPepper, externalOutboundPause: deps.externalOutboundPause };
  const kind = conversation.channel === 'EMAIL' ? 'EMAIL' : 'WA_FREEFORM';
  const free = await checkDispatchEligibility(ctx.db, ctx, { leadId: conversation.leadId, channel: conversation.channel, kind, conversationId: conversation.id, sendIntent: 'MANUAL_SINGLE' }, eDeps);
  const freeform = { eligible: free.eligible, deferrable: free.deferrable, reasons: free.reasons, labels: free.reasons.map((r) => REASON_LABELS[r]), windowEndsAt: free.windowEndsAt };
  if (conversation.channel === 'EMAIL') return { channel: 'EMAIL', freeform, templates: [], templateGate: null };

  const rows = await ctx.db.whatsAppTemplate.findMany({ orderBy: [{ name: 'asc' }, { language: 'asc' }] });
  const templates = rows
    .filter((t) => t.status.trim().toUpperCase() === 'APPROVED')
    .map((t) => ({
      id: t.id,
      name: t.name,
      language: t.language,
      category: t.category,
      variables: Array.isArray(t.variableSchema) ? t.variableSchema.map((v) => (typeof v === 'string' ? v : typeof v === 'object' && v !== null && 'name' in v ? String((v as { name: unknown }).name) : '')).filter((v) => v.length > 0) : [],
    }));
  if (templates.length === 0) {
    return { channel: 'WHATSAPP', freeform, templates, templateGate: { category: 'configuration', reason: 'No approved WhatsApp template is synced. Templates come from WhatsApp Manager once WhatsApp is connected.' } };
  }
  const tpl = await checkDispatchEligibility(ctx.db, ctx, { leadId: conversation.leadId, channel: 'WHATSAPP', kind: 'WA_TEMPLATE', conversationId: conversation.id, sendIntent: 'MANUAL_SINGLE', templateId: templates[0]!.id }, eDeps);
  const blocking = tpl.reasons.filter((r) => r !== 'GLOBAL_PAUSED' && r !== 'CAP_REACHED');
  return {
    channel: 'WHATSAPP',
    freeform,
    templates,
    templateGate: tpl.eligible || tpl.deferrable || blocking.length === 0 ? null : { category: blocking[0] === 'NOT_CONFIGURED' ? 'configuration' : 'eligibility', reason: `${REASON_LABELS[blocking[0]!]}.` },
  };
}

export async function getInboxThread(ctx: AppCtx, conversationId: string, deps: InboxDeps): Promise<InboxThread> {
  requireCapability(ctx, 'leads.read');
  const workspaceId = requireWorkspace(ctx);
  const db = ctx.db;
  const now = ctx.clock.now();
  const conversation = await db.conversation.findFirst({ where: { id: conversationId } });
  if (!conversation) throw new NotFoundError();
  const [workspace, settings, lead, quotes, rows, audits, calls] = await Promise.all([
    db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true, slug: true, timezone: true } }),
    db.workspaceSettings.findFirst({ select: { autoSendEnabled: true } }),
    db.lead.findFirstOrThrow({
      where: { id: conversation.leadId },
      select: { id: true, displayName: true, city: true, category: true, salesStage: true, score: true, firstSource: true, simulated: true, phoneE164: true, emailNormalized: true },
    }),
    db.quote.findMany({ where: { leadId: conversation.leadId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 3 }),
    db.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: THREAD_MESSAGE_LIMIT,
      include: {
        template: { select: { name: true } },
        quoteVersion: { select: { versionNo: true, quote: { select: { number: true } } } },
        approvals: { orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], select: { id: true, status: true, flags: true } },
        dispatchAttempts: { orderBy: { attemptNo: 'desc' }, take: 1, include: { job: { select: { status: true, runAt: true } } } },
      },
    }),
    db.auditEvent.findMany({ where: { targetType: 'Conversation', targetId: conversation.id, action: { in: Object.keys(MODE_EVENT_LABELS) } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    db.callRequest.findMany({ where: { conversationId: conversation.id }, orderBy: { requestedAt: 'asc' } }),
  ]);
  const messages = [...rows].reverse();
  const inboundIds = messages.filter((m) => m.direction === 'IN').map((m) => m.id);
  const reviews = inboundIds.length > 0 ? await db.auditEvent.findMany({ where: { action: 'quick_reply.review', targetId: { in: inboundIds } }, select: { id: true, createdAt: true } }) : [];

  const events: ThreadEvent[] = [
    ...audits.map((a) => ({
      id: a.id,
      at: a.createdAt,
      kind: a.action === 'conversation.escalated' ? ('ESCALATION' as const) : ('MODE' as const),
      label: MODE_EVENT_LABELS[a.action]!((a.summary ?? {}) as Record<string, unknown>),
    })),
    ...calls.map((c) => ({ id: c.id, at: c.requestedAt, kind: 'CALL_REQUEST' as const, label: c.status === 'OPEN' ? 'Call requested. Call the customer back.' : `Call request ${c.status.toLowerCase()}.` })),
    ...reviews.map((r) => ({ id: r.id, at: r.createdAt, kind: 'REVIEW' as const, label: 'An unknown button reply arrived. Read it and answer by hand.' })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  const autoSendEnabled = settings?.autoSendEnabled ?? false;
  return {
    conversation: {
      id: conversation.id,
      channel: conversation.channel,
      aiMode: conversation.aiMode,
      humanTakeover: conversation.humanTakeover,
      modeVersion: conversation.modeVersion,
      lastInboundProviderAt: conversation.lastInboundProviderAt,
      unansweredOutboundCount: conversation.unansweredOutboundCount,
      autoSendEnabled,
      autoAvailable: autoSendEnabled && hasCapability(ctx, 'automation.manage'),
    },
    lead: {
      id: lead.id,
      displayName: lead.displayName,
      city: lead.city,
      category: lead.category,
      salesStage: lead.salesStage,
      score: lead.score,
      firstSource: lead.firstSource,
      simulated: lead.simulated,
      phoneLast4: lead.phoneE164 ? lead.phoneE164.slice(-4) : null,
      emailMasked: maskEmail(lead.emailNormalized),
    },
    quotes: quotes.map((q) => ({ id: q.id, number: q.number, status: effectiveQuoteStatus(q, now), versionNo: q.currentVersionNo })),
    messages: messages.map((m) => {
      const attempt = m.dispatchAttempts[0] ?? null;
      const deferredUntil = attempt && attempt.state === 'QUEUED' && attempt.job.status === 'QUEUED' && attempt.job.runAt.getTime() > now.getTime() ? attempt.job.runAt : null;
      const quick = m.direction === 'IN' ? quickReplyOf(m.variables) : null;
      const approval = m.approvals[0] ?? null;
      return {
        id: m.id,
        direction: m.direction,
        kind: m.kind,
        body: m.body,
        subject: m.subject,
        templateName: m.template?.name ?? null,
        quote: m.quoteVersion ? { number: m.quoteVersion.quote.number, versionNo: m.quoteVersion.versionNo } : null,
        quickReply: quick,
        quickReplyLabel: quick ? (QUICK_REPLY_LABELS[quick] ?? 'Tapped a button') : null,
        status: m.status,
        statusLabel: deliveryLabel(m.status),
        simulated: m.simulated,
        generatorLabel: m.generatorLabel,
        sendIntent: m.sendIntent,
        automated: m.sendIntent === 'AUTOMATED' || (m.initiatedBy ?? '').startsWith('system:'),
        at: m.providerTs ?? m.createdAt,
        approval: approval ? { id: approval.id, status: approval.status, flags: Array.isArray(approval.flags) ? approval.flags.filter((f): f is string => typeof f === 'string') : [] } : null,
        attempt: attempt ? { state: attempt.state, reasonCode: attempt.reasonCode, reasons: (attempt.errorRedacted ?? '').split(',').filter((r) => r.length > 0) } : null,
        deferredUntil,
        note: noteFor(m, attempt),
      };
    }),
    events,
    composer: await composerState(ctx, conversation, deps),
    permissions: {
      canSend: hasCapability(ctx, 'approvals.decide') && hasCapability(ctx, 'dispatch.send'),
      canDraft: hasCapability(ctx, 'leads.write'),
      canChangeMode: hasCapability(ctx, 'leads.write'),
      canSimulate: ctx.mode === 'demo' && hasCapability(ctx, 'leads.write'),
    },
    workspace,
    serverNow: now,
  };
}

// ---- Composer --------------------------------------------------------------------------------------

export type ComposerContent = { kind: 'TEXT' | 'TEMPLATE' | 'EMAIL'; body?: string; subject?: string; templateId?: string; variables?: Record<string, string> };
export type ComposerSendInput = ComposerContent & { conversationId: string; requestKey: string };
export type ComposerSendResult = { messageId: string; attemptId: string; jobId: string; approvalId: string; created: boolean; deferred: string[] | null };

function invalid(message: string): ValidationError {
  return new ValidationError({ code: 'MESSAGE_INVALID', message, userMessage: message });
}

function validateContent(channel: Channel, c: ComposerContent): void {
  if (channel === 'EMAIL') {
    if (c.kind !== 'EMAIL') throw invalid('This is an email conversation: write an email.');
    if (!c.subject?.trim() || c.subject.length > COMPOSER_LIMITS.subject) throw invalid(`Write a subject of up to ${COMPOSER_LIMITS.subject} characters.`);
    if (!c.body?.trim() || c.body.length > COMPOSER_LIMITS.emailBody) throw invalid(`Write a message of up to ${COMPOSER_LIMITS.emailBody} characters.`);
    return;
  }
  if (c.kind === 'TEMPLATE') {
    if (!c.templateId) throw invalid('Choose an approved template.');
    return;
  }
  if (c.kind !== 'TEXT') throw invalid('This is a WhatsApp conversation: write a message or choose a template.');
  if (!c.body?.trim() || c.body.length > COMPOSER_LIMITS.text) throw invalid(`Write a message of up to ${COMPOSER_LIMITS.text} characters.`);
}

const REVIEWABLE: ReadonlySet<ReasonCode> = new Set<ReasonCode>(['WINDOW_CLOSED', 'TEMPLATE_NOT_APPROVED', 'NOT_CONFIGURED', 'QUALITY_PAUSED']);

function messageContent(c: ComposerContent) {
  return {
    kind: c.kind,
    body: c.kind === 'TEMPLATE' ? null : (c.body ?? null),
    subject: c.kind === 'EMAIL' ? (c.subject ?? null) : null,
    templateId: c.kind === 'TEMPLATE' ? (c.templateId ?? null) : null,
    variables: c.kind === 'TEMPLATE' ? (c.variables ?? {}) : null,
  };
}

export async function sendComposerMessage(ctx: AppCtx, input: ComposerSendInput, deps: InboxDeps): Promise<ComposerSendResult> {
  requireCapability(ctx, 'approvals.decide');
  requireCapability(ctx, 'dispatch.send');
  const workspaceId = requireWorkspace(ctx);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(input.requestKey)) throw invalid('The request key is malformed.');
  const actorId = ctx.actor?.userId ?? `system:${ctx.kind}`;
  return withTx(ctx.db, async (tx) => {
    const conversation = await tx.conversation.findFirst({ where: { id: input.conversationId } });
    if (!conversation) throw new NotFoundError();
    const dedupeKey = `composer:${conversation.id}:${input.requestKey}`;
    // A repeat of the same request returns the dispatch it already queued (double click, retry).
    const existingJob = await tx.job.findFirst({ where: { idempotencyKey: idempotencyKey('dispatch', 'outbound', dedupeKey) }, select: { id: true } });
    if (existingJob) {
      const attempt = await tx.dispatchAttempt.findFirst({ where: { jobId: existingJob.id }, orderBy: { attemptNo: 'asc' }, select: { id: true, messageId: true, approvalId: true } });
      if (attempt) return { messageId: attempt.messageId, attemptId: attempt.id, jobId: existingJob.id, approvalId: attempt.approvalId ?? '', created: false, deferred: null };
    }
    validateContent(conversation.channel, input);
    const content = messageContent(input);
    const kind = dispatchKindOf({ channel: conversation.channel, kind: content.kind, templateId: content.templateId });
    const check = await checkDispatchEligibility(
      tx,
      ctx,
      { leadId: conversation.leadId, channel: conversation.channel, kind, conversationId: conversation.id, sendIntent: 'MANUAL_SINGLE', templateId: content.templateId },
      { contactKeyPepper: deps.contactKeyPepper, externalOutboundPause: deps.externalOutboundPause },
    );
    if (!check.eligible && !check.deferrable) {
      const blocking = check.reasons.filter((r) => r !== 'GLOBAL_PAUSED' && r !== 'CAP_REACHED');
      const reviewable = blocking.length > 0 && blocking.every((r) => REVIEWABLE.has(r));
      let next: 'TEMPLATE' | 'REVIEW' | 'NONE' = reviewable ? 'REVIEW' : 'NONE';
      if (reviewable && kind === 'WA_FREEFORM' && blocking.every((r) => r === 'WINDOW_CLOSED')) {
        const state = await composerState(ctx, conversation, deps);
        if (state.templates.length > 0 && state.templateGate === null) next = 'TEMPLATE';
      }
      throw new DomainRuleError({
        code: 'SEND_REFUSED',
        userMessage: `Not sent: ${REASON_LABELS[blocking[0] ?? check.reasons[0]!]}.`,
        safeDetails: { reasons: check.reasons, next },
      });
    }
    const queued = await queueOutboundMessage(tx, ctx, { ...content, leadId: conversation.leadId, channel: conversation.channel, sendIntent: 'MANUAL_SINGLE', initiatedBy: actorId, dedupeKey }, deps);
    let approvalId: string;
    if (queued.created) {
      const now = ctx.clock.now();
      const payloadHash = await messagePayloadHash(tx as unknown as PayloadReadDb, { workspaceId, messageId: queued.messageId }, deps.contactKeyPepper);
      approvalId = (
        await tx.approval.create({
          data: { workspaceId, kind: 'OUTBOUND_MESSAGE', status: 'APPROVED', messageId: queued.messageId, payloadHash, flags: ['composer'], requestedAt: now, decidedBy: actorId, decidedAt: now },
          select: { id: true },
        })
      ).id;
      await tx.dispatchAttempt.update({ where: { id: queued.attemptId }, data: { approvalId } });
      await recordAudit(tx, ctx, { action: 'message.send', targetType: 'Message', targetId: queued.messageId, simulated: ctx.mode === 'demo', summary: { channel: conversation.channel, kind: content.kind, approvalId, deferred: check.deferrable } });
    } else {
      approvalId = (await tx.dispatchAttempt.findFirstOrThrow({ where: { id: queued.attemptId }, select: { approvalId: true } })).approvalId ?? '';
    }
    return { messageId: queued.messageId, attemptId: queued.attemptId, jobId: queued.jobId, approvalId, created: queued.created, deferred: check.deferrable ? check.reasons.map((r) => REASON_LABELS[r]) : null };
  });
}

/** "Save for review": the text becomes a DRAFT message with a PENDING approval (nothing is sent). */
export async function saveComposerDraft(ctx: AppCtx, input: ComposerContent & { conversationId: string }, deps: InboxDeps): Promise<{ messageId: string; approvalId: string }> {
  requireCapability(ctx, 'leads.write');
  const conversation = await ctx.db.conversation.findFirst({ where: { id: input.conversationId }, select: { id: true, leadId: true, channel: true } });
  if (!conversation) throw new NotFoundError();
  validateContent(conversation.channel, input);
  const content = messageContent(input);
  const draft = await createMessageDraft(ctx, { leadId: conversation.leadId, channel: conversation.channel, ...content }, { contactKeyPepper: deps.contactKeyPepper });
  return { messageId: draft.messageId, approvalId: draft.approvalId };
}

// ---- DEMO inbound simulation picker --------------------------------------------------------------

export const SIMULATION_LEAD_LIMIT = 50;

/** Leads with a WhatsApp number the DEMO panel can make "send" a message (the simulator itself is T20's route). */
export async function listSimulationLeads(ctx: AppCtx): Promise<Array<{ id: string; displayName: string; phoneLast4: string; hasConversation: boolean }>> {
  requireCapability(ctx, 'leads.read');
  requireWorkspace(ctx);
  if (ctx.mode !== 'demo') return [];
  const leads = await ctx.db.lead.findMany({
    where: { mergedIntoLeadId: null, phoneE164: { not: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: SIMULATION_LEAD_LIMIT,
    select: { id: true, displayName: true, phoneE164: true },
  });
  const withThread = await ctx.db.conversation.findMany({ where: { leadId: { in: leads.map((l) => l.id) }, channel: 'WHATSAPP', closedAt: null }, select: { leadId: true } });
  const has = new Set(withThread.map((c) => c.leadId));
  return leads.map((l) => ({ id: l.id, displayName: l.displayName, phoneLast4: l.phoneE164!.slice(-4), hasConversation: has.has(l.id) }));
}

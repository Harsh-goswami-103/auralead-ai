/**
 * The Inbox of both panels (T22, R31, 06-design §11.2 "User Inbox", §11.3 rows Inbox / Composer /
 * Delivery / Takeover, F5, F6, F7; ADR-121 operator inbox, ADR-124 handed-over leads). Read models
 * for the thread list and one thread, and the composer's two actions. The client's pages call them
 * with the session's workspace, the operator's `[ws]` pages with the assignment's context; the
 * capabilities are checked here, not by role.
 *
 * What the browser gets is decided here, never computed in the UI (plan §7):
 *  - the window state (`windowEndsAt`) from `Conversation.lastInboundProviderAt` (C19, exclusive);
 *  - the composer's eligibility from the shared dispatch eligibility function for a person's
 *    single send (MANUAL_SINGLE), labelled "Final check happens at send" by the UI;
 *  - each message's delivery state (`Message.status`, "Delivery unknown" for UNKNOWN), with a note
 *    from its dispatch attempts: "AI reply cancelled by takeover" (SKIPPED HUMAN_TAKEOVER or
 *    MODE_CHANGED), superseded by a newer customer message, blocked reasons, deferrals;
 *  - template messages as WhatsApp shows them: header text or document name, body with its
 *    values, footer and buttons;
 *  - events: takeover, resume, AI mode changes, escalations, call requests, the handoff to the
 *    client ("Handed over to <client> by <operator>", from LeadHandoff);
 *  - what needs a person: drafts to approve, failed or unknown deliveries, call requests, takeover,
 *    and an escalation (`Conversation.escalatedAt`, ADR-122) that no person has answered since;
 *  - the handed-over state (`Lead.handedOverAt`): a badge for everyone, and a read-only thread for
 *    an operator (EMPLOYEE), whose sends and mode changes the services refuse anyway (409).
 *
 * Composer send (`sendComposerMessage`): the person who presses Send approves the message (needs
 * `approvals.decide` and `dispatch.send`). In one transaction the shared eligibility check runs; a
 * refusal (for example WINDOW_CLOSED one millisecond past the boundary) answers 422 `SEND_REFUSED`
 * with the reasons and the next action (an approved template, or review) and queues nothing, so the
 * UI keeps the draft and never shows "Sent". A template's values are resolved here for the lead
 * (`resolveLeadTemplateVariables`, ADR-123): lead and workspace sources from the rows, the other
 * positions from what the person typed; a missing value is 422 `TEMPLATE_VARIABLES_MISSING` with
 * the positions and reasons. Otherwise the message is queued through the outbox
 * (`queueOutboundMessage`, sendIntent MANUAL_SINGLE, initiatedBy the sender) with an APPROVED
 * OUTBOUND_MESSAGE approval carrying the payload hash (O3), keyed by the client's request key so a
 * double click or a retry queues one dispatch, and the thread's escalation is settled. The worker's
 * preflight re-checks everything at send. "Save for review" (`saveComposerDraft`) keeps the text
 * as a DRAFT with a PENDING approval.
 */
import type { Channel, ConversationAiMode, DispatchState, HandoffStatus, MessageDirection, MessageKind, MessageStatus, Prisma, SendIntent } from '@/generated/prisma/client';
import type { AppConfig } from '@/lib/config';
import {
  isLeadTemplateVariableSource,
  parseTemplateMapping,
  resolveLeadTemplateVariables,
  templateShape,
  NOT_SENDABLE_LABELS,
  TEMPLATE_VARIABLE_SOURCES,
  type MissingTemplateVariableReason,
  type TemplateVariableSource,
} from '@/lib/domain/whatsapp-templates';
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
import { assertNotHandedOver } from '@/server/services/leads/handoff-guard';
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

export const INBOX_FILTERS = ['all', 'needs_you', 'handed_over'] as const;
export type InboxFilterKey = (typeof INBOX_FILTERS)[number];

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

function previewOf(m: { body: string | null; subject: string | null; kind: MessageKind; variables: Prisma.JsonValue | null; direction: MessageDirection; templateName?: string | null }): string {
  const quick = m.direction === 'IN' ? quickReplyOf(m.variables) : null;
  if (quick) return QUICK_REPLY_LABELS[quick] ?? 'Tapped a button';
  if (m.body) return truncateAtWord(m.body, 140);
  if (m.subject) return truncateAtWord(m.subject, 140);
  if (m.kind === 'TEMPLATE') return m.templateName ? `Template: ${m.templateName}` : 'Template message';
  if (m.kind === 'DOCUMENT') return 'Quotation PDF';
  return 'Message';
}

// ---- Template bubbles (ADR-123 shapes, read-only) ----------------------------------------------------

/** A template message as the customer sees it. Unfilled positions stay `{{n}}`. */
export type TemplatePreview = {
  headerFormat: string | null;
  headerText: string | null;
  /** The document a DOCUMENT header carries: the brochure's file name, or the quotation PDF. */
  documentName: string | null;
  body: string;
  footer: string | null;
  buttons: Array<{ type: string; text: string }>;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function templatePreview(components: unknown, values: Readonly<Record<string, string>> | null, documentName: string | null): TemplatePreview {
  const list = Array.isArray(components) ? components.map(record) : [];
  const byType = (t: string) => list.find((c) => text(c.type).toUpperCase() === t) ?? null;
  const header = byType('HEADER');
  const headerFormat = header ? (text(header.format) || 'TEXT').toUpperCase() : null;
  const fill = (s: string) => s.replace(/\{\{\s*(\d+)\s*\}\}/g, (all, n: string) => values?.[String(Number(n))] ?? all);
  const buttons = Array.isArray(byType('BUTTONS')?.buttons) ? (byType('BUTTONS')!.buttons as unknown[]).map(record) : [];
  return {
    headerFormat,
    headerText: headerFormat === 'TEXT' ? text(header?.text) || null : null,
    documentName: headerFormat === 'DOCUMENT' ? documentName : null,
    body: fill(text(byType('BODY')?.text)),
    footer: text(byType('FOOTER')?.text) || null,
    buttons: buttons.map((b) => ({ type: text(b.type).toUpperCase(), text: text(b.text) })).filter((b) => b.text !== ''),
  };
}

function stringValues(variables: Prisma.JsonValue | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record(variables))) if (typeof v === 'string') out[k] = v;
  return out;
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
  /** An automated thread escalated (ADR-122) and no person has replied since. */
  escalated: boolean;
  /** The lead was handed over to the client (ADR-124). */
  handedOverAt: Date | null;
  needsYou: boolean;
};

export type InboxList = { rows: InboxThreadRow[]; counts: { all: number; needsYou: number; handedOver: number }; serverNow: Date; timezone: string };

/** The latest send a person made in each conversation (composer or approved draft): it settles an escalation made before it. */
async function lastPersonSendAt(db: AppCtx['db'], conversationIds: readonly string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (conversationIds.length === 0) return out;
  const attempts = await db.dispatchAttempt.findMany({
    where: { sendIntent: 'MANUAL_SINGLE', state: { notIn: ['CANCELLED', 'SKIPPED'] }, message: { conversationId: { in: [...conversationIds] } } },
    select: { createdAt: true, message: { select: { conversationId: true } } },
  });
  for (const a of attempts) {
    const prev = out.get(a.message.conversationId);
    if (!prev || prev.getTime() < a.createdAt.getTime()) out.set(a.message.conversationId, a.createdAt);
  }
  return out;
}

export async function listInboxThreads(ctx: AppCtx, input: { filter?: InboxFilterKey }): Promise<InboxList> {
  requireCapability(ctx, 'leads.read');
  const workspaceId = requireWorkspace(ctx);
  const now = ctx.clock.now();
  const db = ctx.db;
  const workspace = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { timezone: true } });
  const conversations = await db.conversation.findMany({
    where: { closedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: INBOX_THREAD_LIMIT,
    include: { lead: { select: { id: true, displayName: true, simulated: true, handedOverAt: true } } },
  });
  const ids = conversations.map((c) => c.id);
  const escalatedIds = conversations.filter((c) => c.escalatedAt !== null).map((c) => c.id);
  const [latest, pending, attention, calls, personSends] = await Promise.all([
    db.message.findMany({ where: { conversationId: { in: ids }, status: { not: 'NOT_SENT' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], distinct: ['conversationId'], include: { template: { select: { name: true } } } }),
    db.approval.findMany({ where: { status: 'PENDING', kind: 'OUTBOUND_MESSAGE', message: { conversationId: { in: ids } } }, select: { message: { select: { conversationId: true } } } }),
    db.message.findMany({ where: { conversationId: { in: ids }, direction: 'OUT', status: { in: ['FAILED', 'UNKNOWN'] } }, select: { conversationId: true } }),
    db.callRequest.findMany({ where: { conversationId: { in: ids }, status: 'OPEN' }, select: { conversationId: true } }),
    lastPersonSendAt(db, escalatedIds),
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
    const answered = personSends.get(c.id);
    const escalated = c.escalatedAt !== null && !(answered && answered.getTime() >= c.escalatedAt.getTime());
    return {
      conversationId: c.id,
      leadId: c.lead.id,
      leadName: c.lead.displayName,
      simulated: c.lead.simulated,
      channel: c.channel,
      aiMode: c.aiMode,
      humanTakeover: c.humanTakeover,
      lastMessage: last ? { direction: last.direction, preview: previewOf({ ...last, templateName: last.template?.name ?? null }), status: last.status, simulated: last.simulated, at: last.providerTs ?? last.createdAt } : null,
      lastActivityAt: last ? (last.providerTs ?? last.createdAt) : c.createdAt,
      windowOpen: open,
      windowEndsAt: open ? windowEndsAt(c.lastInboundProviderAt) : null,
      pendingApprovals,
      attentionDeliveries,
      openCallRequests,
      escalated,
      handedOverAt: c.lead.handedOverAt,
      needsYou: pendingApprovals > 0 || attentionDeliveries > 0 || openCallRequests > 0 || c.humanTakeover || escalated,
    };
  });
  all.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime() || a.conversationId.localeCompare(b.conversationId));
  const needsYou = all.filter((r) => r.needsYou);
  const handedOver = all.filter((r) => r.handedOverAt !== null);
  const rows = input.filter === 'needs_you' ? needsYou : input.filter === 'handed_over' ? handedOver : all;
  return { rows, counts: { all: all.length, needsYou: needsYou.length, handedOver: handedOver.length }, serverNow: now, timezone: workspace.timezone };
}

// ---- One thread ------------------------------------------------------------------------------------

export type ThreadMessage = {
  id: string;
  direction: MessageDirection;
  kind: MessageKind;
  body: string | null;
  subject: string | null;
  templateName: string | null;
  /** A template message as the customer sees it (null for other kinds). */
  template: TemplatePreview | null;
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

export type ThreadEvent = { id: string; at: Date; kind: 'MODE' | 'ESCALATION' | 'CALL_REQUEST' | 'REVIEW' | 'HANDOFF'; label: string };

/** One position of a template in the composer: filled from the lead, or typed by the person. */
export type ComposerTemplateField = {
  position: string;
  source: TemplateVariableSource;
  sourceLabel: string;
  /** Lead and workspace sources: the value for this lead (null when it has none). Typed positions: null. */
  value: string | null;
  /** The person types it (manual, quotation and AI sources); lead and workspace sources are not editable. */
  editable: boolean;
  /** Why a lead or workspace source has no value for this lead (the send is refused until it has one). */
  missing: MissingTemplateVariableReason | null;
};

export type ComposerTemplate = {
  id: string;
  name: string;
  language: string;
  category: string;
  /** The body positions, in order (kept for the variables map the send posts). */
  variables: string[];
  fields: ComposerTemplateField[];
  /** The bubble with this lead's values filled in (typed positions stay `{{n}}`). */
  preview: TemplatePreview;
  /** Null when this app can send the template's shape; otherwise why not. */
  notSendable: string | null;
};

export type ComposerState = {
  channel: Channel;
  freeform: { eligible: boolean; deferrable: boolean; reasons: ReasonCode[]; labels: string[]; windowEndsAt: Date | null };
  templates: ComposerTemplate[];
  /** Why a template send cannot be used (null when an approved template can be sent). */
  templateGate: { category: 'configuration' | 'eligibility'; reason: string } | null;
};

export type ThreadHandoff = { at: Date; clientName: string; operatorName: string | null; status: HandoffStatus; note: string | null };

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
    /** An escalation (ADR-122) no person has answered yet. */
    escalated: boolean;
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
    handedOverAt: Date | null;
  };
  /** The handoff to the client (ADR-124), when the lead was handed over. */
  handoff: ThreadHandoff | null;
  /** Set for an operator once the lead is handed over: the thread is read-only for them. */
  readOnly: { reason: string } | null;
  quotes: Array<{ id: string; number: string; status: string; versionNo: number }>;
  messages: ThreadMessage[];
  events: ThreadEvent[];
  composer: ComposerState;
  permissions: { canSend: boolean; canDraft: boolean; canChangeMode: boolean; canSimulate: boolean; canManageAutomation: boolean };
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

function escalationLabel(s: Record<string, unknown>): string {
  if (s.reason === 'REPLY_CAP') return 'Escalated to a person after several automated replies in a row. Replies now wait for approval.';
  const intent = String(s.intent ?? 'needs review').replace(/_/g, ' ');
  if (s.fromMode === 'AUTO' && s.toMode === 'AUTO') return `Needs a person (${intent}). Automatic replies stay on.`;
  return `Escalated to a person (${intent}).`;
}

const MODE_EVENT_LABELS: Readonly<Record<string, (s: Record<string, unknown>) => string>> = {
  'conversation.takeover': () => 'You took over this conversation. AI replies paused.',
  'conversation.resume': () => 'AI resumed on this conversation.',
  'conversation.ai_mode': (s) => `AI mode changed to ${modeLabel(String(s.to ?? ''))}.`,
  'conversation.escalated': escalationLabel,
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

type TemplateRow = { id: string; name: string; language: string; category: string; status: string; components: Prisma.JsonValue; variableMap: Prisma.JsonValue; headerMedia: { fileName: string } | null };

/** One approved template for this lead: its positions with their sources and this lead's values (ADR-123). */
function composerTemplate(t: TemplateRow, lead: { displayName: string; city: string | null; category: string | null }, workspace: { name: string }): ComposerTemplate {
  const shape = templateShape(t.components);
  const mapping = parseTemplateMapping(t.variableMap);
  const resolved = resolveLeadTemplateVariables({ positions: shape.bodyVariables, sources: mapping.body }, lead, workspace);
  const missingAt = new Map(resolved.missing.map((m) => [m.position, m.reason]));
  const fields = shape.bodyVariables.map((position): ComposerTemplateField => {
    const source: TemplateVariableSource = mapping.body[position] ?? 'manual';
    const fromLead = isLeadTemplateVariableSource(source);
    return {
      position,
      source,
      sourceLabel: TEMPLATE_VARIABLE_SOURCES[source],
      value: fromLead ? (resolved.values[position] ?? null) : null,
      editable: !fromLead,
      missing: fromLead ? (missingAt.get(position) ?? null) : null,
    };
  });
  return {
    id: t.id,
    name: t.name,
    language: t.language,
    category: t.category,
    variables: shape.bodyVariables,
    fields,
    preview: templatePreview(t.components, resolved.values, t.headerMedia?.fileName ?? (shape.documentHeader ? 'Quotation PDF' : null)),
    notSendable: shape.sendable.ok ? null : NOT_SENDABLE_LABELS[shape.sendable.reason],
  };
}

async function composerState(
  ctx: AppCtx,
  conversation: { id: string; leadId: string; channel: Channel },
  facts: { lead: { displayName: string; city: string | null; category: string | null }; workspace: { name: string } },
  deps: InboxDeps,
): Promise<ComposerState> {
  const eDeps = { contactKeyPepper: deps.contactKeyPepper, externalOutboundPause: deps.externalOutboundPause };
  const kind = conversation.channel === 'EMAIL' ? 'EMAIL' : 'WA_FREEFORM';
  const free = await checkDispatchEligibility(ctx.db, ctx, { leadId: conversation.leadId, channel: conversation.channel, kind, conversationId: conversation.id, sendIntent: 'MANUAL_SINGLE' }, eDeps);
  const freeform = { eligible: free.eligible, deferrable: free.deferrable, reasons: free.reasons, labels: free.reasons.map((r) => REASON_LABELS[r]), windowEndsAt: free.windowEndsAt };
  if (conversation.channel === 'EMAIL') return { channel: 'EMAIL', freeform, templates: [], templateGate: null };

  const rows = await ctx.db.whatsAppTemplate.findMany({ orderBy: [{ name: 'asc' }, { language: 'asc' }], include: { headerMedia: { select: { fileName: true } } } });
  const templates = rows.filter((t) => t.status.trim().toUpperCase() === 'APPROVED').map((t) => composerTemplate(t, facts.lead, facts.workspace));
  if (templates.length === 0) {
    return { channel: 'WHATSAPP', freeform, templates, templateGate: { category: 'configuration', reason: 'No approved WhatsApp template yet. Approved templates appear here once WhatsApp is connected.' } };
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

function formatDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone, day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

export async function getInboxThread(ctx: AppCtx, conversationId: string, deps: InboxDeps): Promise<InboxThread> {
  requireCapability(ctx, 'leads.read');
  const workspaceId = requireWorkspace(ctx);
  const db = ctx.db;
  const now = ctx.clock.now();
  const conversation = await db.conversation.findFirst({ where: { id: conversationId } });
  if (!conversation) throw new NotFoundError();
  const [workspace, settings, lead, quotes, rows, audits, calls, handoffRow] = await Promise.all([
    db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true, slug: true, timezone: true } }),
    db.workspaceSettings.findFirst({ select: { autoSendEnabled: true } }),
    db.lead.findFirstOrThrow({
      where: { id: conversation.leadId },
      select: { id: true, displayName: true, city: true, category: true, salesStage: true, score: true, firstSource: true, simulated: true, phoneE164: true, emailNormalized: true, handedOverAt: true },
    }),
    db.quote.findMany({ where: { leadId: conversation.leadId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 3 }),
    db.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: THREAD_MESSAGE_LIMIT,
      include: {
        template: { select: { name: true, components: true, headerMedia: { select: { fileName: true } } } },
        quoteVersion: { select: { versionNo: true, quote: { select: { number: true } } } },
        approvals: { orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], select: { id: true, status: true, flags: true } },
        dispatchAttempts: { orderBy: { attemptNo: 'desc' }, take: 1, include: { job: { select: { status: true, runAt: true } } } },
      },
    }),
    db.auditEvent.findMany({ where: { targetType: 'Conversation', targetId: conversation.id, action: { in: Object.keys(MODE_EVENT_LABELS) } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    db.callRequest.findMany({ where: { conversationId: conversation.id }, orderBy: { requestedAt: 'asc' } }),
    db.leadHandoff.findFirst({ where: { leadId: conversation.leadId } }),
  ]);
  const messages = [...rows].reverse();
  const inboundIds = messages.filter((m) => m.direction === 'IN').map((m) => m.id);
  const reviews = inboundIds.length > 0 ? await db.auditEvent.findMany({ where: { action: 'quick_reply.review', targetId: { in: inboundIds } }, select: { id: true, createdAt: true } }) : [];

  let handoff: ThreadHandoff | null = null;
  if (handoffRow) {
    const operator = await db.user.findUnique({ where: { id: handoffRow.fromUserId }, select: { name: true } });
    handoff = { at: handoffRow.createdAt, clientName: workspace.name, operatorName: operator?.name ?? null, status: handoffRow.status, note: handoffRow.note };
  } else if (lead.handedOverAt) {
    handoff = { at: lead.handedOverAt, clientName: workspace.name, operatorName: null, status: 'HANDED_OVER', note: null };
  }

  const events: ThreadEvent[] = [
    ...audits.map((a) => ({
      id: a.id,
      at: a.createdAt,
      kind: a.action === 'conversation.escalated' ? ('ESCALATION' as const) : ('MODE' as const),
      label: MODE_EVENT_LABELS[a.action]!((a.summary ?? {}) as Record<string, unknown>),
    })),
    ...calls.map((c) => ({ id: c.id, at: c.requestedAt, kind: 'CALL_REQUEST' as const, label: c.status === 'OPEN' ? 'Call requested. Call the customer back.' : `Call request ${c.status.toLowerCase()}.` })),
    ...reviews.map((r) => ({ id: r.id, at: r.createdAt, kind: 'REVIEW' as const, label: 'An unknown button reply arrived. Read it and answer by hand.' })),
    ...(handoff
      ? [{ id: handoffRow?.id ?? `handoff:${lead.id}`, at: handoff.at, kind: 'HANDOFF' as const, label: `Handed over to ${handoff.clientName}${handoff.operatorName ? ` by ${handoff.operatorName}` : ''}.` }]
      : []),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  // ADR-124: once handed over, an operator reads the thread but no longer acts on it.
  const readOnly = lead.handedOverAt && ctx.actor?.role === 'EMPLOYEE' ? { reason: `Handed over to ${workspace.name} on ${formatDay(lead.handedOverAt, workspace.timezone)}. Only the client messages this lead now.` } : null;
  const escalationAnswered = conversation.escalatedAt ? (await lastPersonSendAt(db, [conversation.id])).get(conversation.id) : undefined;
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
      autoAvailable: autoSendEnabled && hasCapability(ctx, 'automation.manage') && readOnly === null,
      escalated: conversation.escalatedAt !== null && !(escalationAnswered && escalationAnswered.getTime() >= conversation.escalatedAt.getTime()),
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
      handedOverAt: lead.handedOverAt,
    },
    handoff,
    readOnly,
    quotes: quotes.map((q) => ({ id: q.id, number: q.number, status: effectiveQuoteStatus(q, now), versionNo: q.currentVersionNo })),
    messages: messages.map((m) => {
      const attempt = m.dispatchAttempts[0] ?? null;
      const deferredUntil = attempt && attempt.state === 'QUEUED' && attempt.job.status === 'QUEUED' && attempt.job.runAt.getTime() > now.getTime() ? attempt.job.runAt : null;
      const quick = m.direction === 'IN' ? quickReplyOf(m.variables) : null;
      const approval = m.approvals[0] ?? null;
      const quote = m.quoteVersion ? { number: m.quoteVersion.quote.number, versionNo: m.quoteVersion.versionNo } : null;
      const documentName = m.template?.headerMedia?.fileName ?? (quote ? `Quotation ${quote.number} v${quote.versionNo} (PDF)` : 'Quotation PDF');
      return {
        id: m.id,
        direction: m.direction,
        kind: m.kind,
        body: m.body,
        subject: m.subject,
        templateName: m.template?.name ?? null,
        template: m.kind === 'TEMPLATE' && m.template ? templatePreview(m.template.components, stringValues(m.variables), documentName) : null,
        quote,
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
    composer: await composerState(ctx, conversation, { lead, workspace }, deps),
    permissions: {
      canSend: readOnly === null && hasCapability(ctx, 'approvals.decide') && hasCapability(ctx, 'dispatch.send'),
      canDraft: readOnly === null && hasCapability(ctx, 'leads.write'),
      canChangeMode: readOnly === null && hasCapability(ctx, 'leads.write'),
      canSimulate: ctx.mode === 'demo' && hasCapability(ctx, 'leads.write'),
      canManageAutomation: hasCapability(ctx, 'automation.manage'),
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

const MISSING_LABELS: Readonly<Record<MissingTemplateVariableReason, string>> = {
  NO_VALUE: 'this lead has no value for it',
  NOT_PROVIDED: 'it was left empty',
  NEEDS_CONTEXT: 'it was left empty',
  TOO_LONG: 'it is longer than 200 characters',
};

function messageContent(c: ComposerContent) {
  return {
    kind: c.kind,
    body: c.kind === 'TEMPLATE' ? null : (c.body ?? null),
    subject: c.kind === 'EMAIL' ? (c.subject ?? null) : null,
    templateId: c.kind === 'TEMPLATE' ? (c.templateId ?? null) : null,
    variables: c.kind === 'TEMPLATE' ? (c.variables ?? {}) : null,
  };
}

/**
 * A template's values for this lead (ADR-123): lead and workspace sources from the rows, other
 * positions from what the person typed. Refuses a template this app cannot send or a missing value.
 */
async function templateValues(tx: Pick<AppCtx['db'], 'whatsAppTemplate' | 'lead' | 'workspace'>, ctx: AppCtx, leadId: string, input: { templateId: string; variables: Record<string, string> }): Promise<Record<string, string>> {
  const template = await tx.whatsAppTemplate.findFirst({ where: { id: input.templateId }, select: { components: true, variableMap: true } });
  if (!template) throw new NotFoundError();
  const shape = templateShape(template.components);
  if (!shape.sendable.ok) {
    throw new DomainRuleError({ code: 'TEMPLATE_NOT_SENDABLE', userMessage: `Not sent: this template ${NOT_SENDABLE_LABELS[shape.sendable.reason].replace(/^Has/, 'has').replace(/^Uses/, 'uses')}.`, safeDetails: { reason: shape.sendable.reason } });
  }
  const lead = await tx.lead.findFirstOrThrow({ where: { id: leadId }, select: { displayName: true, city: true, category: true } });
  const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: requireWorkspace(ctx) }, select: { name: true } });
  const resolved = resolveLeadTemplateVariables({ positions: shape.bodyVariables, sources: parseTemplateMapping(template.variableMap).body, literals: input.variables }, lead, workspace);
  if (!resolved.ok) {
    const first = resolved.missing[0]!;
    throw new DomainRuleError({
      code: 'TEMPLATE_VARIABLES_MISSING',
      userMessage: `Not sent: template value {{${first.position}}} (${TEMPLATE_VARIABLE_SOURCES[first.source]}) is missing because ${MISSING_LABELS[first.reason]}.`,
      safeDetails: { missing: resolved.missing },
    });
  }
  return resolved.values;
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
    // ADR-124: an operator's composer is closed for a handed-over lead, whatever the window says.
    await assertNotHandedOver(tx, ctx, conversation.leadId);
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
        const lead = await tx.lead.findFirstOrThrow({ where: { id: conversation.leadId }, select: { displayName: true, city: true, category: true } });
        const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } });
        const state = await composerState(ctx, conversation, { lead, workspace }, deps);
        if (state.templates.length > 0 && state.templateGate === null) next = 'TEMPLATE';
      }
      throw new DomainRuleError({
        code: 'SEND_REFUSED',
        userMessage: `Not sent: ${REASON_LABELS[blocking[0] ?? check.reasons[0]!]}.`,
        safeDetails: { reasons: check.reasons, next },
      });
    }
    if (content.kind === 'TEMPLATE' && content.templateId) {
      content.variables = await templateValues(tx, ctx, conversation.leadId, { templateId: content.templateId, variables: content.variables ?? {} });
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
      // ADR-122: a person's reply settles the thread's escalation ("Needs you").
      if (conversation.escalatedAt !== null) await tx.conversation.updateMany({ where: { id: conversation.id }, data: { escalatedAt: null } });
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

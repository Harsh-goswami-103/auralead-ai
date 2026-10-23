/**
 * The approval queue (T22, R32, 06-design §11.2 "Approvals", F18, §11.3 "Approvals queue"): every
 * PENDING quote-version and outbound-message approval of one workspace, oldest first, with what the
 * approver must see before deciding, and the decisions themselves.
 *
 *  - Reading needs `leads.read`; a reader without `approvals.decide` sees the queue read-only.
 *  - An item names its lead, the quote version (current or not, PDF ready or not) or the message
 *    draft, its flags (`customer_requested`, `ai_reply`, `pipeline_first_touch`, ...), and the
 *    outcome of its dispatch once sent ("Approved but dispatch deferred/blocked: shows reason").
 *  - The item view adds the version diff against the previous version (F18: quantity, unit price,
 *    discount, tax, total), the pricing checks, the dispatch history and one entry per channel with
 *    the shared dispatch eligibility (plan §7: the same function backs the approval queue badge)
 *    for a person's single send (MANUAL_SINGLE). A channel that cannot be used carries the reason
 *    category GatedAction shows (configuration, eligibility).
 *  - Decisions bind what was on screen: approve and approve-and-send carry the version number, and
 *    an item whose approval is no longer open or whose version is no longer current answers 409
 *    `APPROVAL_CHANGED` ("This item changed since you opened it"); nothing is approved.
 *    Approve-and-send is the T19 transaction (`approveAndSendQuote` / `approveAndSendMessage`),
 *    idempotent per version and channel, so double clicks and retries create one dispatch.
 *  - Edits go through `reviseQuote` (a new version priced by the server; the actor's own discount
 *    cap gives 403 `DISCOUNT_OVER_ACTOR_CAP`, plan §8). Reject closes the item, audited with the
 *    reason; a rejected message draft becomes NOT_SENT.
 */
import type { ApprovalKind, ApprovalStatus, Channel, DispatchState, MessageKind, MessageStatus, Prisma, QuoteStatus } from '@/generated/prisma/client';
import { ConflictError, DomainRuleError, NotFoundError, QuoteVersionConflictError, ValidationError } from '@/lib/errors';
import { truncateAtWord } from '@/lib/format/text';
import { parsePaise } from '@/lib/money';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { recordAudit } from '@/server/services/audit/record';
import { approveAndSendMessage, approveAndSendQuote, dispatchKindOf, type ApproveAndSendResult } from '@/server/services/messaging/dispatch';
import { checkDispatchEligibility, REASON_LABELS, type EligibilityDeps, type ReasonCode } from '@/server/services/messaging/eligibility';
import { approveQuote, effectiveQuoteStatus, reviseQuote, type QuoteWriteResult } from '@/server/services/quotes/versioning';

export const QUEUE_PENDING_LIMIT = 200;
export const QUEUE_RECENT_LIMIT = 20;

export const APPROVAL_CHANGED_MESSAGE = 'This item changed since you opened it. Reload to see the current version.';

export function approvalChanged(details?: Record<string, unknown>): ConflictError {
  return new ConflictError({ code: 'APPROVAL_CHANGED', userMessage: APPROVAL_CHANGED_MESSAGE, ...(details ? { safeDetails: details } : {}) });
}

/** Labels for dispatch reasons beyond the eligibility codes (preflight, cancellations, provider failures). */
const EXTRA_REASON_LABELS: Readonly<Record<string, string>> = {
  APPROVAL_STALE: 'The content changed after approval',
  SUPERSEDED: 'A newer version replaced this one',
  QUOTE_EXPIRED: 'The quotation expired',
  QUOTE_CANCELLED: 'The quotation was cancelled',
  ARTIFACT_MISSING: 'The quotation PDF was missing',
  CONTACT_MISSING: 'The lead has no contact on this channel',
  NEWER_INBOUND: 'Superseded by a newer customer message',
  SUPPRESSED: 'The contact opted out on this channel',
  // Lead-gen F5 (ADR-132): a queued send the lead's handoff to the client cancelled.
  LEAD_HANDED_OVER: 'The lead was handed over to the client',
};

export function dispatchReasonLabel(code: string | null): string | null {
  if (code === null) return null;
  return (REASON_LABELS as Record<string, string>)[code] ?? EXTRA_REASON_LABELS[code] ?? code;
}

const strings = (value: Prisma.JsonValue | null | undefined): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []);

export type QueueQuote = {
  id: string;
  number: string;
  versionNo: number;
  currentVersionNo: number;
  isCurrent: boolean;
  status: QuoteStatus;
  effectiveStatus: QuoteStatus;
  totalPaise: bigint;
  needsPricingReview: boolean;
  pdfReady: boolean;
};

export type QueueMessage = { id: string; channel: Channel; kind: MessageKind; preview: string; subject: string | null; generatorLabel: string | null; status: MessageStatus; simulated: boolean; conversationId: string };

export type QueueDispatch = { state: DispatchState; channel: Channel; reasonCode: string | null; reasonLabel: string | null; deferredUntil: Date | null };

export type ApprovalQueueItem = {
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  flags: string[];
  requestedAt: Date;
  decidedAt: Date | null;
  decidedByName: string | null;
  invalidationReason: string | null;
  lead: { id: string; displayName: string };
  quote: QueueQuote | null;
  message: QueueMessage | null;
  dispatch: QueueDispatch | null;
};

export type QueuePermissions = { canDecide: boolean; canSend: boolean; canEdit: boolean };

export type ApprovalQueue = {
  workspace: { id: string; slug: string; name: string; timezone: string };
  pending: ApprovalQueueItem[];
  recent: ApprovalQueueItem[];
  permissions: QueuePermissions;
};

function permissionsOf(ctx: AppCtx): QueuePermissions {
  return {
    canDecide: hasCapability(ctx, 'approvals.decide'),
    canSend: hasCapability(ctx, 'approvals.decide') && hasCapability(ctx, 'dispatch.send'),
    canEdit: hasCapability(ctx, 'quotes.edit'),
  };
}

type ApprovalRow = Prisma.ApprovalGetPayload<object>;

async function buildItems(ctx: AppCtx, rows: ApprovalRow[]): Promise<ApprovalQueueItem[]> {
  if (rows.length === 0) return [];
  const db = ctx.db;
  const now = ctx.clock.now();
  const quoteIds = [...new Set(rows.map((r) => r.quoteId).filter((x): x is string => x !== null))];
  const versionIds = [...new Set(rows.map((r) => r.quoteVersionId).filter((x): x is string => x !== null))];
  const messageIds = [...new Set(rows.map((r) => r.messageId).filter((x): x is string => x !== null))];
  const [quotes, versions, artifacts, messages, attempts] = await Promise.all([
    db.quote.findMany({ where: { id: { in: quoteIds } } }),
    db.quoteVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, versionNo: true, totalPaise: true } }),
    db.quoteArtifact.findMany({ where: { quoteVersionId: { in: versionIds } }, select: { quoteVersionId: true } }),
    db.message.findMany({ where: { id: { in: messageIds } }, include: { conversation: { select: { leadId: true } } } }),
    db.dispatchAttempt.findMany({ where: { approvalId: { in: rows.map((r) => r.id) } }, orderBy: [{ createdAt: 'desc' }, { attemptNo: 'desc' }], include: { job: { select: { status: true, runAt: true } } } }),
  ]);
  const quoteOf = new Map(quotes.map((q) => [q.id, q]));
  const versionOf = new Map(versions.map((v) => [v.id, v]));
  const pdfReady = new Set(artifacts.map((a) => a.quoteVersionId));
  const messageOf = new Map(messages.map((m) => [m.id, m]));
  const leadIds = [...new Set([...quotes.map((q) => q.leadId), ...messages.map((m) => m.conversation.leadId)])];
  const leads = await db.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, displayName: true } });
  const leadOf = new Map(leads.map((l) => [l.id, l]));
  const deciders = [...new Set(rows.map((r) => r.decidedBy).filter((x): x is string => x !== null && !x.startsWith('system:')))];
  const users = deciders.length > 0 ? await db.user.findMany({ where: { id: { in: deciders } }, select: { id: true, name: true } }) : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const latestAttempt = new Map<string, (typeof attempts)[number]>();
  for (const a of attempts) if (a.approvalId && !latestAttempt.has(a.approvalId)) latestAttempt.set(a.approvalId, a);

  const items: ApprovalQueueItem[] = [];
  for (const r of rows) {
    const quote = r.quoteId ? quoteOf.get(r.quoteId) : undefined;
    const version = r.quoteVersionId ? versionOf.get(r.quoteVersionId) : undefined;
    const message = r.messageId ? messageOf.get(r.messageId) : undefined;
    const leadId = quote?.leadId ?? message?.conversation.leadId;
    const lead = leadId ? leadOf.get(leadId) : undefined;
    if (!lead) continue;
    const attempt = latestAttempt.get(r.id);
    items.push({
      id: r.id,
      kind: r.kind,
      status: r.status,
      flags: strings(r.flags),
      requestedAt: r.requestedAt,
      decidedAt: r.decidedAt,
      decidedByName: r.decidedBy ? (nameOf.get(r.decidedBy) ?? null) : null,
      invalidationReason: r.invalidationReason,
      lead,
      quote:
        quote && version
          ? {
              id: quote.id,
              number: quote.number,
              versionNo: version.versionNo,
              currentVersionNo: quote.currentVersionNo,
              isCurrent: quote.currentVersionId === version.id,
              status: quote.status,
              effectiveStatus: effectiveQuoteStatus(quote, now),
              totalPaise: version.totalPaise,
              needsPricingReview: quote.needsPricingReview,
              pdfReady: pdfReady.has(version.id),
            }
          : null,
      message: message
        ? {
            id: message.id,
            channel: message.channel,
            kind: message.kind,
            preview: truncateAtWord(message.body ?? message.subject ?? '', 160),
            subject: message.subject,
            generatorLabel: message.generatorLabel,
            status: message.status,
            simulated: message.simulated,
            conversationId: message.conversationId,
          }
        : null,
      dispatch: attempt
        ? {
            state: attempt.state,
            channel: attempt.channel,
            reasonCode: attempt.reasonCode,
            reasonLabel: dispatchReasonLabel(attempt.reasonCode),
            deferredUntil: attempt.state === 'QUEUED' && attempt.job.status === 'QUEUED' && attempt.job.runAt.getTime() > now.getTime() ? attempt.job.runAt : null,
          }
        : null,
    });
  }
  return items;
}

const QUEUE_KINDS: ApprovalKind[] = ['QUOTE_VERSION', 'OUTBOUND_MESSAGE'];

export async function listApprovalQueue(ctx: AppCtx): Promise<ApprovalQueue> {
  requireCapability(ctx, 'leads.read');
  const workspaceId = requireWorkspace(ctx);
  const workspace = await ctx.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { id: true, slug: true, name: true, timezone: true } });
  const [pendingRows, recentRows] = await Promise.all([
    ctx.db.approval.findMany({ where: { status: 'PENDING', kind: { in: QUEUE_KINDS } }, orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }], take: QUEUE_PENDING_LIMIT }),
    ctx.db.approval.findMany({ where: { status: { in: ['APPROVED', 'REJECTED'] }, kind: { in: QUEUE_KINDS }, decidedAt: { not: null } }, orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }], take: QUEUE_RECENT_LIMIT }),
  ]);
  const [pending, recent] = await Promise.all([buildItems(ctx, pendingRows), buildItems(ctx, recentRows)]);
  return { workspace, pending, recent, permissions: permissionsOf(ctx) };
}

// ---- One item --------------------------------------------------------------------------------------

export type ChannelGate = { category: 'configuration' | 'permission' | 'mode' | 'eligibility'; reason: string };

export type ChannelOption = {
  channel: Channel;
  /** Why this channel cannot be used now (null: it can). */
  gate: ChannelGate | null;
  eligibility: { eligible: boolean; deferrable: boolean; reasons: ReasonCode[]; labels: string[] } | null;
  templates: Array<{ id: string; name: string; language: string; category: string }>;
};

export type VersionLine = { serviceId: string; name: string; unitLabel: string; qty: number; unitPricePaise: bigint; lineTotalPaise: bigint };

export type VersionView = {
  id: string;
  versionNo: number;
  lines: VersionLine[];
  scopeText: string;
  timelineText: string;
  discountKind: string;
  discountValue: bigint;
  subtotalPaise: bigint;
  discountPaise: bigint;
  taxLabel: string | null;
  taxBps: number | null;
  taxPaise: bigint;
  totalPaise: bigint;
  validUntil: Date;
  pricingVersionId: string;
  reviewReasons: Prisma.JsonValue;
  aiPolicyFlags: string[];
};

export type DiffLine = {
  serviceId: string;
  name: string;
  change: 'ADDED' | 'REMOVED' | 'CHANGED' | 'SAME';
  fromQty: number | null;
  toQty: number | null;
  fromUnitPricePaise: bigint | null;
  toUnitPricePaise: bigint | null;
  fromLineTotalPaise: bigint | null;
  toLineTotalPaise: bigint | null;
};

export type VersionDiff = {
  fromVersionNo: number;
  toVersionNo: number;
  /** What happened to the previous version's approval (APPROVED then INVALIDATED, REJECTED, ...). */
  previousApproval: ApprovalStatus | null;
  lines: DiffLine[];
  discount: { from: bigint; to: bigint };
  tax: { from: bigint; to: bigint };
  totals: { from: bigint; to: bigint };
};

export type AttemptView = { id: string; attemptNo: number; channel: Channel; state: DispatchState; reasonCode: string | null; reasonLabel: string | null; createdAt: Date; updatedAt: Date };

export type ApprovalItemDetail = {
  item: ApprovalQueueItem;
  workspace: { slug: string; name: string; timezone: string };
  version: VersionView | null;
  diff: VersionDiff | null;
  message: { body: string | null; subject: string | null; templateName: string | null; variables: Record<string, string> } | null;
  channels: ChannelOption[];
  attempts: AttemptView[];
  validityPassed: boolean;
  /** When this item's version was replaced: the approval of the quote's current version (the item to open instead). */
  currentApprovalId: string | null;
  /** For the editor: the item's quote and its pricing version number. */
  quoteRef: { quoteId: string; pricingVersionNo: number | null } | null;
  permissions: QueuePermissions;
};

export type QueueDeps = EligibilityDeps;

function versionView(v: Prisma.QuoteVersionGetPayload<{ include: { items: true } }>): VersionView {
  return {
    id: v.id,
    versionNo: v.versionNo,
    lines: [...v.items].sort((a, b) => a.position - b.position).map((i) => ({ serviceId: i.serviceId, name: i.serviceNameSnapshot, unitLabel: i.unitLabel, qty: i.qty, unitPricePaise: i.unitPricePaise, lineTotalPaise: i.lineTotalPaise })),
    scopeText: v.scopeText,
    timelineText: v.timelineText,
    discountKind: v.discountKind,
    discountValue: v.discountValue,
    subtotalPaise: v.subtotalPaise,
    discountPaise: v.discountPaise,
    taxLabel: v.taxLabel,
    taxBps: v.taxBps,
    taxPaise: v.taxPaise,
    totalPaise: v.totalPaise,
    validUntil: v.validUntil,
    pricingVersionId: v.pricingVersionId,
    reviewReasons: v.reviewReasons,
    aiPolicyFlags: strings(v.aiPolicyFlags),
  };
}

export function diffVersions(from: VersionView, to: VersionView, previousApproval: ApprovalStatus | null): VersionDiff {
  const before = new Map(from.lines.map((l) => [l.serviceId, l]));
  const after = new Map(to.lines.map((l) => [l.serviceId, l]));
  const lines: DiffLine[] = [];
  for (const l of to.lines) {
    const b = before.get(l.serviceId);
    const same = b !== undefined && b.qty === l.qty && b.unitPricePaise === l.unitPricePaise;
    lines.push({
      serviceId: l.serviceId,
      name: l.name,
      change: b === undefined ? 'ADDED' : same ? 'SAME' : 'CHANGED',
      fromQty: b?.qty ?? null,
      toQty: l.qty,
      fromUnitPricePaise: b?.unitPricePaise ?? null,
      toUnitPricePaise: l.unitPricePaise,
      fromLineTotalPaise: b?.lineTotalPaise ?? null,
      toLineTotalPaise: l.lineTotalPaise,
    });
  }
  for (const b of from.lines) {
    if (after.has(b.serviceId)) continue;
    lines.push({ serviceId: b.serviceId, name: b.name, change: 'REMOVED', fromQty: b.qty, toQty: null, fromUnitPricePaise: b.unitPricePaise, toUnitPricePaise: null, fromLineTotalPaise: b.lineTotalPaise, toLineTotalPaise: null });
  }
  return {
    fromVersionNo: from.versionNo,
    toVersionNo: to.versionNo,
    previousApproval,
    lines,
    discount: { from: from.discountPaise, to: to.discountPaise },
    tax: { from: from.taxPaise, to: to.taxPaise },
    totals: { from: from.totalPaise, to: to.totalPaise },
  };
}

function gateFor(reasons: readonly ReasonCode[]): ChannelGate {
  const first = reasons[0]!;
  return { category: first === 'NOT_CONFIGURED' ? 'configuration' : 'eligibility', reason: `${REASON_LABELS[first]}.` };
}

async function channelOption(
  ctx: AppCtx,
  input: { leadId: string; channel: Channel; kind: 'WA_TEMPLATE' | 'WA_FREEFORM' | 'EMAIL'; contact: string | null; templateId: string | null; quoteTemplates: boolean },
  deps: QueueDeps,
): Promise<ChannelOption> {
  const templates = input.quoteTemplates
    ? (await ctx.db.whatsAppTemplate.findMany({ orderBy: [{ name: 'asc' }, { language: 'asc' }], select: { id: true, name: true, language: true, category: true, status: true } }))
        .filter((t) => t.status.trim().toUpperCase() === 'APPROVED')
        .map(({ id, name, language, category }) => ({ id, name, language, category }))
    : [];
  if (input.contact === null) {
    return { channel: input.channel, gate: { category: 'eligibility', reason: input.channel === 'WHATSAPP' ? 'This lead has no valid WhatsApp number.' : 'This lead has no valid email address.' }, eligibility: null, templates };
  }
  if (input.quoteTemplates && templates.length === 0) {
    return {
      channel: input.channel,
      gate: { category: 'configuration', reason: 'No approved WhatsApp template is synced for this workspace. Templates come from WhatsApp Manager once WhatsApp is connected.' },
      eligibility: null,
      templates,
    };
  }
  const templateId = input.quoteTemplates ? templates[0]!.id : input.templateId;
  const result = await checkDispatchEligibility(ctx.db, ctx, { leadId: input.leadId, channel: input.channel, kind: input.kind, sendIntent: 'MANUAL_SINGLE', templateId }, deps);
  return {
    channel: input.channel,
    gate: result.eligible || result.deferrable ? null : gateFor(result.reasons),
    eligibility: { eligible: result.eligible, deferrable: result.deferrable, reasons: result.reasons, labels: result.reasons.map((r) => REASON_LABELS[r]) },
    templates,
  };
}

async function loadApproval(ctx: AppCtx, approvalId: string): Promise<ApprovalRow> {
  const approval = await ctx.db.approval.findFirst({ where: { id: approvalId } });
  if (!approval || !QUEUE_KINDS.includes(approval.kind)) throw new NotFoundError();
  return approval;
}

export async function getApprovalItem(ctx: AppCtx, approvalId: string, deps: QueueDeps): Promise<ApprovalItemDetail> {
  requireCapability(ctx, 'leads.read');
  const workspaceId = requireWorkspace(ctx);
  const approval = await loadApproval(ctx, approvalId);
  const [item] = await buildItems(ctx, [approval]);
  if (!item) throw new NotFoundError();
  const workspace = await ctx.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { slug: true, name: true, timezone: true } });
  const lead = await ctx.db.lead.findFirstOrThrow({ where: { id: item.lead.id }, select: { id: true, phoneE164: true, emailNormalized: true } });
  const now = ctx.clock.now();

  let version: VersionView | null = null;
  let diff: VersionDiff | null = null;
  let channels: ChannelOption[] = [];
  let message: ApprovalItemDetail['message'] = null;
  let attempts: AttemptView[] = [];
  let validityPassed = false;
  let currentApprovalId: string | null = null;
  let quoteRef: ApprovalItemDetail['quoteRef'] = null;

  if (approval.kind === 'QUOTE_VERSION' && approval.quoteVersionId && approval.quoteId) {
    const row = await ctx.db.quoteVersion.findFirstOrThrow({ where: { id: approval.quoteVersionId }, include: { items: true } });
    version = versionView(row);
    validityPassed = now.getTime() >= row.validUntil.getTime();
    const pricingVersionNo = (row.snapshot as { pricingVersion?: unknown } | null)?.pricingVersion;
    quoteRef = { quoteId: approval.quoteId, pricingVersionNo: typeof pricingVersionNo === 'number' ? pricingVersionNo : null };
    if (item.quote && !item.quote.isCurrent) {
      const quote = await ctx.db.quote.findFirst({ where: { id: approval.quoteId }, select: { currentVersionId: true } });
      const current = quote?.currentVersionId
        ? await ctx.db.approval.findFirst({ where: { kind: 'QUOTE_VERSION', quoteVersionId: quote.currentVersionId }, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], select: { id: true } })
        : null;
      currentApprovalId = current?.id ?? null;
    }
    if (row.versionNo > 1) {
      const prev = await ctx.db.quoteVersion.findFirst({ where: { quoteId: approval.quoteId, versionNo: row.versionNo - 1 }, include: { items: true } });
      if (prev) {
        const prevApproval = await ctx.db.approval.findFirst({ where: { kind: 'QUOTE_VERSION', quoteVersionId: prev.id }, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], select: { status: true } });
        diff = diffVersions(versionView(prev), version, prevApproval?.status ?? null);
      }
    }
    channels = [
      await channelOption(ctx, { leadId: lead.id, channel: 'EMAIL', kind: 'EMAIL', contact: lead.emailNormalized, templateId: null, quoteTemplates: false }, deps),
      await channelOption(ctx, { leadId: lead.id, channel: 'WHATSAPP', kind: 'WA_TEMPLATE', contact: lead.phoneE164, templateId: null, quoteTemplates: true }, deps),
    ];
    const rows = await ctx.db.dispatchAttempt.findMany({ where: { quoteVersionId: approval.quoteVersionId }, orderBy: [{ createdAt: 'asc' }, { attemptNo: 'asc' }] });
    attempts = rows.map((a) => ({ id: a.id, attemptNo: a.attemptNo, channel: a.channel, state: a.state, reasonCode: a.reasonCode, reasonLabel: dispatchReasonLabel(a.reasonCode), createdAt: a.createdAt, updatedAt: a.updatedAt }));
  } else if (approval.messageId) {
    const m = await ctx.db.message.findFirstOrThrow({ where: { id: approval.messageId }, include: { template: { select: { name: true } } } });
    const variables: Record<string, string> = {};
    if (m.variables && typeof m.variables === 'object' && !Array.isArray(m.variables)) {
      for (const [k, v] of Object.entries(m.variables as Record<string, unknown>)) if (typeof v === 'string') variables[k] = v;
    }
    message = { body: m.body, subject: m.subject, templateName: m.template?.name ?? null, variables };
    const kind = dispatchKindOf(m);
    channels = [
      await channelOption(ctx, { leadId: lead.id, channel: m.channel, kind, contact: m.channel === 'WHATSAPP' ? lead.phoneE164 : lead.emailNormalized, templateId: m.templateId, quoteTemplates: false }, deps),
    ];
    const rows = await ctx.db.dispatchAttempt.findMany({ where: { messageId: m.id }, orderBy: [{ createdAt: 'asc' }, { attemptNo: 'asc' }] });
    attempts = rows.map((a) => ({ id: a.id, attemptNo: a.attemptNo, channel: a.channel, state: a.state, reasonCode: a.reasonCode, reasonLabel: dispatchReasonLabel(a.reasonCode), createdAt: a.createdAt, updatedAt: a.updatedAt }));
  }

  return { item, workspace, version, diff, message, channels, attempts, validityPassed, currentApprovalId, quoteRef, permissions: permissionsOf(ctx) };
}

// ---- Decisions -----------------------------------------------------------------------------------

/** The approval must still be open and, for a quote, describe the quote's current version. */
async function assertQuoteItemCurrent(ctx: AppCtx, approval: ApprovalRow, allowed: readonly ApprovalStatus[]): Promise<{ quoteId: string }> {
  if (!allowed.includes(approval.status)) throw approvalChanged({ status: approval.status });
  if (!approval.quoteId || !approval.quoteVersionId) throw new NotFoundError();
  const quote = await ctx.db.quote.findFirst({ where: { id: approval.quoteId }, select: { id: true, currentVersionId: true } });
  if (!quote) throw new NotFoundError();
  if (quote.currentVersionId !== approval.quoteVersionId) throw approvalChanged({ reason: 'NOT_CURRENT_VERSION' });
  return { quoteId: quote.id };
}

async function staleOnConflict<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof QuoteVersionConflictError) throw approvalChanged({ reason: 'VERSION_CONFLICT' });
    throw error;
  }
}

/** Approve the quote version on screen (QUOTE_VERSION items only; messages are approved and sent in one step). */
export async function approveFromQueue(ctx: AppCtx, approvalId: string, input: { expectedVersion: number }): Promise<{ approvalId: string; quoteId: string; status: 'APPROVED' }> {
  requireCapability(ctx, 'approvals.decide');
  const approval = await loadApproval(ctx, approvalId);
  if (approval.kind !== 'QUOTE_VERSION') {
    throw new DomainRuleError({ code: 'SEND_TO_APPROVE', userMessage: 'A message is approved and sent in one step. Use "Approve and send".' });
  }
  const { quoteId } = await assertQuoteItemCurrent(ctx, approval, ['PENDING']);
  const result = await staleOnConflict(() => approveQuote(ctx, quoteId, { expectedVersion: input.expectedVersion }));
  return { approvalId: result.approvalId, quoteId, status: 'APPROVED' };
}

export type SendFromQueueInput = { expectedVersion?: number; channel?: Channel; templateId?: string };

/** Approve and send (T19 transaction). Idempotent: a repeat with the same version and channel returns the same ids. */
export async function sendFromQueue(ctx: AppCtx, approvalId: string, input: SendFromQueueInput, deps: { contactKeyPepper: string }): Promise<ApproveAndSendResult> {
  requireCapability(ctx, 'approvals.decide');
  requireCapability(ctx, 'dispatch.send');
  const approval = await loadApproval(ctx, approvalId);
  if (approval.kind === 'QUOTE_VERSION') {
    const { quoteId } = await assertQuoteItemCurrent(ctx, approval, ['PENDING', 'APPROVED']);
    if (input.expectedVersion === undefined || input.channel === undefined) {
      throw new ValidationError({ code: 'SEND_INPUT_REQUIRED', message: 'expectedVersion and channel are required', userMessage: 'Choose a channel for this quotation.' });
    }
    const expectedVersion = input.expectedVersion;
    const channel = input.channel;
    return staleOnConflict(() => approveAndSendQuote(ctx, { quoteId, expectedVersion, channel, templateId: input.templateId ?? null }, deps));
  }
  if (!approval.messageId) throw new NotFoundError();
  if (approval.status !== 'PENDING' && approval.status !== 'APPROVED') throw approvalChanged({ status: approval.status });
  const messageId = approval.messageId;
  return approveAndSendMessage(ctx, { messageId }, deps);
}

export async function rejectApproval(ctx: AppCtx, input: { approvalId: string; reason: string }): Promise<{ approvalId: string; status: 'REJECTED' }> {
  requireCapability(ctx, 'approvals.decide');
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new ValidationError({ code: 'REASON_INVALID', message: 'reason must be 3 to 500 characters', userMessage: 'Give a reason of 3 to 500 characters.' });
  }
  return withTx(ctx.db, async (tx) => {
    const approval = await tx.approval.findFirst({ where: { id: input.approvalId } });
    if (!approval || !QUEUE_KINDS.includes(approval.kind)) throw new NotFoundError();
    if (approval.status !== 'PENDING') throw approvalChanged({ status: approval.status });
    const now = ctx.clock.now();
    const cas = await tx.approval.updateMany({ where: { id: approval.id, status: 'PENDING' }, data: { status: 'REJECTED', decidedBy: ctx.actor?.userId ?? `system:${ctx.kind}`, decidedAt: now } });
    if (cas.count !== 1) throw approvalChanged();
    if (approval.messageId) await tx.message.updateMany({ where: { id: approval.messageId, status: 'DRAFT' }, data: { status: 'NOT_SENT' } });
    await recordAudit(tx, ctx, {
      action: 'approval.reject',
      targetType: 'Approval',
      targetId: approval.id,
      reason,
      summary: { kind: approval.kind, quoteId: approval.quoteId, quoteVersionId: approval.quoteVersionId, messageId: approval.messageId },
    });
    return { approvalId: approval.id, status: 'REJECTED' as const };
  });
}

export type ReviseFromQueueInput = {
  expectedVersion: number;
  repriceToActive?: boolean;
  items: Array<{ serviceId: string; qty: number }>;
  discount: { kind: 'NONE' | 'PERCENT_BPS' | 'FLAT_PAISE'; value: string };
  scopeText: string;
  timelineText: string;
  validityDays?: number;
};

/** Edit the quote behind an item: a new version priced by the server, within the editor's own discount cap. */
export async function reviseFromQueue(ctx: AppCtx, approvalId: string, input: ReviseFromQueueInput): Promise<QuoteWriteResult> {
  requireCapability(ctx, 'quotes.edit');
  const approval = await loadApproval(ctx, approvalId);
  if (approval.kind !== 'QUOTE_VERSION' || !approval.quoteId) {
    throw new DomainRuleError({ code: 'NOT_A_QUOTE', userMessage: 'Only a quotation can be edited here.' });
  }
  const { quoteId } = await assertQuoteItemCurrent(ctx, approval, ['PENDING', 'APPROVED']);
  const { discount, ...rest } = input;
  return staleOnConflict(() => reviseQuote(ctx, quoteId, { ...rest, discount: { kind: discount.kind, value: parsePaise(discount.value) } }));
}

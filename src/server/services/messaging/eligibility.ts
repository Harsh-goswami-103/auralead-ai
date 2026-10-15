/**
 * Dispatch eligibility (plan §7, A10): one function behind the bulk pre-flight counts, the approval
 * queue badge, the composer eligibility line and the dispatch preflight (which re-runs it inside
 * the preflight transaction with the attempt's persisted `sendIntent`, E4). UI code never computes
 * eligibility.
 *
 * `evaluateDispatchEligibility` is pure. It reports every failing check, in this order:
 *   1 GLOBAL_PAUSED (deferrable)          2 WORKSPACE_PAUSED (automated, deferrable)
 *   2a AUTO_SEND_DISABLED (automated)     3 SUPPRESSED
 *   4 consent: NO_WHATSAPP_OPT_IN | EMAIL_INVALID | NO_EMAIL_BASIS | ATTESTED_MANUAL_ONLY
 *   5 HUMAN_TAKEOVER, MODE_CHANGED (automated)
 *   6 QUALITY_PAUSED (automated WhatsApp)  7 TEMPLATE_NOT_APPROVED | WINDOW_CLOSED
 *   8 NOT_CONFIGURED                       9 CAP_REACHED (deferrable, an internal cap)
 * "Automated" is `sendIntent = AUTOMATED`, or a CUSTOMER_REQUESTED_REPLY sent without a human
 * approval. The result is deferrable only when every failing check is deferrable, so a suppressed
 * contact is skipped even while outbound is paused. Sales stage is never an input (R4).
 *
 * Email (M2, ADR-14, user decision D4): a valid address and a basis. Email OPT_IN allows every
 * intent. B2B_ATTESTED counts only while the workspace enables attestation, and then only for
 * MANUAL_SINGLE (`ATTESTED_MANUAL_ONLY` otherwise: never bulk, automated or a fallback target).
 * WhatsApp consent never counts for email.
 *
 * `loadEligibilityInput` reads the inputs for one lead and channel through the tenant-scoped
 * client (inside the caller's transaction when there is one).
 */
import type { Channel, ConsentBasis, ConsentPurpose, PipelineApprovalMode, SendIntent } from '@/lib/domain/enums';
import type { Clock } from '@/lib/clock';
import { NotFoundError, ValidationError } from '@/lib/errors';
import type { ScopedDb, ScopedTx } from '@/server/db/scoped';
import { contactKey, normalizeContact } from '@/server/security/contact-key';
import { isWindowOpen, windowEndsAt } from './window';

export type DispatchKind = 'WA_TEMPLATE' | 'WA_FREEFORM' | 'EMAIL';

export const REASON_ORDER = [
  'GLOBAL_PAUSED',
  'WORKSPACE_PAUSED',
  'AUTO_SEND_DISABLED',
  'SUPPRESSED',
  'NO_WHATSAPP_OPT_IN',
  'EMAIL_INVALID',
  'NO_EMAIL_BASIS',
  'ATTESTED_MANUAL_ONLY',
  'HUMAN_TAKEOVER',
  'MODE_CHANGED',
  'QUALITY_PAUSED',
  'TEMPLATE_NOT_APPROVED',
  'WINDOW_CLOSED',
  'NOT_CONFIGURED',
  'CAP_REACHED',
] as const;
export type ReasonCode = (typeof REASON_ORDER)[number];

export const DEFERRABLE_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>(['GLOBAL_PAUSED', 'WORKSPACE_PAUSED', 'CAP_REACHED']);

/** User-facing labels; the cap is explicitly not a provider limit (plan §7 check 9). */
export const REASON_LABELS: Readonly<Record<ReasonCode, string>> = {
  GLOBAL_PAUSED: 'Outbound is paused for the whole system',
  WORKSPACE_PAUSED: 'Automation is paused for this workspace',
  AUTO_SEND_DISABLED: 'Auto-send is off',
  SUPPRESSED: 'The contact opted out on this channel',
  NO_WHATSAPP_OPT_IN: 'No WhatsApp opt-in on record',
  EMAIL_INVALID: 'No valid email address',
  NO_EMAIL_BASIS: 'No email opt-in or enabled B2B attestation',
  ATTESTED_MANUAL_ONLY: 'Attested B2B email allows manual single sends only',
  HUMAN_TAKEOVER: 'A person has taken over this conversation',
  MODE_CHANGED: 'The conversation mode changed after this was queued',
  QUALITY_PAUSED: 'Automation paused by WhatsApp quality rating',
  TEMPLATE_NOT_APPROVED: 'The template is not approved',
  WINDOW_CLOSED: 'The 24-hour reply window is closed',
  NOT_CONFIGURED: 'The channel integration is not connected',
  CAP_REACHED: 'Internal cap, not a provider limit',
};

export type EligibilityConsent = {
  channel: Channel;
  purpose: ConsentPurpose;
  basis: ConsentBasis;
  collectedAt: Date;
  withdrawnAt: Date | null;
};

export type EligibilityInput = {
  kind: DispatchKind;
  /** Persisted on Message/DispatchAttempt at creation (E4); never inferred. */
  sendIntent: SendIntent;
  globalPaused: boolean;
  workspaceAutomationPaused: boolean;
  qualityPaused: boolean;
  /** Of the lead's pinned PipelineConfigVersion. */
  pipelineApprovalMode: PipelineApprovalMode;
  /** The ACTIVE suppression row for this contact and channel (clearedAt IS NULL), E3. */
  suppression: { channel: Channel; createdAt: Date } | null;
  consents: EligibilityConsent[];
  conversation: { humanTakeover: boolean; modeVersion: number; lastInboundProviderAt: Date | null } | null;
  /** Automated replies pin the conversation's mode version at creation. */
  expectedModeVersion?: number;
  template?: { statusRaw: string; approved: boolean; category: string } | null;
  emailAddressValid: boolean;
  integrationReady: boolean;
  workspace: { emailB2bAttestationEnabled: boolean; autoSendEnabled: boolean };
  internalCapRemaining: number | null;
  /** The attempt was created by a POLICY_AUTO approval node (E4, ADR-45 check 2a). */
  policyAutoOrigin?: boolean;
  /** The attempt carries an approval a person decided (makes CUSTOMER_REQUESTED_REPLY manual). */
  humanApproved?: boolean;
};

export type EligibilityResult = {
  eligible: boolean;
  deferrable: boolean;
  mode: 'template' | 'freeform' | 'email' | 'none';
  reasons: ReasonCode[];
  /** End of the WhatsApp window when it is open now (composer line), else null. */
  windowEndsAt: Date | null;
};

export function isAutomatedIntent(sendIntent: SendIntent, humanApproved: boolean): boolean {
  if (sendIntent === 'AUTOMATED') return true;
  return sendIntent === 'CUSTOMER_REQUESTED_REPLY' && !humanApproved;
}

function channelOf(kind: DispatchKind): Channel {
  return kind === 'EMAIL' ? 'EMAIL' : 'WHATSAPP';
}

function modeOf(kind: DispatchKind): 'template' | 'freeform' | 'email' {
  return kind === 'WA_TEMPLATE' ? 'template' : kind === 'WA_FREEFORM' ? 'freeform' : 'email';
}

function liveConsent(c: EligibilityConsent, now: Date): boolean {
  if (c.collectedAt.getTime() > now.getTime()) return false;
  return c.withdrawnAt === null || c.withdrawnAt.getTime() > now.getTime();
}

export function evaluateDispatchEligibility(input: EligibilityInput, clock: Clock): EligibilityResult {
  const now = clock.now();
  const channel = channelOf(input.kind);
  const automated = isAutomatedIntent(input.sendIntent, input.humanApproved ?? false);
  const consents = input.consents.filter((c) => c.channel === channel && liveConsent(c, now));
  const lastInbound = input.conversation?.lastInboundProviderAt ?? null;
  const windowOpen = isWindowOpen(lastInbound, now);
  const failed = new Set<ReasonCode>();

  // 1-2a: pauses and auto-send.
  if (input.globalPaused) failed.add('GLOBAL_PAUSED');
  if (automated && input.workspaceAutomationPaused) failed.add('WORKSPACE_PAUSED');
  if (automated && (!input.workspace.autoSendEnabled || (input.policyAutoOrigin === true && input.pipelineApprovalMode !== 'POLICY_AUTO'))) {
    failed.add('AUTO_SEND_DISABLED');
  }
  // 3: suppression on this channel.
  if (input.suppression !== null && input.suppression.channel === channel) failed.add('SUPPRESSED');
  // 4: consent.
  if (input.kind === 'WA_TEMPLATE') {
    if (!consents.some((c) => c.basis === 'OPT_IN' && c.purpose === 'MARKETING')) failed.add('NO_WHATSAPP_OPT_IN');
  } else if (input.kind === 'WA_FREEFORM') {
    if (consents.length === 0) failed.add('NO_WHATSAPP_OPT_IN');
  } else {
    if (!input.emailAddressValid) failed.add('EMAIL_INVALID');
    const optIn = consents.some((c) => c.basis === 'OPT_IN');
    const attested = input.workspace.emailB2bAttestationEnabled && consents.some((c) => c.basis === 'B2B_ATTESTED');
    if (!optIn && !attested) failed.add('NO_EMAIL_BASIS');
    else if (!optIn && input.sendIntent !== 'MANUAL_SINGLE') failed.add('ATTESTED_MANUAL_ONLY');
  }
  // 5-6: conversation mode and quality (automated only).
  if (automated && input.conversation?.humanTakeover === true) failed.add('HUMAN_TAKEOVER');
  if (automated && input.expectedModeVersion !== undefined && input.conversation !== null && input.conversation.modeVersion !== input.expectedModeVersion) {
    failed.add('MODE_CHANGED');
  }
  if (automated && channel === 'WHATSAPP' && input.qualityPaused) failed.add('QUALITY_PAUSED');
  // 7: template or window.
  if (input.kind === 'WA_TEMPLATE' && !(input.template?.approved === true)) failed.add('TEMPLATE_NOT_APPROVED');
  if (input.kind === 'WA_FREEFORM' && !windowOpen) failed.add('WINDOW_CLOSED');
  // 8-9: integration and internal cap.
  if (!input.integrationReady) failed.add('NOT_CONFIGURED');
  if (input.internalCapRemaining !== null && input.internalCapRemaining <= 0) failed.add('CAP_REACHED');

  const reasons = REASON_ORDER.filter((r) => failed.has(r));
  const eligible = reasons.length === 0;
  const deferrable = !eligible && reasons.every((r) => DEFERRABLE_REASONS.has(r));
  return {
    eligible,
    deferrable,
    mode: eligible || deferrable ? modeOf(input.kind) : 'none',
    reasons,
    windowEndsAt: channel === 'WHATSAPP' && windowOpen ? windowEndsAt(lastInbound) : null,
  };
}

// ---- Loading ------------------------------------------------------------------------------------

/** `initiatedBy` of attempts created by the pipeline's DELIVERY stage after a POLICY_AUTO approval node. */
export const POLICY_AUTO_INITIATOR = 'system:pipeline.advance';

export function isPolicyAutoOrigin(initiatedBy: string | null | undefined): boolean {
  return initiatedBy === POLICY_AUTO_INITIATOR;
}

export type LoadEligibilityArgs = {
  leadId: string;
  channel: Channel;
  kind: DispatchKind;
  conversationId?: string | null;
  sendIntent: SendIntent;
  /** Of the attempt being checked (dispatch preflight); decides `policyAutoOrigin`. */
  initiatedBy?: string | null;
  /** Of the attempt being checked; an APPROVED approval with a decider makes it human-approved. */
  approvalId?: string | null;
  templateId?: string | null;
  expectedModeVersion?: number;
};

export type EligibilityDeps = {
  /** SUPPRESSION_PEPPER: consent and suppression rows are keyed by the contact HMAC (C17). */
  contactKeyPepper: string;
  /** `outbound.lock` or OUTBOUND_PAUSED=1, computed by the caller (dispatch preflight, T19). */
  externalOutboundPause?: boolean;
};

type ReadDb = ScopedDb | ScopedTx;
type LoadCtx = { workspaceId: string | null; mode: 'demo' | 'live'; clock: Clock };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The contact HMAC for a lead's channel contact, or null when it has none (or it is unusable). */
export function leadContactKey(pepper: string, channel: Channel, lead: { phoneE164: string | null; emailNormalized: string | null }): string | null {
  const value = channel === 'WHATSAPP' ? lead.phoneE164 : lead.emailNormalized;
  if (value === null) return null;
  try {
    return contactKey(pepper, channel === 'WHATSAPP' ? 'phone' : 'email', value);
  } catch {
    return null;
  }
}

function emailValid(email: string | null): boolean {
  if (email === null) return false;
  try {
    return EMAIL_SHAPE.test(normalizeContact('email', email));
  } catch {
    return false;
  }
}

/** Midnight of `now`'s calendar day in `timeZone`, as a UTC instant. */
export function startOfLocalDay(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const wholeSecond = Math.floor(now.getTime() / 1000) * 1000;
  const offset = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - wholeSecond;
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')) - offset);
}

export async function loadEligibilityInput(db: ReadDb, ctx: LoadCtx, args: LoadEligibilityArgs, deps: EligibilityDeps): Promise<EligibilityInput> {
  const workspaceId = ctx.workspaceId;
  if (workspaceId === null) throw new NotFoundError();
  if (channelOf(args.kind) !== args.channel) throw new ValidationError({ code: 'CHANNEL_KIND_MISMATCH', message: `${args.kind} is not a ${args.channel} dispatch` });
  const now = ctx.clock.now();

  const lead = await db.lead.findFirst({
    where: { id: args.leadId },
    select: { id: true, phoneE164: true, emailNormalized: true, pipelineConfigVersionId: true },
  });
  if (!lead) throw new NotFoundError();
  const workspace = await db.workspace.findUnique({ where: { id: workspaceId }, select: { automationPaused: true, timezone: true } });
  if (!workspace) throw new NotFoundError();
  const settings = await db.workspaceSettings.findFirst({
    select: { autoSendEnabled: true, emailB2bAttestationEnabled: true, internalWaDailyCap: true, internalEmailDailyCap: true },
  });
  const system = await db.systemSetting.findUnique({ where: { id: 1 }, select: { outboundPaused: true } });
  const pipeline =
    lead.pipelineConfigVersionId === null
      ? null
      : await db.pipelineConfigVersion.findFirst({ where: { id: lead.pipelineConfigVersionId }, select: { approvalMode: true } });

  const key = leadContactKey(deps.contactKeyPepper, args.channel, lead);
  const suppression =
    key === null
      ? null
      : await db.suppression.findFirst({ where: { channel: args.channel, contactKey: key, clearedAt: null }, select: { channel: true, createdAt: true } });
  const consents =
    key === null
      ? []
      : await db.consentRecord.findMany({
          where: { channel: args.channel, contactKey: key },
          select: { channel: true, purpose: true, basis: true, collectedAt: true, withdrawnAt: true },
          orderBy: { collectedAt: 'asc' },
        });

  const conversation =
    args.conversationId !== undefined && args.conversationId !== null
      ? await db.conversation.findFirst({ where: { id: args.conversationId, leadId: lead.id, channel: args.channel } })
      : await db.conversation.findFirst({ where: { leadId: lead.id, channel: args.channel, closedAt: null } });
  if (args.conversationId && !conversation) throw new NotFoundError();

  let template: EligibilityInput['template'] = null;
  if (args.templateId) {
    const row = await db.whatsAppTemplate.findFirst({ where: { id: args.templateId }, select: { status: true, category: true } });
    if (!row) throw new NotFoundError();
    template = { statusRaw: row.status, approved: row.status.trim().toUpperCase() === 'APPROVED', category: row.category };
  }

  const integrationKinds = args.channel === 'WHATSAPP' ? (['WHATSAPP_CLOUD'] as const) : (['EMAIL_RESEND', 'EMAIL_SMTP'] as const);
  const integrations = await db.integration.findMany({ where: { kind: { in: [...integrationKinds] } }, select: { status: true, qualityRaw: true } });
  // DEMO sends go to the demo transports (zero outbound); LIVE needs a CONNECTED integration.
  const integrationReady = ctx.mode === 'demo' ? true : integrations.some((i) => i.status === 'CONNECTED');
  const qualityPaused = args.channel === 'WHATSAPP' && integrations.some((i) => (i.qualityRaw ?? '').trim().toUpperCase() === 'RED');

  const cap = args.channel === 'WHATSAPP' ? (settings?.internalWaDailyCap ?? null) : (settings?.internalEmailDailyCap ?? null);
  let internalCapRemaining: number | null = null;
  if (cap !== null) {
    const used = await db.dispatchAttempt.count({
      where: { channel: args.channel, state: { in: ['SENDING', 'SENT', 'AMBIGUOUS'] }, createdAt: { gte: startOfLocalDay(now, workspace.timezone) } },
    });
    internalCapRemaining = cap - used;
  }

  let humanApproved = false;
  if (args.approvalId) {
    const approval = await db.approval.findFirst({ where: { id: args.approvalId }, select: { status: true, decidedBy: true } });
    humanApproved = approval?.status === 'APPROVED' && approval.decidedBy !== null;
  }

  return {
    kind: args.kind,
    sendIntent: args.sendIntent,
    globalPaused: (system?.outboundPaused ?? false) || deps.externalOutboundPause === true,
    workspaceAutomationPaused: workspace.automationPaused,
    qualityPaused,
    pipelineApprovalMode: pipeline?.approvalMode ?? 'HUMAN',
    suppression,
    consents,
    conversation: conversation
      ? { humanTakeover: conversation.humanTakeover, modeVersion: conversation.modeVersion, lastInboundProviderAt: conversation.lastInboundProviderAt }
      : null,
    ...(args.expectedModeVersion !== undefined ? { expectedModeVersion: args.expectedModeVersion } : {}),
    template,
    emailAddressValid: args.channel === 'EMAIL' && emailValid(lead.emailNormalized),
    integrationReady,
    workspace: { emailB2bAttestationEnabled: settings?.emailB2bAttestationEnabled ?? false, autoSendEnabled: settings?.autoSendEnabled ?? false },
    internalCapRemaining,
    policyAutoOrigin: isPolicyAutoOrigin(args.initiatedBy),
    humanApproved,
  };
}

/** Loads and evaluates in one call (bulk pre-flight counts, approval badges, the composer line). */
export async function checkDispatchEligibility(db: ReadDb, ctx: LoadCtx, args: LoadEligibilityArgs, deps: EligibilityDeps): Promise<EligibilityResult> {
  return evaluateDispatchEligibility(await loadEligibilityInput(db, ctx, args, deps), ctx.clock);
}

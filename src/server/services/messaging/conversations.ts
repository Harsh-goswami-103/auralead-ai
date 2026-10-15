/**
 * Conversations: AI mode, human takeover and automated replies (T21; PRD "respect human takeover
 * at dispatch; escalate uncertainty/complaints/human requests"; R21, R29, AT10; 01-arch race b,
 * 06-design F7).
 *
 * Mode (per thread):
 *  - `aiMode` is OFF, DRAFT (the default: replies wait for a person) or AUTO (selectable only while
 *    workspace auto-send is on, and only by someone with `automation.manage`).
 *  - `humanTakeover` overrides all three until "Resume AI".
 *  - Every change (mode, takeover, resume, escalation) bumps `modeVersion` with a compare-and-set,
 *    and is audited. An automated reply pins the version it was created under
 *    (`Message.modeVersionAtCreate`), so the dispatch preflight skips it (HUMAN_TAKEOVER or
 *    MODE_CHANGED, plan §7 check 5) if anything changed meanwhile, however briefly: takeover is
 *    respected at dispatch, not only when the reply is generated.
 *
 * Workspace auto-send (`WorkspaceSettings.autoSendEnabled`, default off) is an audited opt-in.
 * Turning it off stops queued automated work at dispatch (AUTO_SEND_DISABLED, check 2a) and turns
 * an AUTO thread's next reply into a draft for approval.
 *
 * Automated replies (`reply.auto`, one per inbound text message, serialKey = conversationId):
 *  - `webhook.process` calls `afterInboundMessage` for every inbound message in its transaction.
 *    For the newest inbound of a thread it cancels the thread's still-QUEUED automated replies to
 *    older messages (NEWER_INBOUND: a stale answer is never sent) and, for a text message in a
 *    DRAFT or AUTO thread without takeover, enqueues the reply job for this message.
 *  - `generateAutoReply` (the job body, in the job's fenced transaction) re-checks that the message
 *    is still the newest inbound and that the thread is not OFF or taken over, then runs the reply
 *    guard (`services/ai/reply-guard.ts`): fixed deflections for complaint, human request and out
 *    of scope, fixed acknowledgements for quote and call requests, catalog-only FAQ answers.
 *    Escalations move an AUTO thread to DRAFT (new mode version, audited), so a person handles
 *    what follows.
 *  - AUTO: the reply is queued through the dispatch outbox with `sendIntent = AUTOMATED`,
 *    `initiatedBy = system:reply.auto` and the pinned mode version, so the shared preflight
 *    decides at dispatch (suppression, consent, window, pauses, quality, takeover). When the
 *    automated check already fails only for automation reasons (auto-send off, quality RED), the
 *    reply becomes a draft for approval instead (flag `auto_blocked:<reason>`).
 *  - DRAFT: a DRAFT Message with a PENDING OUTBOUND_MESSAGE approval flagged `ai_reply`; a person
 *    approves and sends it (`approveAndSendMessage`, MANUAL_SINGLE).
 *
 * `unansweredOutboundCount` (12.3, critic §6 #23): business messages sent since the customer's
 * last inbound. It grows by one for each outbound message the dispatch settle (or a status echo
 * resolving an AMBIGUOUS attempt) moves to SENT, and is reset to 0 by every inbound message (T20).
 * No cap is enforced on it; it is shown, not hardcoded.
 */
import type { ConversationAiMode, Prisma } from '@/generated/prisma/client';
import { ConflictError, DomainRuleError, NotFoundError } from '@/lib/errors';
import { idempotencyKey } from '@/lib/ids';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability, requireWorkspace } from '@/server/auth/guards';
import type { ScopedTx } from '@/server/db/scoped';
import { withTx } from '@/server/db/tx';
import { enqueueJob, type JobStore } from '@/server/jobs/queue';
import { recordAudit } from '@/server/services/audit/record';
import { decideAutoReply, loadReplyFacts, type ReplyDecision } from '@/server/services/ai/reply-guard';
import { queueOutboundMessage } from './dispatch';
import { checkDispatchEligibility, DEFERRABLE_REASONS, type ReasonCode } from './eligibility';

type Tx = Prisma.TransactionClient;

export const REPLY_AUTO_JOB = 'reply.auto';
export const REPLY_PAYLOAD_VERSION = 1;
/** `initiatedBy` of every automated reply (E4: persisted on the Message and its attempts). */
export const REPLY_INITIATOR = 'system:reply.auto';
/** `Message.generatorLabel` of guard-written replies: fixed texts and catalog facts, never a model. */
export const REPLY_GENERATOR_LABEL = 'reply-guard';

/** Eligibility reasons that stop automated sends but not a person's approved send (plan §7 checks 2-6). */
const AUTOMATION_ONLY_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>(['WORKSPACE_PAUSED', 'AUTO_SEND_DISABLED', 'HUMAN_TAKEOVER', 'MODE_CHANGED', 'QUALITY_PAUSED']);

export type ConversationModeView = {
  conversationId: string;
  aiMode: ConversationAiMode;
  humanTakeover: boolean;
  modeVersion: number;
};
export type ModeChangeResult = ConversationModeView & { changed: boolean };

function view(c: { id: string; aiMode: ConversationAiMode; humanTakeover: boolean; modeVersion: number }): ConversationModeView {
  return { conversationId: c.id, aiMode: c.aiMode, humanTakeover: c.humanTakeover, modeVersion: c.modeVersion };
}

function modeConflict(current: number, expected: number | null): ConflictError {
  return new ConflictError({
    code: 'MODE_VERSION_CONFLICT',
    message: `conversation modeVersion is ${current}, expected ${expected ?? 'unchanged'}`,
    userMessage: 'This conversation changed while you were working. Reload it and try again.',
    safeDetails: { currentModeVersion: current },
  });
}

// ---- Reading -----------------------------------------------------------------------------------------

export type ConversationModeState = ConversationModeView & {
  autoSendEnabled: boolean;
  /** AUTO can be chosen now: workspace auto-send is on and the actor holds `automation.manage`. */
  autoAvailable: boolean;
  unansweredOutboundCount: number;
  lastInboundProviderAt: Date | null;
};

export async function getConversationMode(ctx: AppCtx, input: { conversationId: string }): Promise<ConversationModeState> {
  requireCapability(ctx, 'leads.read');
  const conversation = await ctx.db.conversation.findFirst({ where: { id: input.conversationId } });
  if (!conversation) throw new NotFoundError();
  const settings = await ctx.db.workspaceSettings.findFirst({ select: { autoSendEnabled: true } });
  const autoSendEnabled = settings?.autoSendEnabled ?? false;
  return {
    ...view(conversation),
    autoSendEnabled,
    autoAvailable: autoSendEnabled && hasCapability(ctx, 'automation.manage'),
    unansweredOutboundCount: conversation.unansweredOutboundCount,
    lastInboundProviderAt: conversation.lastInboundProviderAt,
  };
}

// ---- Mode changes ------------------------------------------------------------------------------------

type ModePlan = { data: { aiMode?: ConversationAiMode; humanTakeover?: boolean }; action: string; summary: (next: number) => Record<string, unknown> };

/** One audited compare-and-set on `modeVersion`; `plan` returns null when nothing would change. */
async function changeMode(
  ctx: AppCtx,
  input: { conversationId: string; expectedModeVersion?: number },
  plan: (conversation: { aiMode: ConversationAiMode; humanTakeover: boolean }, tx: ScopedTx) => Promise<ModePlan | null>,
): Promise<ModeChangeResult> {
  return withTx(ctx.db, async (tx) => {
    const conversation = await tx.conversation.findFirst({ where: { id: input.conversationId } });
    if (!conversation) throw new NotFoundError();
    if (input.expectedModeVersion !== undefined && conversation.modeVersion !== input.expectedModeVersion) {
      throw modeConflict(conversation.modeVersion, input.expectedModeVersion);
    }
    const p = await plan(conversation, tx);
    if (p === null) return { ...view(conversation), changed: false };
    const next = conversation.modeVersion + 1;
    const cas = await tx.conversation.updateMany({ where: { id: conversation.id, modeVersion: conversation.modeVersion }, data: { ...p.data, modeVersion: next } });
    if (cas.count !== 1) throw modeConflict(conversation.modeVersion, input.expectedModeVersion ?? null);
    await recordAudit(tx, ctx, { action: p.action, targetType: 'Conversation', targetId: conversation.id, summary: p.summary(next) });
    return { ...view({ ...conversation, ...p.data, modeVersion: next }), changed: true };
  });
}

/** Off, Draft (default) or Auto. Auto needs workspace auto-send on and `automation.manage`. */
export async function setConversationAiMode(ctx: AppCtx, input: { conversationId: string; aiMode: ConversationAiMode; expectedModeVersion?: number }): Promise<ModeChangeResult> {
  requireCapability(ctx, 'leads.write');
  if (input.aiMode === 'AUTO') requireCapability(ctx, 'automation.manage');
  return changeMode(ctx, input, async (conversation, tx) => {
    if (conversation.aiMode === input.aiMode) return null;
    if (input.aiMode === 'AUTO') {
      const settings = await tx.workspaceSettings.findFirst({ select: { autoSendEnabled: true } });
      if (!settings?.autoSendEnabled) {
        throw new DomainRuleError({ code: 'AUTO_SEND_OFF', userMessage: 'Turn on auto-send for this workspace before setting a conversation to Auto.' });
      }
    }
    return { data: { aiMode: input.aiMode }, action: 'conversation.ai_mode', summary: (next) => ({ from: conversation.aiMode, to: input.aiMode, modeVersion: next }) };
  });
}

/** A person takes the thread: automated replies stop at dispatch until "Resume AI". */
export async function takeOverConversation(ctx: AppCtx, input: { conversationId: string; expectedModeVersion?: number }): Promise<ModeChangeResult> {
  requireCapability(ctx, 'leads.write');
  return changeMode(ctx, input, async (conversation) =>
    conversation.humanTakeover ? null : { data: { humanTakeover: true }, action: 'conversation.takeover', summary: (next) => ({ aiMode: conversation.aiMode, modeVersion: next }) },
  );
}

/** "Resume AI": the thread's AI mode applies again; replies queued before keep their old version and stay blocked. */
export async function resumeConversationAi(ctx: AppCtx, input: { conversationId: string; expectedModeVersion?: number }): Promise<ModeChangeResult> {
  requireCapability(ctx, 'leads.write');
  return changeMode(ctx, input, async (conversation) =>
    conversation.humanTakeover ? { data: { humanTakeover: false }, action: 'conversation.resume', summary: (next) => ({ aiMode: conversation.aiMode, modeVersion: next }) } : null,
  );
}

/** Workspace auto-send, the audited opt-in (R29, 06-design F7). Off by default. */
export async function setWorkspaceAutoSend(ctx: AppCtx, input: { enabled: boolean }): Promise<{ enabled: boolean; changed: boolean }> {
  requireCapability(ctx, 'automation.manage');
  const workspaceId = requireWorkspace(ctx);
  return withTx(ctx.db, async (tx) => {
    const settings = await tx.workspaceSettings.findFirst({ select: { autoSendEnabled: true } });
    if (!settings) throw new NotFoundError();
    if (settings.autoSendEnabled === input.enabled) return { enabled: input.enabled, changed: false };
    await tx.workspaceSettings.updateMany({ where: { workspaceId }, data: { autoSendEnabled: input.enabled, updatedBy: ctx.actor?.userId ?? `system:${ctx.kind}` } });
    await recordAudit(tx, ctx, { action: 'workspace.auto_send', targetType: 'Workspace', targetId: workspaceId, summary: { enabled: input.enabled, previous: settings.autoSendEnabled } });
    return { enabled: input.enabled, changed: true };
  });
}

// ---- Inbound hook (inside the webhook.process transaction) -------------------------------------------

export type AfterInboundInput = {
  conversationId: string;
  inboundMessageId: string;
  /** This message advanced the thread's last inbound (it is the newest one). */
  latest: boolean;
  /** An ordinary text message (not a quick reply, Stop or START): the guard may answer it. */
  replyable: boolean;
};
export type AfterInboundResult = { supersededReplies: number; replyJobId: string | null };

/**
 * Called by `webhook.process` for every inbound message, in its fenced transaction: cancels the
 * thread's queued automated replies to older messages and enqueues the reply job for this one.
 */
export async function afterInboundMessage(tx: ScopedTx, ctx: AppCtx, input: AfterInboundInput): Promise<AfterInboundResult> {
  const workspaceId = requireWorkspace(ctx);
  if (!input.latest) return { supersededReplies: 0, replyJobId: null };
  const supersededReplies = await cancelStaleReplies(tx, ctx, input);

  if (!input.replyable) return { supersededReplies, replyJobId: null };
  const conversation = await tx.conversation.findFirst({ where: { id: input.conversationId }, select: { aiMode: true, humanTakeover: true } });
  if (!conversation || conversation.aiMode === 'OFF' || conversation.humanTakeover) return { supersededReplies, replyJobId: null };
  const { job } = await enqueueJob(tx as unknown as JobStore, ctx.clock, {
    type: REPLY_AUTO_JOB,
    payload: { conversationId: input.conversationId, inboundMessageId: input.inboundMessageId },
    payloadVersion: REPLY_PAYLOAD_VERSION,
    workspaceId,
    idempotencyKey: idempotencyKey(REPLY_AUTO_JOB, input.inboundMessageId),
    correlationId: ctx.correlationId,
    causationId: ctx.causationId ?? null,
    serialKey: input.conversationId,
    kind: 'default',
  });
  return { supersededReplies, replyJobId: job.id };
}

/** QUEUED automated replies to older inbound messages: CANCELLED(NEWER_INBOUND), jobs cancelled, messages NOT_SENT. */
async function cancelStaleReplies(tx: ScopedTx, ctx: AppCtx, input: AfterInboundInput): Promise<number> {
  const stale = await tx.message.findMany({
    where: { conversationId: input.conversationId, direction: 'OUT', initiatedBy: REPLY_INITIATOR, status: 'PENDING', replyToInboundId: { not: input.inboundMessageId } },
    select: { id: true },
  });
  if (stale.length === 0) return 0;
  const attempts = await tx.dispatchAttempt.findMany({ where: { messageId: { in: stale.map((m) => m.id) }, state: 'QUEUED' }, select: { id: true, jobId: true, messageId: true } });
  if (attempts.length === 0) return 0;
  const now = ctx.clock.now();
  await tx.dispatchAttempt.updateMany({ where: { id: { in: attempts.map((a) => a.id) }, state: 'QUEUED' }, data: { state: 'CANCELLED', reasonCode: 'NEWER_INBOUND', updatedAt: now } });
  const jobIds = [...new Set(attempts.map((a) => a.jobId))];
  await tx.job.updateMany({ where: { id: { in: jobIds }, status: 'QUEUED' }, data: { status: 'CANCELLED', finishedAt: now, updatedAt: now } });
  // A job already claimed (held before its preflight) finds its attempt CANCELLED and stops there.
  await tx.job.updateMany({ where: { id: { in: jobIds }, status: 'RUNNING', cancelRequestedAt: null }, data: { cancelRequestedAt: now, updatedAt: now } });
  await tx.message.updateMany({ where: { id: { in: attempts.map((a) => a.messageId) }, status: 'PENDING' }, data: { status: 'NOT_SENT' } });
  for (const attempt of attempts) {
    await recordAudit(tx, ctx, {
      action: 'reply.superseded',
      targetType: 'DispatchAttempt',
      targetId: attempt.id,
      simulated: ctx.mode === 'demo',
      summary: { reason: 'NEWER_INBOUND', newerInboundMessageId: input.inboundMessageId, messageId: attempt.messageId },
    });
  }
  return attempts.length;
}

// ---- The reply job body (inside the job's fenced, tenant-scoped transaction) -------------------------

export type ReplyDeps = { contactKeyPepper: string };
export type ReplyJobInput = { conversationId: string; inboundMessageId: string };
export type ReplyOutcome =
  | { status: 'NOT_FOUND' | 'SUPERSEDED' | 'NOT_GENERATED' | 'NO_TEXT' }
  | { status: 'ALREADY_REPLIED'; messageId: string }
  | { status: 'NO_REPLY' | 'SKIPPED'; decision: ReplyDecision; reasons?: ReasonCode[] }
  | { status: 'QUEUED' | 'DRAFTED'; decision: ReplyDecision; messageId: string };

export async function generateAutoReply(tx: ScopedTx, ctx: AppCtx, input: ReplyJobInput, deps: ReplyDeps): Promise<ReplyOutcome> {
  const workspaceId = requireWorkspace(ctx);
  const conversation = await tx.conversation.findFirst({ where: { id: input.conversationId } });
  const inbound = conversation ? await tx.message.findFirst({ where: { id: input.inboundMessageId, conversationId: conversation.id, direction: 'IN' }, select: { id: true, body: true, simulated: true } }) : null;
  if (!conversation || !inbound) return { status: 'NOT_FOUND' };
  // Inbound replies arrive on WhatsApp only (email has no inbound path: EMAIL_PROVIDER_CAPABILITIES).
  if (conversation.channel !== 'WHATSAPP') return { status: 'NOT_GENERATED' };
  const existing = await tx.message.findFirst({ where: { conversationId: conversation.id, direction: 'OUT', replyToInboundId: inbound.id, generatorLabel: REPLY_GENERATOR_LABEL }, select: { id: true } });
  if (existing) return { status: 'ALREADY_REPLIED', messageId: existing.id };

  const audit = (action: string, summary: Record<string, unknown>) => recordAudit(tx, ctx, { action, targetType: 'Message', targetId: inbound.id, simulated: inbound.simulated, summary: { conversationId: conversation.id, ...summary } });
  // A newer inbound arrived after this job was queued: its own job answers instead (never a stale reply).
  if (conversation.lastInboundMessageId !== inbound.id) {
    await audit('reply.superseded', { reason: 'NEWER_INBOUND' });
    return { status: 'SUPERSEDED' };
  }
  if (conversation.humanTakeover || conversation.aiMode === 'OFF') {
    await audit('reply.not_generated', { reason: conversation.humanTakeover ? 'HUMAN_TAKEOVER' : 'AI_OFF' });
    return { status: 'NOT_GENERATED' };
  }
  if (!inbound.body || inbound.body.trim() === '') return { status: 'NO_TEXT' };

  const decision = decideAutoReply(inbound.body, await loadReplyFacts(tx, workspaceId));
  // Intent, action and rule names only: never the customer's text or the reply text.
  await audit('reply.guard', {
    intent: decision.intent,
    action: decision.action,
    escalate: decision.escalate,
    reason: decision.escalationReason,
    matchedServices: decision.matchedServiceIds.length,
    policyRules: decision.policyRules,
  });

  let modeVersion = conversation.modeVersion;
  if (decision.escalate) modeVersion = await escalate(tx, ctx, { id: conversation.id, aiMode: conversation.aiMode, modeVersion }, decision, inbound.id);
  if (decision.action === 'NONE' || decision.text === null) return { status: 'NO_REPLY', decision };

  const flags = ['ai_reply', `intent:${decision.intent}`, ...(decision.escalate ? ['escalated'] : [])];
  const leadId = conversation.leadId;
  const eligibility = (sendIntent: 'AUTOMATED' | 'MANUAL_SINGLE') =>
    checkDispatchEligibility(
      tx,
      ctx,
      { leadId, channel: 'WHATSAPP', kind: 'WA_FREEFORM', conversationId: conversation.id, sendIntent, initiatedBy: REPLY_INITIATOR, expectedModeVersion: modeVersion },
      { contactKeyPepper: deps.contactKeyPepper },
    );

  if (conversation.aiMode === 'AUTO') {
    const automated = await eligibility('AUTOMATED');
    if (automated.eligible || automated.deferrable) {
      const queued = await queueOutboundMessage(
        tx,
        ctx,
        { kind: 'TEXT', body: decision.text, generatorLabel: REPLY_GENERATOR_LABEL, leadId, channel: 'WHATSAPP', sendIntent: 'AUTOMATED', initiatedBy: REPLY_INITIATOR, dedupeKey: `reply:${inbound.id}` },
        deps,
      );
      await tx.message.update({ where: { id: queued.messageId }, data: { replyToInboundId: inbound.id, modeVersionAtCreate: modeVersion } });
      return { status: 'QUEUED', decision, messageId: queued.messageId };
    }
    const blocking = automated.reasons.filter((r) => !DEFERRABLE_REASONS.has(r));
    if (!blocking.every((r) => AUTOMATION_ONLY_REASONS.has(r))) {
      await audit('reply.skipped', { reasons: automated.reasons, intent: decision.intent });
      return { status: 'SKIPPED', decision, reasons: automated.reasons };
    }
    // Automation is blocked (auto-send off, quality RED, ...): a person can still approve the reply.
    const messageId = await draftForApproval(tx, ctx, { conversationId: conversation.id, inboundMessageId: inbound.id, text: decision.text }, [...flags, `auto_blocked:${blocking[0]!}`]);
    return { status: 'DRAFTED', decision, messageId };
  }

  const manual = await eligibility('MANUAL_SINGLE');
  if (!manual.eligible && !manual.deferrable) {
    await audit('reply.skipped', { reasons: manual.reasons, intent: decision.intent });
    return { status: 'SKIPPED', decision, reasons: manual.reasons };
  }
  const messageId = await draftForApproval(tx, ctx, { conversationId: conversation.id, inboundMessageId: inbound.id, text: decision.text }, flags);
  return { status: 'DRAFTED', decision, messageId };
}

/** Escalation hands the thread to a person: an AUTO thread drops to DRAFT (new mode version). Returns the version now current. */
async function escalate(tx: ScopedTx, ctx: AppCtx, conversation: { id: string; aiMode: ConversationAiMode; modeVersion: number }, decision: ReplyDecision, inboundMessageId: string): Promise<number> {
  let modeVersion = conversation.modeVersion;
  if (conversation.aiMode === 'AUTO') {
    modeVersion += 1;
    const cas = await tx.conversation.updateMany({ where: { id: conversation.id, modeVersion: conversation.modeVersion }, data: { aiMode: 'DRAFT', modeVersion } });
    if (cas.count !== 1) throw modeConflict(conversation.modeVersion, conversation.modeVersion);
  }
  await recordAudit(tx, ctx, {
    action: 'conversation.escalated',
    targetType: 'Conversation',
    targetId: conversation.id,
    simulated: ctx.mode === 'demo',
    summary: { intent: decision.intent, reason: decision.escalationReason, fromMode: conversation.aiMode, toMode: conversation.aiMode === 'AUTO' ? 'DRAFT' : conversation.aiMode, modeVersion, inboundMessageId },
  });
  return modeVersion;
}

/** A DRAFT reply with a PENDING OUTBOUND_MESSAGE approval: nothing is sent until a person approves it. */
async function draftForApproval(tx: ScopedTx, ctx: AppCtx, input: { conversationId: string; inboundMessageId: string; text: string }, flags: string[]): Promise<string> {
  const workspaceId = requireWorkspace(ctx);
  const now = ctx.clock.now();
  const message = await tx.message.create({
    data: {
      workspaceId,
      conversationId: input.conversationId,
      direction: 'OUT',
      channel: 'WHATSAPP',
      kind: 'TEXT',
      body: input.text,
      status: 'DRAFT',
      statusRank: 0,
      simulated: ctx.mode === 'demo',
      generatorLabel: REPLY_GENERATOR_LABEL,
      replyToInboundId: input.inboundMessageId,
      createdAt: now,
    },
    select: { id: true },
  });
  const approval = await tx.approval.create({ data: { workspaceId, kind: 'OUTBOUND_MESSAGE', status: 'PENDING', messageId: message.id, flags, requestedAt: now }, select: { id: true } });
  await recordAudit(tx as unknown as Tx, ctx, { action: 'reply.drafted', targetType: 'Message', targetId: message.id, simulated: ctx.mode === 'demo', summary: { approvalId: approval.id, flags, inboundMessageId: input.inboundMessageId } });
  return message.id;
}

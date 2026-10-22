/**
 * Conversations: AI mode, human takeover and automated replies (T21; PRD "respect human takeover
 * at dispatch; escalate uncertainty/complaints/human requests"; R21, R29, AT10; 01-arch race b,
 * 06-design F7; ADR-121, ADR-122).
 *
 * Mode (per thread):
 *  - `aiMode` is OFF, DRAFT (the default: replies wait for a person) or AUTO (selectable only while
 *    workspace auto-send is on, and only by someone with `automation.manage`).
 *  - `humanTakeover` overrides all three until "Resume AI".
 *  - Once the lead is handed over to the client (ADR-124), an EMPLOYEE actor's mode, takeover or
 *    resume request is refused with 409 HANDED_OVER (`assertNotHandedOver`); the client's are not.
 *  - Every change (mode, takeover, resume, escalation out of AUTO) bumps `modeVersion` with a
 *    compare-and-set, and is audited. An automated reply pins the version it was created under
 *    (`Message.modeVersionAtCreate`), so the dispatch preflight skips it (HUMAN_TAKEOVER or
 *    MODE_CHANGED, plan §7 check 5) if anything changed meanwhile, however briefly: takeover is
 *    respected at dispatch, not only when the reply is generated.
 *
 * Workspace auto-send (`WorkspaceSettings.autoSendEnabled`, default off) is an audited opt-in, shown
 * as "Automatic sending" (ADR-121: it also gates pipeline POLICY_AUTO sends). Turning it off stops
 * queued automated work at dispatch (AUTO_SEND_DISABLED, check 2a) and turns an AUTO thread's next
 * reply into a draft for approval.
 *
 * Automated replies (`reply.auto`, one per inbound text message, serialKey = conversationId, job
 * kind `ai`, ADR-122):
 *  - `webhook.process` calls `afterInboundMessage` for every inbound message in its transaction.
 *    For the newest inbound of a thread it cancels the thread's still-QUEUED automated replies to
 *    older messages (NEWER_INBOUND: a stale answer is never sent) and, for a text message in a
 *    DRAFT or AUTO thread without takeover whose lead is not handed over, enqueues the reply job.
 *  - `prepareAutoReply` (the job's first step, outside any transaction) checks the thread
 *    (`loadReplyState`: the message is still the newest inbound, not OFF, no takeover, not handed
 *    over, the 24-hour window open) and runs the reply guard (`services/ai/reply-guard.ts`), the
 *    pre-gate. Only a `service_faq` message, in a workspace with a catalog and a contact the reply
 *    could reach, goes to the `conversation_reply` model task (`services/ai/conversation-reply.ts`);
 *    every other intent keeps the guard's fixed texts. LIVE without an AI integration keeps the
 *    guard's catalog answer (`reply-guard`).
 *  - `commitAutoReply` (the job's fenced final transaction) checks the thread again and only then
 *    writes: the `reply.guard` audit (intent and rule names, never text), escalation, and the reply.
 *  - Escalation: complaint, human request, out of scope, a Stop inside longer text, a model answer
 *    that escalates or breaks the output policy, and a failed model call move an AUTO thread to
 *    DRAFT (new mode version, audited), so a person handles what follows; quote and call requests
 *    keep their fixed acknowledgement and the thread stays AUTO. Every escalation sets
 *    `Conversation.escalatedAt`, which feeds "Needs you" until a person replies (the composer
 *    clears it; a person's approved send after it resolves it in the inbox read model), resumes the
 *    AI or changes the mode.
 *  - Cap: after AUTOMATED_REPLY_CAP automated replies in a row (no person's message between), the
 *    next reply escalates (REPLY_CAP) and waits for approval instead of being sent.
 *  - AUTO: the reply is queued through the dispatch outbox with `sendIntent = AUTOMATED`,
 *    `initiatedBy = system:reply.auto`, the generator's label and the pinned mode version, so the
 *    shared preflight decides at dispatch (suppression, consent, window, pauses, quality, takeover).
 *    The first automated reply of each 24-hour window opens with the disclosure line
 *    (`automatedReplyDisclosure`). When the automated check already fails only for automation
 *    reasons (auto-send off, quality RED), the reply becomes a draft for approval instead (flag
 *    `auto_blocked:<reason>`).
 *  - DRAFT: a DRAFT Message with a PENDING OUTBOUND_MESSAGE approval flagged `ai_reply`; a person
 *    approves and sends it (`approveAndSendMessage`, MANUAL_SINGLE).
 *
 * `unansweredOutboundCount` (12.3, critic §6 #23): business messages sent since the customer's
 * last inbound. It grows by one for each outbound message the dispatch settle (or a status echo
 * resolving an AMBIGUOUS attempt) moves to SENT, and is reset to 0 by every inbound message (T20).
 * No cap is enforced on it; it is shown, not hardcoded.
 */
import type { Conversation, ConversationAiMode, Prisma } from '@/generated/prisma/client';
import { ConflictError, DomainRuleError, NotFoundError } from '@/lib/errors';
import { idempotencyKey } from '@/lib/ids';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability, requireWorkspace } from '@/server/auth/guards';
import type { ScopedDb, ScopedTx } from '@/server/db/scoped';
import { withTx } from '@/server/db/tx';
import { enqueueJob, type JobStore } from '@/server/jobs/queue';
import { recordAudit } from '@/server/services/audit/record';
import { decideFromModel, generateConversationReply, type HistoryMessage, CONVERSATION_HISTORY_LIMIT, type ModelReplyDecision } from '@/server/services/ai/conversation-reply';
import { automatedReplyDisclosure, decideAutoReply, loadReplyFacts, type ReplyDecision } from '@/server/services/ai/reply-guard';
import type { AiDeps, WorkspaceAiSelection } from '@/server/services/ai/run-task';
import { assertNotHandedOver } from '@/server/services/leads/handoff-guard';
import { queueOutboundMessage } from './dispatch';
import { checkDispatchEligibility, DEFERRABLE_REASONS, type ReasonCode } from './eligibility';
import { isWindowOpen, WINDOW_MS } from './window';

type Tx = Prisma.TransactionClient;
type Db = ScopedDb | ScopedTx;

export const REPLY_AUTO_JOB = 'reply.auto';
export const REPLY_PAYLOAD_VERSION = 1;
/** `initiatedBy` of every automated reply (E4: persisted on the Message and its attempts). */
export const REPLY_INITIATOR = 'system:reply.auto';
/** `Message.generatorLabel` of guard-written replies: fixed texts and catalog facts, never a model. */
export const REPLY_GENERATOR_LABEL = 'reply-guard';
/** Every label a `reply.auto` reply can carry: the guard's, or the generator of a `conversation_reply` answer. */
export const AUTO_REPLY_GENERATOR_LABELS = [REPLY_GENERATOR_LABEL, 'local-deterministic', 'anthropic', 'openai'] as const;
/** ADR-122: at most this many automated replies in a row; the next one escalates and waits for a person. */
export const AUTOMATED_REPLY_CAP = 4;

/** Eligibility reasons that stop automated sends but not a person's approved send (plan §7 checks 2-6). */
const AUTOMATION_ONLY_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>(['WORKSPACE_PAUSED', 'AUTO_SEND_DISABLED', 'HUMAN_TAKEOVER', 'MODE_CHANGED', 'QUALITY_PAUSED']);
/** Escalations that keep the thread in AUTO (ADR-122): the acknowledgement is enough, a person follows up. */
const STAYS_AUTO: ReadonlySet<string> = new Set(['quote_request', 'call_request']);

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

type ModePlan = { data: { aiMode?: ConversationAiMode; humanTakeover?: boolean; escalatedAt?: null }; action: string; summary: (next: number) => Record<string, unknown> };

/** One audited compare-and-set on `modeVersion`; `plan` returns null when nothing would change. */
async function changeMode(
  ctx: AppCtx,
  input: { conversationId: string; expectedModeVersion?: number },
  plan: (conversation: { aiMode: ConversationAiMode; humanTakeover: boolean }, tx: ScopedTx) => Promise<ModePlan | null>,
): Promise<ModeChangeResult> {
  return withTx(ctx.db, async (tx) => {
    const conversation = await tx.conversation.findFirst({ where: { id: input.conversationId } });
    if (!conversation) throw new NotFoundError();
    // ADR-124: a handed-over lead's conversations belong to the client; an operator cannot change them.
    await assertNotHandedOver(tx, ctx, conversation.leadId);
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

/** Off, Draft (default) or Auto. Auto needs workspace auto-send on and `automation.manage`. A person choosing a mode settles an escalation. */
export async function setConversationAiMode(ctx: AppCtx, input: { conversationId: string; aiMode: ConversationAiMode; expectedModeVersion?: number }): Promise<ModeChangeResult> {
  requireCapability(ctx, 'leads.write');
  if (input.aiMode === 'AUTO') requireCapability(ctx, 'automation.manage');
  return changeMode(ctx, input, async (conversation, tx) => {
    if (conversation.aiMode === input.aiMode) return null;
    if (input.aiMode === 'AUTO') {
      const settings = await tx.workspaceSettings.findFirst({ select: { autoSendEnabled: true } });
      if (!settings?.autoSendEnabled) {
        throw new DomainRuleError({ code: 'AUTO_SEND_OFF', userMessage: 'Turn on automatic sending for this workspace before setting a conversation to Auto.' });
      }
    }
    return { data: { aiMode: input.aiMode, escalatedAt: null }, action: 'conversation.ai_mode', summary: (next) => ({ from: conversation.aiMode, to: input.aiMode, modeVersion: next }) };
  });
}

/** A person takes the thread: automated replies stop at dispatch until "Resume AI". */
export async function takeOverConversation(ctx: AppCtx, input: { conversationId: string; expectedModeVersion?: number }): Promise<ModeChangeResult> {
  requireCapability(ctx, 'leads.write');
  return changeMode(ctx, input, async (conversation) =>
    conversation.humanTakeover ? null : { data: { humanTakeover: true }, action: 'conversation.takeover', summary: (next) => ({ aiMode: conversation.aiMode, modeVersion: next }) },
  );
}

/** "Resume AI": the thread's AI mode applies again; replies queued before keep their old version and stay blocked. Settles an escalation. */
export async function resumeConversationAi(ctx: AppCtx, input: { conversationId: string; expectedModeVersion?: number }): Promise<ModeChangeResult> {
  requireCapability(ctx, 'leads.write');
  return changeMode(ctx, input, async (conversation) =>
    conversation.humanTakeover ? { data: { humanTakeover: false, escalatedAt: null }, action: 'conversation.resume', summary: (next) => ({ aiMode: conversation.aiMode, modeVersion: next }) } : null,
  );
}

/** Workspace auto-send, the audited opt-in (R29, 06-design F7; "Automatic sending", ADR-121). Off by default. */
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
  const conversation = await tx.conversation.findFirst({ where: { id: input.conversationId }, select: { aiMode: true, humanTakeover: true, leadId: true } });
  if (!conversation || conversation.aiMode === 'OFF' || conversation.humanTakeover) return { supersededReplies, replyJobId: null };
  // ADR-124: a handed-over lead belongs to the client; nothing automated answers it.
  const lead = await tx.lead.findFirst({ where: { id: conversation.leadId }, select: { handedOverAt: true } });
  if (lead?.handedOverAt) return { supersededReplies, replyJobId: null };
  const { job } = await enqueueJob(tx as unknown as JobStore, ctx.clock, {
    type: REPLY_AUTO_JOB,
    payload: { conversationId: input.conversationId, inboundMessageId: input.inboundMessageId },
    payloadVersion: REPLY_PAYLOAD_VERSION,
    workspaceId,
    idempotencyKey: idempotencyKey(REPLY_AUTO_JOB, input.inboundMessageId),
    correlationId: ctx.correlationId,
    causationId: ctx.causationId ?? null,
    serialKey: input.conversationId,
    kind: 'ai',
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

// ---- The reply job (kind ai): prepare outside any transaction, commit in the fenced final one ---------

export type ReplyDeps = {
  contactKeyPepper: string;
  /** The AI dependencies (the credentials key ring); DEMO never reads them. */
  ai?: AiDeps;
  /** Test seam: a scripted generator selection (contract tests, no network). */
  selectAi?: (ctx: AppCtx) => Promise<WorkspaceAiSelection>;
};
export type ReplyJobInput = { conversationId: string; inboundMessageId: string };
export type ReplyOutcome =
  | { status: 'NOT_FOUND' | 'SUPERSEDED' | 'NOT_GENERATED' | 'NO_TEXT' }
  | { status: 'ALREADY_REPLIED'; messageId: string }
  | { status: 'NO_REPLY' | 'SKIPPED'; decision: ReplyDecision; reasons?: ReasonCode[] }
  | { status: 'QUEUED' | 'DRAFTED'; decision: ReplyDecision; messageId: string };

/** Why the reply job stops before deciding; `audit` is written by the caller's fenced transaction. */
type ReplyStop = { outcome: ReplyOutcome; audit?: { action: 'reply.superseded' | 'reply.not_generated'; reason: string } };
type ReplyState = { conversation: Conversation; inbound: { id: string; body: string; simulated: boolean; createdAt: Date } };

/**
 * The thread as the reply job needs it, or why no reply is made: the message is gone, the thread is
 * not WhatsApp, a reply exists, a newer inbound arrived, the thread is OFF or taken over, the lead
 * was handed over, there is no text, or the 24-hour window closed. Read-only.
 */
async function loadReplyState(db: Db, ctx: AppCtx, input: ReplyJobInput): Promise<{ ok: true; state: ReplyState } | { ok: false; stop: ReplyStop }> {
  const conversation = await db.conversation.findFirst({ where: { id: input.conversationId } });
  const inbound = conversation
    ? await db.message.findFirst({ where: { id: input.inboundMessageId, conversationId: conversation.id, direction: 'IN' }, select: { id: true, body: true, simulated: true, createdAt: true } })
    : null;
  if (!conversation || !inbound) return { ok: false, stop: { outcome: { status: 'NOT_FOUND' } } };
  // Inbound replies arrive on WhatsApp only (email has no inbound path: EMAIL_PROVIDER_CAPABILITIES).
  if (conversation.channel !== 'WHATSAPP') return { ok: false, stop: { outcome: { status: 'NOT_GENERATED' } } };
  const existing = await db.message.findFirst({
    where: { conversationId: conversation.id, direction: 'OUT', replyToInboundId: inbound.id, generatorLabel: { in: [...AUTO_REPLY_GENERATOR_LABELS] } },
    select: { id: true },
  });
  if (existing) return { ok: false, stop: { outcome: { status: 'ALREADY_REPLIED', messageId: existing.id } } };
  // A newer inbound arrived after this job was queued: its own job answers instead (never a stale reply).
  if (conversation.lastInboundMessageId !== inbound.id) return { ok: false, stop: { outcome: { status: 'SUPERSEDED' }, audit: { action: 'reply.superseded', reason: 'NEWER_INBOUND' } } };
  if (conversation.humanTakeover || conversation.aiMode === 'OFF') {
    return { ok: false, stop: { outcome: { status: 'NOT_GENERATED' }, audit: { action: 'reply.not_generated', reason: conversation.humanTakeover ? 'HUMAN_TAKEOVER' : 'AI_OFF' } } };
  }
  const lead = await db.lead.findFirst({ where: { id: conversation.leadId }, select: { handedOverAt: true } });
  if (lead?.handedOverAt) return { ok: false, stop: { outcome: { status: 'NOT_GENERATED' }, audit: { action: 'reply.not_generated', reason: 'HANDED_OVER' } } };
  if (!inbound.body || inbound.body.trim() === '') return { ok: false, stop: { outcome: { status: 'NO_TEXT' } } };
  // ADR-122: replies only inside the 24-hour window, never to wake a closed thread.
  if (!isWindowOpen(conversation.lastInboundProviderAt, ctx.clock.now())) {
    return { ok: false, stop: { outcome: { status: 'NOT_GENERATED' }, audit: { action: 'reply.not_generated', reason: 'WINDOW_CLOSED' } } };
  }
  return { ok: true, state: { conversation, inbound: { ...inbound, body: inbound.body } } };
}

async function writeStopAudit(tx: ScopedTx, ctx: AppCtx, input: ReplyJobInput, stop: ReplyStop, simulated: boolean): Promise<void> {
  if (!stop.audit) return;
  await recordAudit(tx, ctx, {
    action: stop.audit.action,
    targetType: 'Message',
    targetId: input.inboundMessageId,
    simulated,
    summary: { conversationId: input.conversationId, reason: stop.audit.reason },
  });
}

/** The thread's last 12 messages up to the inbound one, oldest first, as untrusted text (quick replies and empty bodies skipped). */
async function loadHistory(db: Db, conversationId: string, inbound: { id: string; createdAt: Date }): Promise<HistoryMessage[]> {
  const rows = await db.message.findMany({
    where: { conversationId, createdAt: { lte: inbound.createdAt }, status: { notIn: ['DRAFT', 'NOT_SENT', 'FAILED'] }, kind: { in: ['TEXT', 'TEMPLATE'] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: CONVERSATION_HISTORY_LIMIT + 4,
    select: { id: true, direction: true, body: true },
  });
  const lines = rows
    .filter((m) => (m.body ?? '').trim() !== '')
    .slice(0, CONVERSATION_HISTORY_LIMIT)
    .reverse()
    .map((m): HistoryMessage => ({ from: m.direction === 'IN' ? 'customer' : 'business', text: m.body! }));
  // The message being answered is always the last line.
  if (lines.at(-1)?.from !== 'customer') {
    const own = rows.find((m) => m.id === inbound.id);
    if (own?.body) lines.push({ from: 'customer', text: own.body });
  }
  return lines.slice(-CONVERSATION_HISTORY_LIMIT);
}

/** What the reply job decided outside the transaction, or why it stopped. */
export type PreparedReply = { kind: 'STOP'; stop: ReplyStop; simulated: boolean } | { kind: 'DECIDED'; reply: ModelReplyDecision; modelCalled: boolean };

const GUARD_ONLY = (decision: ReplyDecision): ModelReplyDecision => ({ decision, generatorLabel: REPLY_GENERATOR_LABEL, modelId: null, modelIntent: null });

/**
 * Step one of `reply.auto`, outside any transaction (it may call a model provider). Never writes.
 * `finalAttempt` is true on the job's last attempt: a retryable provider failure then becomes the
 * fixed handoff (AI_FAILED) instead of a retry.
 */
export async function prepareAutoReply(ctx: AppCtx, input: ReplyJobInput, deps: ReplyDeps, opts: { finalAttempt: boolean }): Promise<PreparedReply> {
  const workspaceId = requireWorkspace(ctx);
  const loaded = await loadReplyState(ctx.db, ctx, input);
  if (!loaded.ok) return { kind: 'STOP', stop: loaded.stop, simulated: ctx.mode === 'demo' };
  const { conversation, inbound } = loaded.state;
  const facts = await loadReplyFacts(ctx.db, workspaceId);
  const guard = decideAutoReply(inbound.body, facts);
  // ADR-122: only a service question, with a catalog to answer from, ever reaches the model.
  if (guard.intent !== 'service_faq' || facts.services.length === 0) return { kind: 'DECIDED', reply: GUARD_ONLY(guard), modelCalled: false };
  // No tokens for a reply that could not be sent anyway (suppressed, no consent, ...).
  const sendIntent = conversation.aiMode === 'AUTO' ? 'AUTOMATED' : 'MANUAL_SINGLE';
  const check = await checkDispatchEligibility(
    ctx.db,
    ctx,
    { leadId: conversation.leadId, channel: 'WHATSAPP', kind: 'WA_FREEFORM', conversationId: conversation.id, sendIntent, initiatedBy: REPLY_INITIATOR },
    { contactKeyPepper: deps.contactKeyPepper },
  );
  const blocking = check.reasons.filter((r) => !DEFERRABLE_REASONS.has(r) && !AUTOMATION_ONLY_REASONS.has(r));
  if (!check.eligible && !check.deferrable && blocking.length > 0) return { kind: 'DECIDED', reply: GUARD_ONLY(guard), modelCalled: false };

  const history = await loadHistory(ctx.db, conversation.id, inbound);
  const generation = await generateConversationReply(ctx, { facts, history, finalAttempt: opts.finalAttempt }, { ai: deps.ai ?? { keyRing: null }, ...(deps.selectAi ? { selectAi: deps.selectAi } : {}) });
  return { kind: 'DECIDED', reply: decideFromModel(guard, generation), modelCalled: generation.kind !== 'NOT_CONFIGURED' };
}

/** Automated replies in a row since the last message a person sent (a person's send ends the run). */
async function consecutiveAutomatedReplies(tx: Db, conversationId: string): Promise<number> {
  const recent = await tx.message.findMany({
    where: { conversationId, direction: 'OUT', status: { notIn: ['DRAFT', 'NOT_SENT', 'FAILED'] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: AUTOMATED_REPLY_CAP + 1,
    select: { initiatedBy: true, sendIntent: true },
  });
  let n = 0;
  for (const m of recent) {
    if (m.initiatedBy === REPLY_INITIATOR && m.sendIntent === 'AUTOMATED') n += 1;
    else if (m.sendIntent === 'MANUAL_SINGLE' || !(m.initiatedBy ?? '').startsWith('system:')) break;
  }
  return n;
}

/** When the current 24-hour window opened: the oldest inbound of the unbroken run that ends with the newest one. */
async function windowOpenedAt(tx: Db, conversationId: string, lastInboundAt: Date): Promise<Date> {
  const inbound = await tx.message.findMany({
    where: { conversationId, direction: 'IN', providerTs: { not: null, lte: lastInboundAt } },
    orderBy: [{ providerTs: 'desc' }, { id: 'desc' }],
    take: 500,
    select: { providerTs: true },
  });
  let opened = lastInboundAt;
  for (const m of inbound) {
    const t = m.providerTs!;
    if (opened.getTime() - t.getTime() >= WINDOW_MS) break;
    if (t.getTime() < opened.getTime()) opened = t;
  }
  return opened;
}

/** True when no automated reply reached (or is queued for) the customer since the window opened. */
async function firstAutomatedReplyOfWindow(tx: Db, conversation: Conversation): Promise<boolean> {
  if (conversation.lastInboundProviderAt === null) return true;
  const opened = await windowOpenedAt(tx, conversation.id, conversation.lastInboundProviderAt);
  const earlier = await tx.message.findFirst({
    where: { conversationId: conversation.id, direction: 'OUT', initiatedBy: REPLY_INITIATOR, sendIntent: 'AUTOMATED', status: { notIn: ['DRAFT', 'NOT_SENT', 'FAILED'] }, createdAt: { gte: opened } },
    select: { id: true },
  });
  return earlier === null;
}

/**
 * Step two of `reply.auto`, in the job's fenced, tenant-scoped transaction: checks the thread again
 * (newest inbound, mode, takeover, handoff, window; consent and the rest through the eligibility
 * check), then audits, escalates and queues or drafts the reply. A replay finds its reply and adds
 * nothing.
 */
export async function commitAutoReply(tx: ScopedTx, ctx: AppCtx, input: ReplyJobInput, prepared: PreparedReply, deps: ReplyDeps): Promise<ReplyOutcome> {
  if (prepared.kind === 'STOP') {
    await writeStopAudit(tx, ctx, input, prepared.stop, prepared.simulated);
    return prepared.stop.outcome;
  }
  const loaded = await loadReplyState(tx, ctx, input);
  if (!loaded.ok) {
    await writeStopAudit(tx, ctx, input, loaded.stop, ctx.mode === 'demo');
    return loaded.stop.outcome;
  }
  const { conversation, inbound } = loaded.state;
  const { decision, generatorLabel, modelId, modelIntent } = prepared.reply;
  const audit = (action: string, summary: Record<string, unknown>) =>
    recordAudit(tx, ctx, { action, targetType: 'Message', targetId: inbound.id, simulated: inbound.simulated, summary: { conversationId: conversation.id, ...summary } });
  // Intent, action, rule and generator names only: never the customer's text or the reply text.
  await audit('reply.guard', {
    intent: decision.intent,
    action: decision.action,
    escalate: decision.escalate,
    reason: decision.escalationReason,
    matchedServices: decision.matchedServiceIds.length,
    policyRules: decision.policyRules,
    generatorLabel,
    modelId,
    modelIntent,
    modelCalled: prepared.modelCalled,
  });

  let mode: ConversationAiMode = conversation.aiMode;
  let modeVersion = conversation.modeVersion;
  const state = { id: conversation.id, aiMode: conversation.aiMode, modeVersion };
  if (mode === 'AUTO' && (await consecutiveAutomatedReplies(tx, conversation.id)) >= AUTOMATED_REPLY_CAP) {
    // ADR-122 cap: this reply is not sent automatically; the thread leaves AUTO and a person approves it.
    modeVersion = await escalate(tx, ctx, state, { intent: decision.intent, reason: 'REPLY_CAP', staysAuto: false }, inbound.id);
    mode = 'DRAFT';
  } else if (decision.escalate) {
    modeVersion = await escalate(tx, ctx, state, { intent: decision.intent, reason: decision.escalationReason ?? decision.intent, staysAuto: STAYS_AUTO.has(decision.intent) }, inbound.id);
  }
  if (decision.action === 'NONE' || decision.text === null) return { status: 'NO_REPLY', decision };

  const flags = ['ai_reply', `intent:${decision.intent}`, ...(decision.escalate || mode !== conversation.aiMode ? ['escalated'] : [])];
  const leadId = conversation.leadId;
  const eligibility = (sendIntent: 'AUTOMATED' | 'MANUAL_SINGLE') =>
    checkDispatchEligibility(
      tx,
      ctx,
      { leadId, channel: 'WHATSAPP', kind: 'WA_FREEFORM', conversationId: conversation.id, sendIntent, initiatedBy: REPLY_INITIATOR, expectedModeVersion: modeVersion },
      { contactKeyPepper: deps.contactKeyPepper },
    );

  if (mode === 'AUTO') {
    const automated = await eligibility('AUTOMATED');
    if (automated.eligible || automated.deferrable) {
      const business = (await tx.workspace.findUniqueOrThrow({ where: { id: requireWorkspace(ctx) }, select: { name: true } })).name;
      const body = (await firstAutomatedReplyOfWindow(tx, conversation)) ? `${automatedReplyDisclosure(business)}\n\n${decision.text}` : decision.text;
      const queued = await queueOutboundMessage(
        tx,
        ctx,
        { kind: 'TEXT', body, generatorLabel, leadId, channel: 'WHATSAPP', sendIntent: 'AUTOMATED', initiatedBy: REPLY_INITIATOR, dedupeKey: `reply:${inbound.id}` },
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
    const messageId = await draftForApproval(tx, ctx, { conversationId: conversation.id, inboundMessageId: inbound.id, text: decision.text, generatorLabel }, [...flags, `auto_blocked:${blocking[0]!}`]);
    return { status: 'DRAFTED', decision, messageId };
  }

  const manual = await eligibility('MANUAL_SINGLE');
  if (!manual.eligible && !manual.deferrable) {
    await audit('reply.skipped', { reasons: manual.reasons, intent: decision.intent });
    return { status: 'SKIPPED', decision, reasons: manual.reasons };
  }
  const messageId = await draftForApproval(tx, ctx, { conversationId: conversation.id, inboundMessageId: inbound.id, text: decision.text, generatorLabel }, flags);
  return { status: 'DRAFTED', decision, messageId };
}

/**
 * Escalation hands the thread to a person and records when (`escalatedAt`, "Needs you"). An AUTO
 * thread drops to DRAFT (new mode version) unless the escalation stays in AUTO (quote and call
 * requests). Returns the mode version now current.
 */
async function escalate(
  tx: ScopedTx,
  ctx: AppCtx,
  conversation: { id: string; aiMode: ConversationAiMode; modeVersion: number },
  why: { intent: string; reason: string; staysAuto: boolean },
  inboundMessageId: string,
): Promise<number> {
  const now = ctx.clock.now();
  let modeVersion = conversation.modeVersion;
  const leaveAuto = conversation.aiMode === 'AUTO' && !why.staysAuto;
  if (leaveAuto) {
    modeVersion += 1;
    const cas = await tx.conversation.updateMany({ where: { id: conversation.id, modeVersion: conversation.modeVersion }, data: { aiMode: 'DRAFT', modeVersion, escalatedAt: now } });
    if (cas.count !== 1) throw modeConflict(conversation.modeVersion, conversation.modeVersion);
  } else {
    await tx.conversation.updateMany({ where: { id: conversation.id }, data: { escalatedAt: now } });
  }
  await recordAudit(tx, ctx, {
    action: 'conversation.escalated',
    targetType: 'Conversation',
    targetId: conversation.id,
    simulated: ctx.mode === 'demo',
    summary: { intent: why.intent, reason: why.reason, fromMode: conversation.aiMode, toMode: leaveAuto ? 'DRAFT' : conversation.aiMode, modeVersion, inboundMessageId },
  });
  return modeVersion;
}

/** A DRAFT reply with a PENDING OUTBOUND_MESSAGE approval: nothing is sent until a person approves it. */
async function draftForApproval(
  tx: ScopedTx,
  ctx: AppCtx,
  input: { conversationId: string; inboundMessageId: string; text: string; generatorLabel: string },
  flags: string[],
): Promise<string> {
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
      generatorLabel: input.generatorLabel,
      replyToInboundId: input.inboundMessageId,
      createdAt: now,
    },
    select: { id: true },
  });
  const approval = await tx.approval.create({ data: { workspaceId, kind: 'OUTBOUND_MESSAGE', status: 'PENDING', messageId: message.id, flags, requestedAt: now }, select: { id: true } });
  await recordAudit(tx as unknown as Tx, ctx, { action: 'reply.drafted', targetType: 'Message', targetId: message.id, simulated: ctx.mode === 'demo', summary: { approvalId: approval.id, flags, inboundMessageId: input.inboundMessageId } });
  return message.id;
}

/**
 * Lead handoff to the client (ADR-124, ADR-132; lead-gen slice F5). The operator who found and
 * worked a lead passes it to the client's team, who closes the deal through the quote flow; from
 * then on the operator side and the AI stop messaging the lead.
 *
 * `handOverLead(ctx, { leadId, note?, expectedStageVersion, requestKey }, deps)` (`leads.handoff`)
 * runs in ONE transaction, so a conflict anywhere writes nothing:
 *  1. Lead CAS on `stageVersion` (the version the person saw; a newer one is 409
 *     STAGE_VERSION_CONFLICT): the stage moves to CONVERTED unless it is already CONVERTED, the
 *     version is bumped and `handedOverAt` is set. A lost lead (422 LEAD_LOST) and a merged lead
 *     (422 LEAD_MERGED) are refused.
 *  2. Every open conversation of the lead: `aiMode OFF` and `humanTakeover` under a compare-and-set
 *     on `modeVersion` (409 MODE_VERSION_CONFLICT when it moved meanwhile), audited
 *     `conversation.handoff`. Automated replies queued before are skipped at dispatch (the mode
 *     version changed). The conversations are updated directly, not through takeOverConversation,
 *     because the handoff guard refuses an EMPLOYEE once `handedOverAt` is set.
 *  3. The lead's PENDING outbound-message approvals: INVALIDATED (`LEAD_HANDED_OVER`), and their
 *     DRAFT messages NOT_SENT, as a rejection would do. The operator side's queued sends that have
 *     not gone out (an EMPLOYEE's or the automation's): attempts CANCELLED (`LEAD_HANDED_OVER`,
 *     one `dispatch.cancelled` audit row each), jobs cancelled, messages NOT_SENT. Quotation
 *     approvals and quotation sends stay, and so do the client's own queued sends: the client
 *     carries on with the quote flow.
 *  4. The lead's open pipeline execution: its first unfinished stage is recorded FAILED with
 *     reason HANDED_OVER, which stops the executor (a FAILED stage ends the run; a job in flight
 *     settles with no effect).
 *  5. The LeadHandoff row (one per lead): `summaryStatus` PENDING when an AI generator is
 *     available (DEMO: the labelled local generator; LIVE: the workspace's AI integration),
 *     NOT_CONFIGURED in LIVE without one; the `handoff.summary` job is enqueued for PENDING.
 *  6. A PII-free `lead.handoff` audit row (stages, counts, ids, the summary status, whether a note
 *     was given and the request key; never the note).
 * A second handoff of the same lead is 409 ALREADY_HANDED_OVER, except a replay of the same
 * request key by the same person, which returns the first result (`created: false`).
 *
 * Reads: `loadLeadHandoff` (both lead pages), `listClientHandoffs` (the client's GET list).
 * `acknowledgeHandoff` is the client's "Acknowledge" (USER members of the workspace).
 */
import type { ConversationAiMode, LeadHandoff, Prisma, SalesStage } from '@/generated/prisma/client';
import { LEAD_GEN_JOB_TYPES, type HandoffSummaryStatus } from '@/lib/domain/lead-gen';
import { ConflictError, DomainRuleError, NotFoundError } from '@/lib/errors';
import { idempotencyKey } from '@/lib/ids';
import { parseStoredHandoffSummary, type AcknowledgeResultDto, type HandoffListItemDto, type HandoffStatusValue, type HandOverResultDto, type LeadHandoffDto, type LeadHandoffViewDto } from '@/lib/schemas/handoff';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability, requireRole, requireWorkspace } from '@/server/auth/guards';
import type { ScopedTx } from '@/server/db/scoped';
import { withTx } from '@/server/db/tx';
import { enqueueJob } from '@/server/jobs/queue';
import type { TxClient } from '@/server/jobs/types';
import { recordAudit } from '@/server/services/audit/record';
import { selectWorkspaceAi, type AiDeps } from '@/server/services/ai/run-task';
import { stageOrder } from '@/server/services/pipeline/executor';
import { StageVersionConflictError } from './stage';

export const HANDOFF_SUMMARY_JOB = LEAD_GEN_JOB_TYPES.handoffSummary;
export const HANDOFF_SUMMARY_PAYLOAD_VERSION = 1;
/** `Approval.invalidationReason` of the message drafts a handoff withdraws. */
export const HANDOFF_INVALIDATION_REASON = 'LEAD_HANDED_OVER';
/** `PipelineStageRun.reasonCode` of the stage a handoff stops. */
export const HANDOFF_PIPELINE_REASON = 'HANDED_OVER';
/** `DispatchAttempt.reasonCode` of the operator side's queued sends a handoff cancels. */
export const HANDOFF_CANCEL_REASON = 'LEAD_HANDED_OVER';
const SYSTEM_INITIATOR = /^system:/;
/** Handoffs the client's list returns at most. */
export const HANDOFF_LIST_LIMIT = 100;

/** Stages a handoff moves forward to CONVERTED (automatic promotions only move forward too). */
const FORWARD_STAGES: ReadonlySet<SalesStage> = new Set<SalesStage>(['NEW', 'CONTACTED', 'REPLIED', 'QUOTE_SENT']);
const TERMINAL_RUNS = new Set(['DONE', 'SKIPPED']);

export class HandoffExistsError extends ConflictError {
  static override readonly defaultCode: string = 'ALREADY_HANDED_OVER';
  static override readonly defaultUserMessage: string = 'This lead was already handed over to the client.';
}

export function handoffSummaryJobKey(handoffId: string): string {
  return idempotencyKey(HANDOFF_SUMMARY_JOB, handoffId);
}

export type HandOverInput = { leadId: string; note?: string | null; expectedStageVersion: number; requestKey: string };

/** PENDING when a generator is available now; NOT_CONFIGURED in LIVE without an AI integration. Reads only. */
async function initialSummaryStatus(ctx: AppCtx, deps: AiDeps): Promise<HandoffSummaryStatus> {
  const selection = await selectWorkspaceAi(ctx, deps);
  if (selection.ok) return 'PENDING';
  return selection.code === 'AI_NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'FAILED';
}

function modeConflict(current: number): ConflictError {
  return new ConflictError({
    code: 'MODE_VERSION_CONFLICT',
    userMessage: 'A conversation of this lead changed while you were handing it over. Reload the page and try again.',
    safeDetails: { currentModeVersion: current },
  });
}

async function takeOverConversations(tx: ScopedTx, ctx: AppCtx, leadId: string, simulated: boolean): Promise<string[]> {
  const open = await tx.conversation.findMany({ where: { leadId, closedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, aiMode: true, humanTakeover: true, modeVersion: true } });
  const changed: string[] = [];
  for (const c of open) {
    if (c.aiMode === 'OFF' && c.humanTakeover) continue;
    const next = c.modeVersion + 1;
    const data: { aiMode: ConversationAiMode; humanTakeover: boolean; modeVersion: number } = { aiMode: 'OFF', humanTakeover: true, modeVersion: next };
    const cas = await tx.conversation.updateMany({ where: { id: c.id, modeVersion: c.modeVersion }, data });
    if (cas.count !== 1) throw modeConflict(c.modeVersion);
    await recordAudit(tx, ctx, {
      action: 'conversation.handoff',
      targetType: 'Conversation',
      targetId: c.id,
      simulated,
      summary: { leadId, fromAiMode: c.aiMode, wasTakenOver: c.humanTakeover, aiMode: 'OFF', humanTakeover: true, modeVersion: next },
    });
    changed.push(c.id);
  }
  return changed;
}

async function withdrawMessageApprovals(tx: ScopedTx, leadId: string, now: Date): Promise<number> {
  const pending = await tx.approval.findMany({ where: { kind: 'OUTBOUND_MESSAGE', status: 'PENDING', message: { conversation: { leadId } } }, select: { id: true, messageId: true } });
  if (pending.length === 0) return 0;
  const result = await tx.approval.updateMany({
    where: { id: { in: pending.map((p) => p.id) }, status: 'PENDING' },
    data: { status: 'INVALIDATED', invalidatedAt: now, invalidationReason: HANDOFF_INVALIDATION_REASON },
  });
  const messageIds = pending.map((p) => p.messageId).filter((id): id is string => id !== null);
  if (messageIds.length > 0) await tx.message.updateMany({ where: { id: { in: messageIds }, status: 'DRAFT' }, data: { status: 'NOT_SENT' } });
  return result.count;
}

/**
 * The operator side's sends to the lead that are queued but have not gone out (held by a pause,
 * quiet hours, a cap or a busy worker): started by an EMPLOYEE (composer, approval send, bulk) or
 * by the automation (`system:*`: AI replies, the pipeline). Each attempt is CANCELLED
 * (`LEAD_HANDED_OVER`), its queued job cancelled (a claimed one is asked to stop and finds its
 * attempt cancelled before any send), its message NOT_SENT, and one `dispatch.cancelled` audit
 * row per attempt (the same row the delivery checks write; the reason only, never the text). The
 * client's own queued sends and quotation sends stay: the client carries on with the quote flow
 * (ADR-132).
 */
async function cancelOperatorQueuedSends(tx: ScopedTx, ctx: AppCtx, leadId: string, now: Date): Promise<number> {
  const queued = await tx.dispatchAttempt.findMany({
    where: { state: 'QUEUED', quoteVersionId: null, message: { direction: 'OUT', conversation: { leadId } } },
    select: { id: true, jobId: true, messageId: true, initiatedBy: true },
  });
  if (queued.length === 0) return 0;
  const people = [...new Set(queued.map((a) => a.initiatedBy).filter((id) => !SYSTEM_INITIATOR.test(id)))];
  const employees = people.length === 0 ? new Set<string>() : new Set((await tx.user.findMany({ where: { id: { in: people }, globalRole: 'EMPLOYEE' }, select: { id: true } })).map((u) => u.id));
  const operatorSide = queued.filter((a) => SYSTEM_INITIATOR.test(a.initiatedBy) || employees.has(a.initiatedBy));
  if (operatorSide.length === 0) return 0;
  const cancelled = await tx.dispatchAttempt.updateMany({
    where: { id: { in: operatorSide.map((a) => a.id) }, state: 'QUEUED' },
    data: { state: 'CANCELLED', reasonCode: HANDOFF_CANCEL_REASON, updatedAt: now },
  });
  const jobIds = [...new Set(operatorSide.map((a) => a.jobId))];
  await tx.job.updateMany({ where: { id: { in: jobIds }, status: 'QUEUED' }, data: { status: 'CANCELLED', finishedAt: now, updatedAt: now } });
  await tx.job.updateMany({ where: { id: { in: jobIds }, status: 'RUNNING', cancelRequestedAt: null }, data: { cancelRequestedAt: now, updatedAt: now } });
  await tx.message.updateMany({ where: { id: { in: operatorSide.map((a) => a.messageId) }, status: 'PENDING' }, data: { status: 'NOT_SENT' } });
  for (const attempt of operatorSide) {
    await recordAudit(tx, ctx, { action: 'dispatch.cancelled', targetType: 'DispatchAttempt', targetId: attempt.id, simulated: ctx.mode === 'demo', summary: { reasons: [HANDOFF_CANCEL_REASON] } });
  }
  return cancelled.count;
}

/** Stops the lead's open pipeline execution at its first unfinished stage. Null when there is none. */
async function haltOpenExecution(tx: ScopedTx, workspaceId: string, leadId: string, now: Date): Promise<{ executionId: string; stage: string } | null> {
  const execution = await tx.pipelineExecution.findFirst({ where: { leadId }, include: { pipelineConfigVersion: { select: { graph: true } }, stageRuns: true } });
  if (!execution) return null;
  const order = stageOrder(execution.pipelineConfigVersion.graph);
  if (order === null) return null;
  const runs = new Map(execution.stageRuns.map((r) => [r.stage, r]));
  // A FAILED stage already ended the run; a run whose stages all finished is not open.
  if (execution.stageRuns.some((r) => r.status === 'FAILED')) return null;
  const stage = order.find((s) => !TERMINAL_RUNS.has(runs.get(s)?.status ?? ''));
  if (stage === undefined) return null;
  const existing = runs.get(stage);
  if (existing) {
    await tx.pipelineStageRun.updateMany({ where: { id: existing.id }, data: { status: 'FAILED', reasonCode: HANDOFF_PIPELINE_REASON, finishedAt: now } });
  } else {
    await tx.pipelineStageRun.create({ data: { workspaceId, executionId: execution.id, stage, status: 'FAILED', reasonCode: HANDOFF_PIPELINE_REASON, startedAt: now, finishedAt: now } });
  }
  await tx.pipelineExecution.updateMany({ where: { id: execution.id }, data: { currentStage: stage, updatedAt: now } });
  return { executionId: execution.id, stage };
}

/** True when `existing` was written by this same request (same person, same request key). */
async function isReplay(tx: ScopedTx, existing: LeadHandoff, actorId: string, requestKey: string): Promise<boolean> {
  if (existing.fromUserId !== actorId) return false;
  const audit = await tx.auditEvent.findFirst({ where: { action: 'lead.handoff', targetType: 'Lead', targetId: existing.leadId }, orderBy: { createdAt: 'desc' }, select: { summary: true } });
  return (audit?.summary as { requestKey?: unknown } | null)?.requestKey === requestKey;
}

export async function handOverLead(ctx: AppCtx, input: HandOverInput, deps: AiDeps): Promise<HandOverResultDto> {
  requireCapability(ctx, 'leads.handoff');
  const workspaceId = requireWorkspace(ctx);
  const actorId = ctx.actor?.userId ?? `system:${ctx.kind}`;
  const note = input.note?.trim() ? input.note.trim() : null;
  // Before the transaction: picking the generator reads the workspace's integrations (no provider call).
  const summaryStatus = await initialSummaryStatus(ctx, deps);

  return withTx(ctx.db, async (tx) => {
    const lead = await tx.lead.findFirst({ where: { id: input.leadId }, select: { id: true, salesStage: true, stageVersion: true, mergedIntoLeadId: true, handedOverAt: true, simulated: true } });
    if (!lead) throw new NotFoundError();
    const existing = await tx.leadHandoff.findFirst({ where: { leadId: lead.id } });
    if (existing) {
      if (await isReplay(tx, existing, actorId, input.requestKey)) {
        return {
          handoffId: existing.id,
          created: false,
          summaryStatus: existing.summaryStatus as HandoffSummaryStatus,
          lead: { id: lead.id, salesStage: lead.salesStage, stageVersion: lead.stageVersion, handedOverAt: (lead.handedOverAt ?? existing.createdAt).toISOString() },
        };
      }
      throw new HandoffExistsError({ safeDetails: { handoffId: existing.id } });
    }
    if (lead.handedOverAt !== null) throw new HandoffExistsError();
    if (lead.mergedIntoLeadId !== null) throw new DomainRuleError({ code: 'LEAD_MERGED', userMessage: 'This lead was merged into another lead. Hand over that lead instead.' });
    if (lead.salesStage === 'LOST') throw new DomainRuleError({ code: 'LEAD_LOST', userMessage: 'This lead is marked Lost. Move it back to an open stage before handing it over.' });
    const conflict = () =>
      new StageVersionConflictError({ safeDetails: { currentStage: lead.salesStage, currentStageVersion: lead.stageVersion, expectedStageVersion: input.expectedStageVersion } });
    if (lead.stageVersion !== input.expectedStageVersion) throw conflict();

    const now = ctx.clock.now();
    const toStage: SalesStage = FORWARD_STAGES.has(lead.salesStage) ? 'CONVERTED' : lead.salesStage;
    const stageVersion = lead.stageVersion + 1;
    const cas = await tx.lead.updateMany({
      where: { id: lead.id, stageVersion: input.expectedStageVersion, handedOverAt: null },
      data: { salesStage: toStage, stageVersion, handedOverAt: now, updatedAt: now },
    });
    if (cas.count !== 1) throw conflict();

    const conversationIds = await takeOverConversations(tx, ctx, lead.id, lead.simulated);
    const invalidatedApprovals = await withdrawMessageApprovals(tx, lead.id, now);
    const cancelledSends = await cancelOperatorQueuedSends(tx, ctx, lead.id, now);
    const halted = await haltOpenExecution(tx, workspaceId, lead.id, now);
    const handoff = await tx.leadHandoff.create({
      data: { workspaceId, leadId: lead.id, fromUserId: actorId, note, summaryStatus, status: 'HANDED_OVER', createdAt: now },
      select: { id: true },
    });
    let summaryJobId: string | null = null;
    if (summaryStatus === 'PENDING') {
      const { job } = await enqueueJob(tx as unknown as TxClient, ctx.clock, {
        type: HANDOFF_SUMMARY_JOB,
        payload: { handoffId: handoff.id },
        payloadVersion: HANDOFF_SUMMARY_PAYLOAD_VERSION,
        workspaceId,
        idempotencyKey: handoffSummaryJobKey(handoff.id),
        correlationId: ctx.correlationId,
        causationId: ctx.causationId ?? null,
        kind: 'ai',
      });
      summaryJobId = job.id;
    }
    await recordAudit(tx, ctx, {
      action: 'lead.handoff',
      targetType: 'Lead',
      targetId: lead.id,
      simulated: lead.simulated,
      summary: {
        handoffId: handoff.id,
        from: lead.salesStage,
        to: toStage,
        stageVersion,
        conversationIds,
        conversations: conversationIds.length,
        invalidatedApprovals,
        cancelledSends,
        pipelineHalted: halted === null ? null : { executionId: halted.executionId, stage: halted.stage },
        summaryStatus,
        summaryJobId,
        hasNote: note !== null,
        requestKey: input.requestKey,
      },
    });
    return { handoffId: handoff.id, created: true, summaryStatus, lead: { id: lead.id, salesStage: toStage, stageVersion, handedOverAt: now.toISOString() } };
  });
}

// ---- Acknowledge (the client) --------------------------------------------------------------------

/** The client's "Acknowledge": HANDED_OVER -> ACKNOWLEDGED (once; a repeat is a no-op). USER members only. */
export async function acknowledgeHandoff(ctx: AppCtx, input: { handoffId: string }): Promise<AcknowledgeResultDto> {
  const actor = requireRole(ctx, 'USER');
  requireCapability(ctx, 'leads.read');
  return withTx(ctx.db, async (tx) => {
    const handoff = await tx.leadHandoff.findFirst({ where: { id: input.handoffId }, select: { id: true, leadId: true, status: true } });
    if (!handoff) throw new NotFoundError();
    if (handoff.status === 'ACKNOWLEDGED') return { handoffId: handoff.id, status: 'ACKNOWLEDGED' as const, changed: false };
    const now = ctx.clock.now();
    const cas = await tx.leadHandoff.updateMany({ where: { id: handoff.id, status: 'HANDED_OVER' }, data: { status: 'ACKNOWLEDGED', acknowledgedBy: actor.userId, acknowledgedAt: now } });
    if (cas.count !== 1) return { handoffId: handoff.id, status: 'ACKNOWLEDGED' as const, changed: false };
    const lead = await tx.lead.findFirst({ where: { id: handoff.leadId }, select: { simulated: true } });
    await recordAudit(tx, ctx, { action: 'lead.handoff.acknowledge', targetType: 'Lead', targetId: handoff.leadId, simulated: lead?.simulated ?? false, summary: { handoffId: handoff.id } });
    return { handoffId: handoff.id, status: 'ACKNOWLEDGED' as const, changed: true };
  });
}

// ---- Reads ----------------------------------------------------------------------------------------

async function userNames(ctx: AppCtx, ids: ReadonlyArray<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null && !id.startsWith('system:')))];
  if (wanted.length === 0) return new Map();
  const users = await ctx.db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

function toDto(row: LeadHandoff, names: Map<string, string>): LeadHandoffDto {
  return {
    id: row.id,
    leadId: row.leadId,
    status: row.status as HandoffStatusValue,
    note: row.note,
    summary: row.summaryStatus === 'READY' ? parseStoredHandoffSummary(row.summary) : null,
    summaryStatus: row.summaryStatus as HandoffSummaryStatus,
    summaryGeneratorLabel: row.summaryGeneratorLabel,
    fromUserName: names.get(row.fromUserId) ?? null,
    createdAt: row.createdAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    acknowledgedByName: row.acknowledgedBy ? (names.get(row.acknowledgedBy) ?? null) : null,
  };
}

export type LeadHandoffView = LeadHandoffViewDto;

/**
 * The handoff state of one lead for both lead pages. With `deps` (the operator page) it also says
 * whether a summary would be written if the lead were handed over now; without, `summaryAvailable`
 * is false and no integration is read.
 */
export async function loadLeadHandoff(ctx: AppCtx, leadId: string, deps?: AiDeps): Promise<LeadHandoffView> {
  requireCapability(ctx, 'leads.read');
  const workspaceId = requireWorkspace(ctx);
  const lead = await ctx.db.lead.findFirst({ where: { id: leadId }, select: { id: true, displayName: true, salesStage: true, stageVersion: true, handedOverAt: true, mergedIntoLeadId: true } });
  if (!lead) throw new NotFoundError();
  const [row, workspace] = await Promise.all([
    ctx.db.leadHandoff.findFirst({ where: { leadId } }),
    ctx.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { slug: true, name: true } }),
  ]);
  const names = row ? await userNames(ctx, [row.fromUserId, row.acknowledgedBy]) : new Map<string, string>();
  const canHandOff = hasCapability(ctx, 'leads.handoff');
  const summaryAvailable = row === null && canHandOff && deps !== undefined ? (await initialSummaryStatus(ctx, deps)) === 'PENDING' : false;
  return {
    handoff: row ? toDto(row, names) : null,
    lead: { id: lead.id, displayName: lead.displayName, salesStage: lead.salesStage, stageVersion: lead.stageVersion, handedOverAt: lead.handedOverAt?.toISOString() ?? null, merged: lead.mergedIntoLeadId !== null },
    workspace,
    summaryAvailable,
    permissions: { canHandOff, canAcknowledge: ctx.actor?.role === 'USER' && hasCapability(ctx, 'leads.read') },
  };
}

/** The client's handoffs, newest first: every one, or only those not acknowledged yet (`open`). */
export async function listClientHandoffs(ctx: AppCtx, input: { status?: 'open' | 'all' } = {}): Promise<HandoffListItemDto[]> {
  requireRole(ctx, 'USER');
  requireCapability(ctx, 'leads.read');
  const where: Prisma.LeadHandoffWhereInput = input.status === 'open' ? { status: 'HANDED_OVER' } : {};
  const rows = await ctx.db.leadHandoff.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: HANDOFF_LIST_LIMIT });
  if (rows.length === 0) return [];
  const [names, leads] = await Promise.all([
    userNames(ctx, rows.flatMap((r) => [r.fromUserId, r.acknowledgedBy])),
    ctx.db.lead.findMany({ where: { id: { in: rows.map((r) => r.leadId) } }, select: { id: true, displayName: true, salesStage: true } }),
  ]);
  const leadById = new Map(leads.map((l) => [l.id, l]));
  return rows.flatMap((row) => {
    const lead = leadById.get(row.leadId);
    return lead ? [{ ...toDto(row, names), lead: { id: lead.id, displayName: lead.displayName, salesStage: lead.salesStage } }] : [];
  });
}

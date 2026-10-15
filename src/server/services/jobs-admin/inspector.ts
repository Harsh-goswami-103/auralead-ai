/**
 * Job inspector (R33, T24): the super admin's view of the persistent queue and its three actions.
 *
 * Reads (platform metadata, no tenant records): jobs with their workspace, a redacted payload
 * (payloads carry ids and versions only, plan §4.3, and pass through `redact()` again here), the
 * JobAttempt log, the job's DispatchAttempts, and a correlation timeline (audit rows and jobs that
 * share the job's correlation id, plus jobs it caused). Audit summaries are PII-free by contract.
 *
 * Actions (each with a typed reason; the route also requires a fresh authentication). For a
 * workspace job the action runs under `adminContext`, which commits an `admin.elevate` audit row
 * first; the action's own audit row is crossWorkspace with the reason.
 *  - cancel: QUEUED -> CANCELLED (a dispatch job's QUEUED attempt CANCELLED(OPERATOR_CANCELLED),
 *    its message NOT_SENT); RUNNING -> cancel requested (observed by the runner). Terminal: 409.
 *  - retry (plan §6.2 DEAD -> QUEUED, "safe retry"):
 *      a job type without provider side effects (everything but dispatch) is requeued as is;
 *      a dispatch job gets attempt N+1 on a NEW job, so the whole preflight runs again (O3, §7),
 *      and only when its last attempt definitely did not send (FAILED PRE_SEND or RETRYABLE, or
 *      resolved "not delivered" by an operator). An unresolved AMBIGUOUS attempt is 409
 *      AMBIGUOUS_UNRESOLVED: the operator must resolve it first (no blind resend, §4.4).
 *  - resolve an AMBIGUOUS attempt: "Mark delivered" (SENT, lead stage and quote move as on a
 *    settle) or "Verified not delivered" (FAILED), optionally requeued (attempt N+1 on a new job),
 *    which needs the confirm text RESEND.
 */
import type { DispatchAttempt, Job, JobAttempt, JobStatus, Prisma, PrismaClient } from '@/generated/prisma/client';
import { RESEND_CONFIRM_TEXT } from '@/lib/schemas/admin';
import { ConflictError, DomainRuleError, NotFoundError } from '@/lib/errors';
import { idempotencyKey } from '@/lib/ids';
import { redact } from '@/lib/redact';
import { adminContext, baseClientOf, type AppCtx } from '@/server/auth/context';
import { requireRole } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { enqueueJob, requestCancel, type JobStore } from '@/server/jobs/queue';
import { recordAudit } from '@/server/services/audit/record';
import { projectUnsent, projectUnsentMany, STATUS_RANK } from '@/server/services/messaging/delivery-state';
import { attemptKey, DISPATCH_JOB_TYPES, DISPATCH_PAYLOAD_VERSION, dispatchJobType } from '@/server/services/messaging/dispatch';
import { nextQuoteStatus } from '@/server/services/quotes/state-machine';

type Tx = Prisma.TransactionClient;

export const OUTBOUND_JOB_TYPES: ReadonlySet<string> = new Set(Object.values(DISPATCH_JOB_TYPES));
export const JOB_STATUSES: readonly JobStatus[] = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'DEAD', 'CANCELLED'];
export const OPERATOR_CANCELLED = 'OPERATOR_CANCELLED';
export const OPERATOR_NOT_DELIVERED = 'OPERATOR_NOT_DELIVERED';
export { RESEND_CONFIRM_TEXT };

const LIST_LIMIT_MAX = 100;
const TIMELINE_LIMIT = 200;
const LEAD_STAGE_ORDER = ['NEW', 'CONTACTED', 'REPLIED', 'QUOTE_SENT', 'CONVERTED'] as const;

function prismaOf(ctx: AppCtx): PrismaClient {
  requireRole(ctx, 'SUPER_ADMIN');
  return baseClientOf(ctx);
}

// ---- Reads ---------------------------------------------------------------------------------------

export type JobListFilter = { status?: JobStatus; type?: string; workspaceId?: string; before?: string; limit?: number };

export type JobRow = {
  id: string;
  type: string;
  status: JobStatus;
  /** UI label: QUEUED with a future runAt is "Retry waiting" (C7). */
  label: string;
  workspace: { id: string; slug: string; name: string } | null;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  createdAt: Date;
  updatedAt: Date;
  deadReason: string | null;
  lastErrorCode: string | null;
  correlationId: string;
};

export function jobLabel(job: Pick<Job, 'status' | 'runAt' | 'deadReason' | 'cancelRequestedAt'>, now: Date): string {
  switch (job.status) {
    case 'QUEUED':
      return job.runAt.getTime() > now.getTime() ? 'Retry waiting' : 'Queued';
    case 'RUNNING':
      return job.cancelRequestedAt ? 'Running (cancel requested)' : 'Running';
    case 'SUCCEEDED':
      return 'Succeeded';
    case 'CANCELLED':
      return 'Cancelled';
    case 'DEAD':
      return job.deadReason === 'AMBIGUOUS' ? 'Dead: delivery unknown' : `Dead${job.deadReason ? `: ${job.deadReason}` : ''}`;
  }
}

async function workspaceMap(prisma: PrismaClient, ids: readonly (string | null)[]): Promise<Map<string, { id: string; slug: string; name: string }>> {
  const wanted = [...new Set(ids.filter((v): v is string => v !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await prisma.workspace.findMany({ where: { id: { in: wanted } }, select: { id: true, slug: true, name: true } });
  return new Map(rows.map((r) => [r.id, r]));
}

export async function listJobs(ctx: AppCtx, filter: JobListFilter = {}): Promise<{ rows: JobRow[]; nextCursor: string | null; types: string[] }> {
  const prisma = prismaOf(ctx);
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), LIST_LIMIT_MAX);
  const where: Prisma.JobWhereInput = {
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.type ? { type: filter.type } : {}),
    ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
  };
  if (filter.before) {
    const cursor = await prisma.job.findUnique({ where: { id: filter.before }, select: { createdAt: true, id: true } });
    if (cursor) where.OR = [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }];
  }
  const jobs = await prisma.job.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
  const page = jobs.slice(0, limit);
  const workspaces = await workspaceMap(prisma, page.map((j) => j.workspaceId));
  const types = (await prisma.job.findMany({ distinct: ['type'], select: { type: true }, orderBy: { type: 'asc' } })).map((t) => t.type);
  const now = ctx.clock.now();
  return {
    rows: page.map((j) => ({
      id: j.id,
      type: j.type,
      status: j.status,
      label: jobLabel(j, now),
      workspace: j.workspaceId ? (workspaces.get(j.workspaceId) ?? null) : null,
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
      runAt: j.runAt,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      deadReason: j.deadReason,
      lastErrorCode: j.lastErrorCode,
      correlationId: j.correlationId,
    })),
    nextCursor: jobs.length > limit ? (page.at(-1)?.id ?? null) : null,
    types,
  };
}

export type RetryCheck = { allowed: boolean; mode: 'requeued' | 'new-attempt' | null; code: string | null; reason: string };

/**
 * Whether the DEAD job may be retried and how (plan §6.2). `attempts` are the DispatchAttempts of
 * the job's message (all jobs), oldest first; empty for other job types.
 */
export function retryCheck(job: Pick<Job, 'type' | 'status' | 'deadReason' | 'retrySafe'>, attempts: ReadonlyArray<Pick<DispatchAttempt, 'state' | 'failureClass' | 'resolvedBy' | 'jobId'>>): RetryCheck {
  if (job.status !== 'DEAD') return { allowed: false, mode: null, code: 'JOB_NOT_DEAD', reason: 'Only a dead job can be retried.' };
  if (!OUTBOUND_JOB_TYPES.has(job.type)) {
    if (job.deadReason === 'AMBIGUOUS' && !job.retrySafe) return { allowed: false, mode: null, code: 'AMBIGUOUS_UNRESOLVED', reason: 'The job died with an unknown outcome.' };
    return { allowed: true, mode: 'requeued', code: null, reason: 'This job type has no provider side effects; it is requeued as is.' };
  }
  if (attempts.some((a) => a.state === 'AMBIGUOUS')) {
    return { allowed: false, mode: null, code: 'AMBIGUOUS_UNRESOLVED', reason: 'Delivery unknown: resolve the attempt (delivered or not) before any resend.' };
  }
  const last = attempts.at(-1);
  if (!last) return { allowed: false, mode: null, code: 'NOTHING_TO_RETRY', reason: 'The job has no send attempt.' };
  if (last.state === 'QUEUED' || last.state === 'SENDING') return { allowed: false, mode: null, code: 'RETRY_ALREADY_QUEUED', reason: 'A newer attempt for this message is already queued.' };
  if (last.state === 'SENT') return { allowed: false, mode: null, code: 'NOTHING_TO_RETRY', reason: 'The message was sent.' };
  const definitelyUnsent = last.state === 'FAILED' && (last.failureClass === 'PRE_SEND' || last.failureClass === 'RETRYABLE' || last.resolvedBy !== null);
  if (!definitelyUnsent) return { allowed: false, mode: null, code: 'RETRY_NOT_SAFE', reason: 'The last attempt was skipped, cancelled or permanently rejected; a resend would not be safe or useful.' };
  return { allowed: true, mode: 'new-attempt', code: null, reason: 'A new attempt runs the full preflight (consent, suppression, approval, pause) again.' };
}

export type TimelineItem = { at: Date; kind: 'audit' | 'job' | 'attempt'; label: string; detail: string; ref: string; workspaceId: string | null };

export type JobDetail = {
  job: JobRow & {
    payload: unknown;
    payloadVersion: number;
    priority: number;
    serialKey: string | null;
    idempotencyKey: string;
    retrySafe: boolean;
    lastErrorRedacted: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    leaseUntil: Date | null;
    cancelRequestedAt: Date | null;
    causationId: string | null;
  };
  attempts: JobAttempt[];
  dispatchAttempts: DispatchAttempt[];
  timeline: TimelineItem[];
  actions: { cancel: boolean; retry: RetryCheck; resolvableAttemptIds: string[] };
};

async function messageAttempts(db: Pick<PrismaClient, 'dispatchAttempt'> | Tx, job: Job): Promise<DispatchAttempt[]> {
  if (!OUTBOUND_JOB_TYPES.has(job.type)) return [];
  const own = await db.dispatchAttempt.findMany({ where: { jobId: job.id }, orderBy: { attemptNo: 'asc' } });
  const messageIds = [...new Set(own.map((a) => a.messageId))];
  if (messageIds.length === 0) return [];
  return db.dispatchAttempt.findMany({ where: { messageId: { in: messageIds } }, orderBy: [{ messageId: 'asc' }, { attemptNo: 'asc' }] });
}

export async function getJobDetail(ctx: AppCtx, jobId: string): Promise<JobDetail> {
  const prisma = prismaOf(ctx);
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new NotFoundError();
  const now = ctx.clock.now();
  const workspace = job.workspaceId ? ((await workspaceMap(prisma, [job.workspaceId])).get(job.workspaceId) ?? null) : null;
  const attempts = await prisma.jobAttempt.findMany({ where: { jobId }, orderBy: { attemptNo: 'asc' } });
  const allDispatch = await messageAttempts(prisma, job);
  const dispatchAttempts = allDispatch.filter((a) => a.jobId === job.id);

  const audits = await prisma.auditEvent.findMany({ where: { correlationId: job.correlationId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: TIMELINE_LIMIT });
  const related = await prisma.job.findMany({
    where: { OR: [{ correlationId: job.correlationId }, { causationId: job.id }, ...(job.causationId ? [{ id: job.causationId }] : [])] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: TIMELINE_LIMIT,
  });
  const timeline: TimelineItem[] = [
    ...audits.map((a) => ({ at: a.createdAt, kind: 'audit' as const, label: a.action, detail: `${a.actorKind} ${a.result} on ${a.targetType}${a.crossWorkspace ? ' (cross-workspace)' : ''}`, ref: a.targetId, workspaceId: a.workspaceId })),
    ...related.map((j) => ({ at: j.createdAt, kind: 'job' as const, label: `${j.type} enqueued`, detail: jobLabel(j, now), ref: j.id, workspaceId: j.workspaceId })),
    ...attempts.map((a) => ({ at: a.startedAt, kind: 'attempt' as const, label: `attempt ${a.attemptNo}`, detail: `${a.outcome ?? 'IN_FLIGHT'}${a.errorCode ? ` ${a.errorCode}` : ''}`, ref: a.id, workspaceId: a.workspaceId })),
  ].sort((x, y) => x.at.getTime() - y.at.getTime());

  return {
    job: {
      id: job.id,
      type: job.type,
      status: job.status,
      label: jobLabel(job, now),
      workspace,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      runAt: job.runAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      deadReason: job.deadReason,
      lastErrorCode: job.lastErrorCode,
      correlationId: job.correlationId,
      payload: redact(job.payload),
      payloadVersion: job.payloadVersion,
      priority: job.priority,
      serialKey: job.serialKey,
      idempotencyKey: job.idempotencyKey,
      retrySafe: job.retrySafe,
      lastErrorRedacted: job.lastErrorRedacted,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      leaseUntil: job.leaseUntil,
      cancelRequestedAt: job.cancelRequestedAt,
      causationId: job.causationId,
    },
    attempts,
    dispatchAttempts,
    timeline,
    actions: {
      cancel: job.status === 'QUEUED' || (job.status === 'RUNNING' && job.cancelRequestedAt === null),
      retry: retryCheck(job, allDispatch),
      resolvableAttemptIds: dispatchAttempts.filter((a) => a.state === 'AMBIGUOUS').map((a) => a.id),
    },
  };
}

// ---- Actions ---------------------------------------------------------------------------------------

/** The context an action runs under: elevated (audited) into the job's workspace, or the admin's own for system jobs. */
async function actingContext(ctx: AppCtx, workspaceId: string | null, reason: string): Promise<AppCtx> {
  return workspaceId === null ? ctx : adminContext(ctx, workspaceId, reason);
}

async function loadJob(prisma: PrismaClient, jobId: string): Promise<Job> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new NotFoundError();
  return job;
}

export async function cancelJob(ctx: AppCtx, input: { jobId: string; reason: string }): Promise<{ status: JobStatus; cancelRequested: boolean; attemptsCancelled: number }> {
  const prisma = prismaOf(ctx);
  const job = await loadJob(prisma, input.jobId);
  if (job.status !== 'QUEUED' && job.status !== 'RUNNING') {
    throw new ConflictError({ code: 'JOB_NOT_CANCELLABLE', userMessage: `This job is ${job.status.toLowerCase()} and cannot be cancelled.` });
  }
  const acting = await actingContext(ctx, job.workspaceId, input.reason);
  return withTx(prisma, async (tx) => {
    const now = acting.clock.now();
    const status = await requestCancel(tx, acting.clock, job.id);
    if (status !== 'CANCELLED' && status !== 'RUNNING') throw new ConflictError({ code: 'JOB_NOT_CANCELLABLE', userMessage: 'This job finished meanwhile.' });
    let attemptsCancelled = 0;
    if (status === 'CANCELLED' && OUTBOUND_JOB_TYPES.has(job.type)) {
      const queued = await tx.dispatchAttempt.findMany({ where: { jobId: job.id, state: 'QUEUED' }, select: { id: true, messageId: true } });
      if (queued.length > 0) {
        attemptsCancelled = (await tx.dispatchAttempt.updateMany({ where: { id: { in: queued.map((a) => a.id) }, state: 'QUEUED' }, data: { state: 'CANCELLED', reasonCode: OPERATOR_CANCELLED, updatedAt: now } })).count;
        await projectUnsentMany(tx, queued.map((a) => a.messageId), 'NOT_SENT');
      }
    }
    await recordAudit(tx, acting, {
      action: 'job.cancel',
      targetType: 'Job',
      targetId: job.id,
      crossWorkspace: true,
      reason: input.reason,
      workspaceId: job.workspaceId,
      summary: { type: job.type, from: job.status, to: status === 'CANCELLED' ? 'CANCELLED' : 'CANCEL_REQUESTED', attemptsCancelled },
    });
    return { status, cancelRequested: status === 'RUNNING', attemptsCancelled };
  });
}

/** Attempt N+1 for the message on a new dispatch job (inside the caller's transaction). */
async function requeueDispatch(tx: Tx, ctx: AppCtx, source: DispatchAttempt, sourceJobId: string): Promise<{ jobId: string; attemptId: string }> {
  const message = await tx.message.findFirstOrThrow({ where: { id: source.messageId, workspaceId: source.workspaceId }, select: { id: true, conversationId: true } });
  const latest = await tx.dispatchAttempt.findFirst({ where: { messageId: message.id }, orderBy: { attemptNo: 'desc' }, select: { attemptNo: true } });
  const attemptNo = (latest?.attemptNo ?? 0) + 1;
  const now = ctx.clock.now();
  const { job, created } = await enqueueJob(tx as unknown as JobStore, ctx.clock, {
    type: dispatchJobType(source.channel),
    payload: { messageId: message.id },
    payloadVersion: DISPATCH_PAYLOAD_VERSION,
    workspaceId: source.workspaceId,
    idempotencyKey: idempotencyKey('dispatch', 'operator-retry', source.id),
    correlationId: ctx.correlationId,
    causationId: sourceJobId,
    serialKey: message.conversationId,
    kind: 'send',
  });
  if (!created) throw new ConflictError({ code: 'RETRY_ALREADY_QUEUED', userMessage: 'A resend for this attempt is already queued.' });
  const attempt = await tx.dispatchAttempt.create({
    data: {
      workspaceId: source.workspaceId,
      messageId: message.id,
      quoteVersionId: source.quoteVersionId,
      approvalId: source.approvalId,
      channel: source.channel,
      attemptNo,
      state: 'QUEUED',
      // E4: intent and initiator are copied, never re-decided by the operator's retry.
      sendIntent: source.sendIntent,
      initiatedBy: source.initiatedBy,
      idempotencyKey: attemptKey(message.id, attemptNo),
      jobId: job.id,
      createdAt: now,
      updatedAt: now,
    },
    select: { id: true },
  });
  await tx.message.updateMany({ where: { id: message.id, workspaceId: source.workspaceId, statusRank: { lt: STATUS_RANK.SENT } }, data: { status: 'PENDING' } });
  return { jobId: job.id, attemptId: attempt.id };
}

export type RetryResult = { jobId: string; mode: 'requeued' | 'new-attempt'; requeued: { jobId: string; attemptId: string } | null };

export async function retryJob(ctx: AppCtx, input: { jobId: string; reason: string }): Promise<RetryResult> {
  const prisma = prismaOf(ctx);
  const job = await loadJob(prisma, input.jobId);
  const check = retryCheck(job, await messageAttempts(prisma, job));
  if (!check.allowed || check.mode === null) throw new ConflictError({ code: check.code ?? 'RETRY_NOT_ALLOWED', userMessage: check.reason });
  const acting = await actingContext(ctx, job.workspaceId, input.reason);
  return withTx(prisma, async (tx) => {
    const now = acting.clock.now();
    const fresh = await tx.job.findUniqueOrThrow({ where: { id: job.id } });
    const recheck = retryCheck(fresh, await messageAttempts(tx, fresh));
    if (!recheck.allowed || recheck.mode !== check.mode) throw new ConflictError({ code: recheck.code ?? 'RETRY_NOT_ALLOWED', userMessage: recheck.reason });
    let requeued: RetryResult['requeued'] = null;
    if (check.mode === 'requeued') {
      const moved = await tx.job.updateMany({
        where: { id: job.id, status: 'DEAD' },
        data: { status: 'QUEUED', attempts: 0, runAt: now, deadReason: null, finishedAt: null, claimToken: null, leaseUntil: null, cancelRequestedAt: null, updatedAt: now },
      });
      if (moved.count !== 1) throw new ConflictError({ code: 'JOB_NOT_DEAD', userMessage: 'This job changed meanwhile.' });
    } else {
      const attempts = await messageAttempts(tx, fresh);
      requeued = await requeueDispatch(tx, acting, attempts.at(-1)!, job.id);
    }
    await recordAudit(tx, acting, {
      action: 'job.retry',
      targetType: 'Job',
      targetId: job.id,
      crossWorkspace: true,
      reason: input.reason,
      workspaceId: job.workspaceId,
      summary: { type: job.type, mode: check.mode, deadReason: job.deadReason, newJobId: requeued?.jobId ?? null, newAttemptId: requeued?.attemptId ?? null },
    });
    return { jobId: job.id, mode: check.mode!, requeued };
  });
}

export type ResolveInput = {
  jobId: string;
  attemptId: string;
  resolution: 'DELIVERED' | 'NOT_DELIVERED';
  requeue: boolean;
  reason: string;
  confirmText?: string;
};

export type ResolveResult = { attemptId: string; state: 'SENT' | 'FAILED'; requeued: { jobId: string; attemptId: string } | null };

async function advanceLeadAfterOperatorSent(tx: Tx, workspaceId: string, messageId: string, quoteVersionId: string | null, now: Date): Promise<void> {
  const message = await tx.message.findFirstOrThrow({ where: { id: messageId, workspaceId }, select: { conversationId: true } });
  const conversation = await tx.conversation.findFirstOrThrow({ where: { id: message.conversationId, workspaceId }, select: { leadId: true } });
  const target = quoteVersionId ? 'QUOTE_SENT' : 'CONTACTED';
  const lower = LEAD_STAGE_ORDER.slice(0, LEAD_STAGE_ORDER.indexOf(target));
  await tx.lead.updateMany({ where: { id: conversation.leadId, workspaceId, salesStage: { in: [...lower] } }, data: { salesStage: target, stageVersion: { increment: 1 } } });
  if (quoteVersionId) {
    const version = await tx.quoteVersion.findFirstOrThrow({ where: { id: quoteVersionId, workspaceId }, select: { quoteId: true, sentAt: true } });
    if (version.sentAt === null) await tx.quoteVersion.updateMany({ where: { id: quoteVersionId, workspaceId }, data: { sentAt: now } });
    // E6: only the attempt's own version, still current and APPROVED, moves the quote.
    await tx.quote.updateMany({ where: { id: version.quoteId, workspaceId, currentVersionId: quoteVersionId, status: 'APPROVED' }, data: { status: nextQuoteStatus('APPROVED', 'SEND'), sentVia: 'DISPATCH', updatedAt: now } });
  }
}

export async function resolveAmbiguousAttempt(ctx: AppCtx, input: ResolveInput): Promise<ResolveResult> {
  const actor = requireRole(ctx, 'SUPER_ADMIN');
  const prisma = baseClientOf(ctx);
  const attempt = await prisma.dispatchAttempt.findFirst({ where: { id: input.attemptId, jobId: input.jobId } });
  if (!attempt) throw new NotFoundError();
  if (attempt.state !== 'AMBIGUOUS') throw new ConflictError({ code: 'ATTEMPT_NOT_AMBIGUOUS', userMessage: `This attempt is ${attempt.state.toLowerCase()}, not delivery unknown.` });
  if (input.requeue && input.resolution !== 'NOT_DELIVERED') {
    throw new DomainRuleError({ code: 'REQUEUE_NEEDS_NOT_DELIVERED', userMessage: 'Only an attempt verified as not delivered can be sent again.' });
  }
  if (input.requeue && input.confirmText !== RESEND_CONFIRM_TEXT) {
    throw new DomainRuleError({ code: 'CONFIRMATION_REQUIRED', userMessage: `Type ${RESEND_CONFIRM_TEXT} to confirm the resend.` });
  }
  const acting = await actingContext(ctx, attempt.workspaceId, input.reason);
  return withTx(prisma, async (tx) => {
    const now = acting.clock.now();
    const state = input.resolution === 'DELIVERED' ? 'SENT' : 'FAILED';
    const moved = await tx.dispatchAttempt.updateMany({
      where: { id: attempt.id, workspaceId: attempt.workspaceId, state: 'AMBIGUOUS' },
      data: {
        state,
        ...(state === 'FAILED' ? { reasonCode: OPERATOR_NOT_DELIVERED } : {}),
        resolvedBy: actor.userId,
        resolvedAt: now,
        resolutionNote: input.reason,
        updatedAt: now,
      },
    });
    if (moved.count !== 1) throw new ConflictError({ code: 'ATTEMPT_NOT_AMBIGUOUS', userMessage: 'This attempt was resolved meanwhile.' });

    let requeued: ResolveResult['requeued'] = null;
    if (state === 'SENT') {
      await tx.message.updateMany({
        where: { id: attempt.messageId, workspaceId: attempt.workspaceId, statusRank: { lt: STATUS_RANK.SENT } },
        data: { status: 'SENT', statusRank: STATUS_RANK.SENT },
      });
      await advanceLeadAfterOperatorSent(tx, attempt.workspaceId, attempt.messageId, attempt.quoteVersionId, now);
    } else if (input.requeue) {
      const resolved = await tx.dispatchAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      requeued = await requeueDispatch(tx, acting, resolved, attempt.jobId);
    } else {
      await projectUnsent(tx, { workspaceId: attempt.workspaceId, messageId: attempt.messageId }, 'FAILED');
    }
    await recordAudit(tx, acting, {
      action: 'dispatch.operator_resolve',
      targetType: 'DispatchAttempt',
      targetId: attempt.id,
      crossWorkspace: true,
      reason: input.reason,
      workspaceId: attempt.workspaceId,
      summary: { resolution: input.resolution, requeue: input.requeue, channel: attempt.channel, attemptNo: attempt.attemptNo, newJobId: requeued?.jobId ?? null, newAttemptId: requeued?.attemptId ?? null },
    });
    return { attemptId: attempt.id, state, requeued };
  });
}

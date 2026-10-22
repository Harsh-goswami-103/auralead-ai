/**
 * Bulk actions (T23; plan §7, §11, AT13, 06-design F19, user decision D4).
 *
 * One bulk action applies one send (a WhatsApp template or an email) to a lead selection:
 *
 *  - `previewBulkAction` is the pre-flight shown in the confirm dialog. It writes nothing and
 *    classifies every selected row as ELIGIBLE, SKIPPED or FAILED, so eligible + skipped + failed
 *    == selected. Eligibility is the shared dispatch eligibility function (`checkDispatchEligibility`)
 *    with sendIntent BULK, the same function the dispatch preflight re-runs at send time. A row the
 *    action cannot apply to at all (lead gone or merged, no contact on the channel, or, in an
 *    operator's run, handed over to the client: HANDED_OVER, ADR-124) is FAILED. A row
 *    whose only reasons are deferrable (pauses, internal cap) is ELIGIBLE and marked `deferred`: its
 *    dispatch waits instead of being dropped.
 *  - `requestBulkRun` (approvals.decide + dispatch.send: confirming a bulk send approves and sends)
 *    stores a BulkRun with the selection and the pre-flight counts and enqueues one `bulk.run` job,
 *    idempotent by the client's `requestKey`.
 *  - `processBulkRun` (the job) works through the selection in fenced, tenant-scoped chunks. Each
 *    row is classified again inside its chunk transaction and, when eligible, queued through
 *    `queueOutboundMessage` (sendIntent BULK, initiatedBy the confirming user, one dispatch per
 *    run and lead), and its result is persisted in the same transaction. A restart resumes after the
 *    last committed chunk; a replayed row is never queued twice (the dispatch dedupe key).
 *  - D4: B2B-attested email (Maps leads) is manual-single only, so bulk email skips it with
 *    ATTESTED_MANUAL_ONLY; Maps leads never carry WhatsApp opt-in (NO_WHATSAPP_OPT_IN). Both come
 *    from the eligibility function; nothing here relaxes it.
 */
import type { BulkRun, Channel, Prisma } from '@/generated/prisma/client';
import { Prisma as PrismaNs } from '@/generated/prisma/client';
import { IdempotencyConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { idempotencyKey } from '@/lib/ids';
import {
  BulkActionInput,
  BulkRunRequest,
  type BulkPreflightDto,
  type BulkPreflightRow,
  type BulkReasonCount,
  type BulkRunDto,
  type BulkRunRowDto,
} from '@/lib/schemas/bulk';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { fenceJob } from '@/server/db/fence';
import { assertSameWorkspace, type ScopedDb, type ScopedTx } from '@/server/db/scoped';
import { withTx } from '@/server/db/tx';
import { enqueueJob, type JobStore } from '@/server/jobs/queue';
import type { JobHandlerContext } from '@/server/jobs/types';
import { recordAudit } from '@/server/services/audit/record';
import { isEmployeeActor } from '@/server/services/leads/handoff-guard';
import { queueOutboundMessage } from '@/server/services/messaging/dispatch';
import { checkDispatchEligibility, REASON_LABELS, type DispatchKind } from '@/server/services/messaging/eligibility';

export const BULK_RUN_JOB = 'bulk.run';
export const BULK_RUN_PAYLOAD_VERSION = 1;
/** Rows per fenced transaction in `bulk.run`. */
export const BULK_RUN_CHUNK = 25;
export const BULK_RUN_LIST_LIMIT = 20;

export type BulkDeps = { contactKeyPepper: string };

/** Row failures that are not eligibility reasons: the action cannot apply to the row at all. */
export const BULK_FAILURE_LABELS = {
  LEAD_NOT_FOUND: 'The lead no longer exists',
  LEAD_MERGED: 'The lead was merged into another lead',
  CONTACT_MISSING: 'No contact for this channel',
  /** ADR-124: an operator's bulk send leaves out leads handed over to the client. */
  HANDED_OVER: 'Handed over to the client',
} as const;

export function bulkReasonLabel(code: string): string {
  return (REASON_LABELS as Record<string, string>)[code] ?? (BULK_FAILURE_LABELS as Record<string, string>)[code] ?? code;
}

type Params = { action: 'SEND_WHATSAPP_TEMPLATE'; templateId: string; variables: Record<string, string> } | { action: 'SEND_EMAIL'; subject: string; body: string };

type Classified = { leadId: string; leadName: string | null; outcome: 'ELIGIBLE' | 'SKIPPED' | 'FAILED'; reasons: string[]; deferred: boolean };

type StoredRow = { leadId: string; outcome: 'QUEUED' | 'SKIPPED' | 'FAILED'; reasons: string[]; deferred: boolean; messageId: string | null; attemptId: string | null };

type ReadDb = ScopedDb | ScopedTx;

function paramsOf(input: BulkActionInput): Params {
  return input.action === 'SEND_WHATSAPP_TEMPLATE'
    ? { action: input.action, templateId: input.templateId, variables: input.variables }
    : { action: input.action, subject: input.subject, body: input.body };
}

function channelOf(params: Params): { channel: Channel; kind: DispatchKind } {
  return params.action === 'SEND_WHATSAPP_TEMPLATE' ? { channel: 'WHATSAPP', kind: 'WA_TEMPLATE' } : { channel: 'EMAIL', kind: 'EMAIL' };
}

function parseInput<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } } }, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const message = parsed.error.issues[0]?.message ?? 'The bulk action is incomplete.';
  throw new ValidationError({ code: 'BULK_INPUT_INVALID', message, userMessage: message });
}

/**
 * Classifies each lead, in selection order, for the action (read only). `byEmployee`: the run is an
 * operator's, so a lead handed over to the client is a FAILED row (ADR-124; not an eligibility reason).
 */
async function classifyRows(db: ReadDb, ctx: AppCtx, leadIds: readonly string[], params: Params, deps: BulkDeps, byEmployee: boolean): Promise<Classified[]> {
  const leads = await db.lead.findMany({
    where: { id: { in: [...leadIds] } },
    select: { id: true, displayName: true, phoneE164: true, emailNormalized: true, mergedIntoLeadId: true, handedOverAt: true },
  });
  const byId = new Map(leads.map((l) => [l.id, l]));
  const { channel, kind } = channelOf(params);
  const out: Classified[] = [];
  for (const leadId of leadIds) {
    const lead = byId.get(leadId);
    const failed = (code: keyof typeof BULK_FAILURE_LABELS): Classified => ({ leadId, leadName: lead?.displayName ?? null, outcome: 'FAILED', reasons: [code], deferred: false });
    if (!lead) {
      out.push(failed('LEAD_NOT_FOUND'));
      continue;
    }
    if (lead.mergedIntoLeadId !== null) {
      out.push(failed('LEAD_MERGED'));
      continue;
    }
    if (byEmployee && lead.handedOverAt !== null) {
      out.push(failed('HANDED_OVER'));
      continue;
    }
    if ((channel === 'WHATSAPP' ? lead.phoneE164 : lead.emailNormalized) === null) {
      out.push(failed('CONTACT_MISSING'));
      continue;
    }
    const result = await checkDispatchEligibility(
      db,
      ctx,
      { leadId, channel, kind, sendIntent: 'BULK', templateId: params.action === 'SEND_WHATSAPP_TEMPLATE' ? params.templateId : null },
      { contactKeyPepper: deps.contactKeyPepper },
    );
    if (result.eligible) out.push({ leadId, leadName: lead.displayName, outcome: 'ELIGIBLE', reasons: [], deferred: false });
    else if (result.deferrable) out.push({ leadId, leadName: lead.displayName, outcome: 'ELIGIBLE', reasons: result.reasons, deferred: true });
    else out.push({ leadId, leadName: lead.displayName, outcome: 'SKIPPED', reasons: result.reasons, deferred: false });
  }
  return out;
}

function reasonCounts(rows: ReadonlyArray<{ outcome: string; reasons: readonly string[] }>): BulkReasonCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.outcome !== 'SKIPPED' && row.outcome !== 'FAILED') continue;
    for (const code of row.reasons) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()].map(([code, count]) => ({ code, label: bulkReasonLabel(code), count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

function preflightCounts(rows: readonly Classified[]) {
  return {
    eligible: rows.filter((r) => r.outcome === 'ELIGIBLE').length,
    skipped: rows.filter((r) => r.outcome === 'SKIPPED').length,
    failed: rows.filter((r) => r.outcome === 'FAILED').length,
  };
}

/** The pre-flight for a bulk action: one classification per selected row, no writes. */
export async function previewBulkAction(ctx: AppCtx, input: BulkActionInput, deps: BulkDeps): Promise<BulkPreflightDto> {
  requireCapability(ctx, 'dispatch.send');
  const parsed = parseInput<BulkActionInput>(BulkActionInput, input);
  const params = paramsOf(parsed);
  await assertSameWorkspace(ctx.db, ctx, { leadId: parsed.leadIds, templateId: params.action === 'SEND_WHATSAPP_TEMPLATE' ? params.templateId : null });
  const rows = await classifyRows(ctx.db, ctx, parsed.leadIds, params, deps, await isEmployeeActor(ctx.db, ctx));
  const counts = preflightCounts(rows);
  return {
    selected: rows.length,
    ...counts,
    rows: rows.map((r): BulkPreflightRow => ({ leadId: r.leadId, leadName: r.leadName, outcome: r.outcome, reasons: r.reasons, deferred: r.deferred })),
    byReason: reasonCounts(rows),
  };
}

function storedRows(value: Prisma.JsonValue): StoredRow[] {
  return Array.isArray(value) ? (value as unknown as StoredRow[]) : [];
}

function stringList(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function sameRequest(run: BulkRun, leadIds: readonly string[], params: Params): boolean {
  return JSON.stringify(stringList(run.leadIds)) === JSON.stringify(leadIds) && JSON.stringify(run.params) === JSON.stringify(params);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof PrismaNs.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Confirms a bulk action: stores the run (selection, action, pre-flight counts) and enqueues its
 * `bulk.run` job. A repeated `requestKey` returns the existing run; the same key with a different
 * selection or action is 409.
 */
export async function requestBulkRun(ctx: AppCtx, input: BulkRunRequest, deps: BulkDeps): Promise<BulkRunDto> {
  requireCapability(ctx, 'approvals.decide');
  requireCapability(ctx, 'dispatch.send');
  const workspaceId = requireWorkspace(ctx);
  const parsed = parseInput<BulkRunRequest>(BulkRunRequest, input);
  const params = paramsOf(parsed);
  const replay = async (): Promise<BulkRunDto | null> => {
    const existing = await ctx.db.bulkRun.findFirst({ where: { requestKey: parsed.requestKey } });
    if (!existing) return null;
    if (!sameRequest(existing, parsed.leadIds, params)) {
      throw new IdempotencyConflictError({ safeDetails: { requestKey: parsed.requestKey }, userMessage: 'This bulk request was already sent with a different selection. Reload and try again.' });
    }
    return serializeRun(ctx, existing);
  };
  const earlier = await replay();
  if (earlier) return earlier;

  await assertSameWorkspace(ctx.db, ctx, { leadId: parsed.leadIds, templateId: params.action === 'SEND_WHATSAPP_TEMPLATE' ? params.templateId : null });
  const rows = await classifyRows(ctx.db, ctx, parsed.leadIds, params, deps, await isEmployeeActor(ctx.db, ctx));
  const preflight = preflightCounts(rows);
  const requestedBy = ctx.actor?.userId ?? `system:${ctx.kind}`;
  try {
    const run = await withTx(ctx.db, async (tx) => {
      const now = ctx.clock.now();
      const created = await tx.bulkRun.create({
        data: {
          workspaceId,
          action: params.action,
          requestKey: parsed.requestKey,
          params,
          leadIds: parsed.leadIds,
          selectedCount: parsed.leadIds.length,
          results: [],
          preflight,
          requestedBy,
          correlationId: ctx.correlationId,
          createdAt: now,
        },
      });
      const { job } = await enqueueJob(tx as unknown as JobStore, ctx.clock, {
        type: BULK_RUN_JOB,
        payload: { bulkRunId: created.id },
        payloadVersion: BULK_RUN_PAYLOAD_VERSION,
        workspaceId,
        idempotencyKey: idempotencyKey(BULK_RUN_JOB, created.id),
        correlationId: ctx.correlationId,
        causationId: ctx.causationId ?? null,
        kind: 'default',
      });
      const withJob = await tx.bulkRun.update({ where: { id: created.id }, data: { jobId: job.id } });
      await recordAudit(tx, ctx, {
        action: 'bulk.run.request',
        targetType: 'BulkRun',
        targetId: created.id,
        simulated: ctx.mode === 'demo',
        summary: { action: params.action, channel: channelOf(params).channel, selected: parsed.leadIds.length, ...preflight, jobId: job.id },
      });
      return withJob;
    });
    return serializeRun(ctx, run);
  } catch (error) {
    // A concurrent request with the same key committed first: answer with its run.
    if (isUniqueViolation(error)) {
      const raced = await replay();
      if (raced) return raced;
    }
    throw error;
  }
}

async function serializeRun(ctx: AppCtx, run: BulkRun): Promise<BulkRunDto> {
  const leadIds = stringList(run.leadIds);
  const names = new Map(
    (await ctx.db.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, displayName: true } })).map((l) => [l.id, l.displayName]),
  );
  const stored = storedRows(run.results);
  const rows = stored.map(
    (r): BulkRunRowDto => ({
      leadId: r.leadId,
      leadName: names.get(r.leadId) ?? null,
      outcome: r.outcome,
      reasons: r.reasons.map((code) => ({ code, label: bulkReasonLabel(code) })),
      deferred: r.deferred,
      messageId: r.messageId,
    }),
  );
  const preflight = run.preflight as { eligible?: number; skipped?: number; failed?: number } | null;
  return {
    id: run.id,
    action: run.action,
    status: run.status,
    selected: run.selectedCount,
    queued: run.queuedCount,
    skipped: run.skippedCount,
    failed: run.failedCount,
    preflight: { eligible: preflight?.eligible ?? 0, skipped: preflight?.skipped ?? 0, failed: preflight?.failed ?? 0 },
    rows,
    byReason: reasonCounts(stored),
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

/** One run with every persisted row result (the result drawer; survives reloads). */
export async function getBulkRun(ctx: AppCtx, runId: string): Promise<BulkRunDto> {
  requireCapability(ctx, 'leads.read');
  const run = await ctx.db.bulkRun.findFirst({ where: { id: runId } });
  if (!run) throw new NotFoundError();
  return serializeRun(ctx, run);
}

export type BulkRunSummaryDto = Omit<BulkRunDto, 'rows' | 'byReason'>;

/** The workspace's most recent runs, newest first (counts only). */
export async function listBulkRuns(ctx: AppCtx): Promise<BulkRunSummaryDto[]> {
  requireCapability(ctx, 'leads.read');
  const runs = await ctx.db.bulkRun.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: BULK_RUN_LIST_LIMIT });
  return runs.map((run) => {
    const preflight = run.preflight as { eligible?: number; skipped?: number; failed?: number } | null;
    return {
      id: run.id,
      action: run.action,
      status: run.status,
      selected: run.selectedCount,
      queued: run.queuedCount,
      skipped: run.skippedCount,
      failed: run.failedCount,
      preflight: { eligible: preflight?.eligible ?? 0, skipped: preflight?.skipped ?? 0, failed: preflight?.failed ?? 0 },
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
    };
  });
}

/** A tenant-scoped transaction whose first statement (after the write lock) is the claimToken fence (E5). */
function scopedFencedTx<R>(job: JobHandlerContext, ctx: AppCtx, fn: (tx: ScopedTx) => Promise<R>): Promise<R> {
  return withTx(ctx.db, async (tx: ScopedTx) => {
    await fenceJob(tx as never, job.job.id, job.job.claimToken, job.clock.now());
    return fn(tx);
  });
}

export type BulkRunOutcome = 'completed' | 'missing';

/**
 * The `bulk.run` job body: chunks of `BULK_RUN_CHUNK` rows, each classified and queued in one
 * fenced, tenant-scoped transaction that also persists the rows' results and the counts.
 */
export async function processBulkRun(job: JobHandlerContext, ctx: AppCtx, runId: string, deps: BulkDeps): Promise<BulkRunOutcome> {
  for (;;) {
    const step = await scopedFencedTx(job, ctx, async (tx): Promise<'more' | BulkRunOutcome> => {
      const run = await tx.bulkRun.findFirst({ where: { id: runId } });
      if (!run) return 'missing';
      if (run.status === 'COMPLETED') return 'completed';
      const now = ctx.clock.now();
      const results = storedRows(run.results);
      const done = new Set(results.map((r) => r.leadId));
      const chunk = stringList(run.leadIds).filter((id) => !done.has(id)).slice(0, BULK_RUN_CHUNK);

      if (chunk.length === 0) {
        await tx.bulkRun.update({ where: { id: run.id }, data: { status: 'COMPLETED', completedAt: now, ...(run.startedAt ? {} : { startedAt: now }) } });
        await recordAudit(tx, ctx, {
          action: 'bulk.run.complete',
          targetType: 'BulkRun',
          targetId: run.id,
          simulated: ctx.mode === 'demo',
          summary: { action: run.action, selected: run.selectedCount, queued: run.queuedCount, skipped: run.skippedCount, failed: run.failedCount },
        });
        return 'completed';
      }

      const params = run.params as unknown as Params;
      const { channel } = channelOf(params);
      // The job has no actor: the person who confirmed the run decides whether the handoff guard applies.
      const classified = await classifyRows(tx, ctx, chunk, params, deps, await isEmployeeActor(tx, ctx, run.requestedBy));
      const added: StoredRow[] = [];
      for (const row of classified) {
        if (row.outcome !== 'ELIGIBLE') {
          added.push({ leadId: row.leadId, outcome: row.outcome, reasons: row.reasons, deferred: false, messageId: null, attemptId: null });
          continue;
        }
        const content =
          params.action === 'SEND_WHATSAPP_TEMPLATE'
            ? { kind: 'TEMPLATE' as const, templateId: params.templateId, variables: params.variables }
            : { kind: 'EMAIL' as const, subject: params.subject, body: params.body };
        const queued = await queueOutboundMessage(
          tx,
          ctx,
          { ...content, leadId: row.leadId, channel, sendIntent: 'BULK', initiatedBy: run.requestedBy, dedupeKey: `bulk:${run.id}:${row.leadId}` },
          { contactKeyPepper: deps.contactKeyPepper },
        );
        added.push({ leadId: row.leadId, outcome: 'QUEUED', reasons: row.reasons, deferred: row.deferred, messageId: queued.messageId, attemptId: queued.attemptId });
      }
      const count = (outcome: StoredRow['outcome']) => added.filter((r) => r.outcome === outcome).length;
      await tx.bulkRun.update({
        where: { id: run.id },
        data: {
          status: 'RUNNING',
          ...(run.startedAt ? {} : { startedAt: now }),
          results: [...results, ...added] as unknown as Prisma.InputJsonValue,
          queuedCount: run.queuedCount + count('QUEUED'),
          skippedCount: run.skippedCount + count('SKIPPED'),
          failedCount: run.failedCount + count('FAILED'),
        },
      });
      return 'more';
    });
    if (step !== 'more') return step;
  }
}


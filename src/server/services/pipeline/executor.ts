/**
 * The single pipeline orchestrator (E9, ADR-43, O5).
 *
 * Ingestion creates a PipelineExecution pinned to the workspace's active PipelineConfigVersion and
 * enqueues one `pipeline.advance` job for the first stage. Each `pipeline.advance` job runs exactly
 * one stage of that pinned graph through the stage-handler registry (`./stages`):
 *
 * 1. Validate the payload `{ executionId, stage }` and load the execution in the job's workspace.
 * 2. Order the graph's stages (edges, then list order) and check every earlier stage is DONE or
 *    SKIPPED. A FAILED earlier stage means the pipeline stopped: the job settles with no effect.
 * 3. If this stage's PipelineStageRun is already DONE, SKIPPED or FAILED, it is a replay: nothing
 *    runs again (the next stage's job already exists; enqueue is idempotent by key).
 * 4. No registered handler: the run is recorded PENDING with `STAGE_HANDLER_MISSING` and audited,
 *    and the execution waits there. It is never silently skipped.
 * 5. Otherwise the run is marked RUNNING (fenced, committed), the handler runs outside any
 *    transaction, and the outcome settles in the job's fenced settle transaction together with the
 *    handler's own writes, `Execution.currentStage`, the audit row and the next stage's job
 *    (idempotency key `pipeline.advance:<executionId>:<stage>`).
 *
 * PipelineStageRun is UNIQUE (executionId, stage), and the settle only applies while the run is
 * still RUNNING, so a replayed or restarted job never commits a stage twice. A worker that dies
 * mid-stage leaves the run RUNNING with nothing else committed; the reclaimed job runs it again.
 */
import { z } from 'zod';
import type { PipelineStage, Prisma } from '@/generated/prisma/client';
import { PipelineStage as PIPELINE_STAGES } from '@/lib/domain/enums';
import { AppError } from '@/lib/errors';
import { idempotencyKey } from '@/lib/ids';
import { getJobContext } from '@/server/auth/context';
import { enqueueJob, type JobStore } from '@/server/jobs/queue';
import type { JobHandlerContext, JobResult, TxClient } from '@/server/jobs/types';
import type { Clock } from '@/lib/clock';
import { recordAudit } from '@/server/services/audit/record';
import type { StageRegistry } from './stages';
import type { StageOutcome } from './stages/types';

export const PIPELINE_ADVANCE_JOB = 'pipeline.advance';
export const PIPELINE_ADVANCE_PAYLOAD_VERSION = 1;

export const pipelineAdvancePayloadSchema = z.object({
  executionId: z.string().min(1).max(64),
  stage: z.enum(PIPELINE_STAGES),
});
export type PipelineAdvancePayload = z.infer<typeof pipelineAdvancePayloadSchema>;

export function pipelineAdvanceKey(executionId: string, stage: PipelineStage): string {
  return idempotencyKey(PIPELINE_ADVANCE_JOB, executionId, stage);
}

/** Enqueues the job for one stage of one execution. Idempotent: one job per (execution, stage). */
export async function enqueuePipelineAdvance(
  db: JobStore,
  clock: Clock,
  input: { workspaceId: string; executionId: string; stage: PipelineStage; correlationId: string; causationId?: string | null },
) {
  return enqueueJob(db, clock, {
    type: PIPELINE_ADVANCE_JOB,
    payload: { executionId: input.executionId, stage: input.stage },
    payloadVersion: PIPELINE_ADVANCE_PAYLOAD_VERSION,
    workspaceId: input.workspaceId,
    idempotencyKey: pipelineAdvanceKey(input.executionId, input.stage),
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    kind: 'default',
  });
}

// ---- graph -------------------------------------------------------------------------------------

const graphSchema = z.object({
  stages: z.array(z.object({ id: z.string().min(1), kind: z.enum(PIPELINE_STAGES), label: z.string().optional() })).min(1),
  edges: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).default([]),
});

/**
 * The stage kinds of a pinned graph in execution order (topological over the edges, ties broken by
 * list order). Null when the graph is malformed: unknown kind, duplicate id or kind, an edge to an
 * unknown stage, or a cycle. Full graph validation (mandatory approval node, P11) is T23's.
 */
export function stageOrder(graph: unknown): PipelineStage[] | null {
  const parsed = graphSchema.safeParse(graph);
  if (!parsed.success) return null;
  const { stages, edges } = parsed.data;
  const ids = new Map(stages.map((s, i) => [s.id, i]));
  if (ids.size !== stages.length || new Set(stages.map((s) => s.kind)).size !== stages.length) return null;
  const indegree = stages.map(() => 0);
  const out = stages.map(() => [] as number[]);
  for (const e of edges) {
    const from = ids.get(e.from);
    const to = ids.get(e.to);
    if (from === undefined || to === undefined) return null;
    out[from]!.push(to);
    indegree[to]! += 1;
  }
  const order: PipelineStage[] = [];
  const ready = stages.map((_, i) => i).filter((i) => indegree[i] === 0);
  while (ready.length > 0) {
    ready.sort((a, b) => a - b);
    const i = ready.shift()!;
    order.push(stages[i]!.kind);
    for (const j of out[i]!) {
      indegree[j]! -= 1;
      if (indegree[j] === 0) ready.push(j);
    }
  }
  return order.length === stages.length ? order : null;
}

// ---- executor ----------------------------------------------------------------------------------

export type ExecutorDeps = { stages: StageRegistry; mode: 'demo' | 'live' };

const TERMINAL = new Set(['DONE', 'SKIPPED', 'FAILED']);

function dead(reason: string, error: string): JobResult {
  return { outcome: 'dead', reason, errorCode: reason, error };
}

function isLeaseLost(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'LEASE_LOST';
}

function isRetryable(error: unknown): boolean {
  if (error instanceof AppError) return error.retryable;
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'DB_BUSY';
}

export async function advancePipeline(job: JobHandlerContext, deps: ExecutorDeps): Promise<JobResult> {
  const payload = pipelineAdvancePayloadSchema.safeParse(job.job.payload);
  if (!payload.success) return dead('INVALID_PAYLOAD', 'pipeline.advance payload is not { executionId, stage }');
  const { executionId, stage } = payload.data;
  const workspaceId = job.job.workspaceId;
  if (workspaceId === null) return dead('INVALID_PAYLOAD', 'pipeline.advance needs a workspace job');

  const execution = await job.db.pipelineExecution.findFirst({
    where: { id: executionId, workspaceId },
    include: { pipelineConfigVersion: true, lead: true, stageRuns: true },
  });
  if (!execution) return dead('EXECUTION_NOT_FOUND', `no pipeline execution ${executionId} in the job's workspace`);

  const order = stageOrder(execution.pipelineConfigVersion.graph);
  if (order === null) return dead('PIPELINE_GRAPH_INVALID', `pipeline config version ${execution.pipelineConfigVersionId} has an invalid graph`);
  const index = order.indexOf(stage);
  if (index < 0) return dead('STAGE_NOT_IN_PIPELINE', `stage ${stage} is not in the pinned pipeline`);

  const runs = new Map(execution.stageRuns.map((r) => [r.stage, r]));
  for (const earlier of order.slice(0, index)) {
    const run = runs.get(earlier);
    if (run?.status === 'FAILED') return { outcome: 'succeeded' };
    if (run?.status !== 'DONE' && run?.status !== 'SKIPPED') return dead('STAGE_OUT_OF_ORDER', `stage ${stage} ran before ${earlier} finished`);
  }

  const ctx = getJobContext({ id: job.job.id, workspaceId, correlationId: job.correlationId }, { prisma: job.db, mode: deps.mode, clock: job.clock });
  const next = order[index + 1] ?? null;
  const existing = runs.get(stage);
  const enqueueNext = async (tx: TxClient) => {
    if (next === null) return;
    await enqueuePipelineAdvance(tx, job.clock, { workspaceId, executionId, stage: next, correlationId: job.correlationId, causationId: job.job.id });
  };

  // Replay of a finished stage: no rerun. Re-asserting the next job is idempotent.
  if (existing && TERMINAL.has(existing.status)) {
    return { outcome: 'succeeded', finalTx: existing.status === 'FAILED' ? undefined : enqueueNext };
  }

  const audit = (tx: TxClient, action: string, summary: Record<string, unknown>) =>
    recordAudit(tx, ctx, { action, targetType: 'PipelineExecution', targetId: executionId, simulated: execution.lead.simulated, summary: { stage, leadId: execution.leadId, jobId: job.job.id, ...summary } });

  const handler = deps.stages.get(stage);
  if (!handler) {
    return {
      outcome: 'succeeded',
      finalTx: async (tx) => {
        const now = job.clock.now();
        await tx.pipelineStageRun.upsert({
          where: { executionId_stage: { executionId, stage } },
          create: { workspaceId, executionId, stage, status: 'PENDING', reasonCode: 'STAGE_HANDLER_MISSING', jobId: job.job.id, startedAt: now },
          update: { status: 'PENDING', reasonCode: 'STAGE_HANDLER_MISSING', jobId: job.job.id },
        });
        await tx.pipelineExecution.update({ where: { id: executionId }, data: { currentStage: stage, updatedAt: now } });
        await audit(tx, 'pipeline.stage.waiting', { reasonCode: 'STAGE_HANDLER_MISSING' });
      },
    };
  }

  const runId = await job.fencedTx(async (tx) => {
    const now = job.clock.now();
    const run = await tx.pipelineStageRun.upsert({
      where: { executionId_stage: { executionId, stage } },
      create: { workspaceId, executionId, stage, status: 'RUNNING', jobId: job.job.id, startedAt: now },
      update: { status: 'RUNNING', jobId: job.job.id, startedAt: now, reasonCode: null },
      select: { id: true },
    });
    await tx.pipelineExecution.update({ where: { id: executionId }, data: { currentStage: stage, updatedAt: now } });
    return run.id;
  });

  const markFailed = (reasonCode: string, outputRef?: Prisma.InputJsonValue) => async (tx: TxClient) => {
    const now = job.clock.now();
    const updated = await tx.pipelineStageRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: { status: 'FAILED', reasonCode, finishedAt: now, ...(outputRef === undefined ? {} : { outputRef }) },
    });
    if (updated.count !== 1) return;
    await audit(tx, 'pipeline.stage.failed', { reasonCode });
  };

  let outcome: StageOutcome;
  try {
    outcome = await handler.run({
      ctx,
      job,
      stage,
      execution: { id: executionId, workspaceId, leadId: execution.leadId, pipelineConfigVersionId: execution.pipelineConfigVersionId },
      lead: execution.lead,
      config: { id: execution.pipelineConfigVersion.id, version: execution.pipelineConfigVersion.version, approvalMode: execution.pipelineConfigVersion.approvalMode },
    });
  } catch (error) {
    if (isLeaseLost(error)) throw error;
    const retryable = isRetryable(error);
    if (retryable && job.job.attempts < job.job.maxAttempts) throw error;
    const reasonCode = retryable ? 'STAGE_RETRIES_EXHAUSTED' : 'STAGE_ERROR';
    const code = error instanceof AppError ? error.code : reasonCode;
    return {
      outcome: 'dead',
      reason: reasonCode,
      errorCode: code,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      finalTx: markFailed(reasonCode),
    };
  }

  if (outcome.status === 'FAILED') return { outcome: 'succeeded', finalTx: markFailed(outcome.reasonCode, outcome.outputRef) };

  return {
    outcome: 'succeeded',
    finalTx: async (tx) => {
      const now = job.clock.now();
      const reasonCode = outcome.status === 'SKIPPED' ? outcome.reasonCode : null;
      const outputRef = outcome.outputRef;
      const updated = await tx.pipelineStageRun.updateMany({
        where: { id: runId, status: 'RUNNING' },
        data: { status: outcome.status, reasonCode, finishedAt: now, ...(outputRef === undefined ? {} : { outputRef }) },
      });
      if (updated.count !== 1) return;
      if (outcome.finalTx) await outcome.finalTx(tx);
      await tx.pipelineExecution.update({ where: { id: executionId }, data: { currentStage: next ?? stage, updatedAt: now } });
      await enqueueNext(tx);
      await audit(tx, outcome.status === 'DONE' ? 'pipeline.stage.done' : 'pipeline.stage.skipped', { reasonCode, next });
    },
  };
}

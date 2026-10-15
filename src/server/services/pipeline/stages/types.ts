/**
 * Pipeline stage-handler contract (E9, ADR-43). The executor (`../executor.ts`) owns ordering,
 * PipelineStageRun bookkeeping, idempotency and enqueueing of the next stage; a stage handler
 * only decides its own outcome.
 *
 * Rules for handlers:
 * - `run` may read through `ctx.db` (tenant-scoped) and may call adapters (network), but must not
 *   write. Every write goes in the returned `finalTx`, which the executor runs inside the job's
 *   fenced settle transaction together with the StageRun update and the next-stage enqueue. A
 *   crash before settle therefore leaves no partial effect and the stage simply runs again.
 * - `finalTx` receives the raw transaction client (unscoped): always write `workspaceId`
 *   explicitly (`execution.workspaceId`) and never touch another workspace.
 * - Throw an AppError with `retryable` for a transient failure (the job retries with backoff);
 *   return FAILED for a definite domain failure (the pipeline stops at this stage, visibly). Any
 *   other thrown error marks the stage FAILED (STAGE_ERROR) and the job DEAD.
 */
import type { Lead, PipelineStage, Prisma } from '@/generated/prisma/client';
import type { AppCtx } from '@/server/auth/context';
import type { JobHandlerContext, TxClient } from '@/server/jobs/types';

export type StageExecution = {
  id: string;
  workspaceId: string;
  leadId: string;
  pipelineConfigVersionId: string;
};

export type StageConfig = { id: string; version: number; approvalMode: 'HUMAN' | 'POLICY_AUTO' };

export type StageRunInput = {
  /** Job context scoped to the execution's workspace (kind 'job', all capabilities, actor null). */
  ctx: AppCtx;
  job: JobHandlerContext;
  stage: PipelineStage;
  execution: StageExecution;
  lead: Lead;
  config: StageConfig;
};

export type StageFinalTx = (tx: TxClient) => Promise<void>;

export type StageOutcome =
  | { status: 'DONE'; outputRef?: Prisma.InputJsonValue; finalTx?: StageFinalTx }
  | { status: 'SKIPPED'; reasonCode: string; outputRef?: Prisma.InputJsonValue; finalTx?: StageFinalTx }
  | { status: 'FAILED'; reasonCode: string; outputRef?: Prisma.InputJsonValue };

export type StageHandler = {
  stage: PipelineStage;
  run(input: StageRunInput): Promise<StageOutcome>;
};

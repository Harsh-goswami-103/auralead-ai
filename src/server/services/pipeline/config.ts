/**
 * Pipeline configuration versions (T23; O5, P11, ADR-27, ADR-43).
 *
 * - `getPipelineConfig`: the active PipelineConfigVersion and its history, for the pipeline editor
 *   (T28) and the console.
 * - `savePipelineConfig` (`pipeline.manage`): validates the graph and approval mode
 *   (`validator.ts`; POLICY_AUTO only while workspace auto-send is on) and activates it as version
 *   N+1 in one transaction, with a CAS on the active version the editor saw. Existing versions are
 *   never edited: every lead keeps running the version it was pinned to at ingestion (O5), so
 *   switching HUMAN to POLICY_AUTO never sends approvals already waiting in the queue.
 * - `resumeHaltedStages`: before T23 a pipeline halted visibly at a stage with no registered handler
 *   (PipelineStageRun PENDING, `STAGE_HANDLER_MISSING`, ADR-51) and its `pipeline.advance` job
 *   SUCCEEDED, so the stage's own idempotency key can never run it again. This enqueues one new job
 *   per halted run whose stage now has a handler, under a resume key bound to the run, so repeated
 *   calls add nothing. `npm run pipeline:resume` runs it with the production stage registry.
 */
import type { PipelineApprovalMode, PipelineStage, PrismaClient } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { ConflictError, DomainRuleError } from '@/lib/errors';
import { idempotencyKey } from '@/lib/ids';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { enqueueJob } from '@/server/jobs/queue';
import { recordAudit } from '@/server/services/audit/record';
import { PIPELINE_ADVANCE_JOB, PIPELINE_ADVANCE_PAYLOAD_VERSION } from './executor';
import { validatePipelineConfig } from './validator';

export type PipelineConfigVersionView = {
  id: string;
  version: number;
  approvalMode: PipelineApprovalMode;
  active: boolean;
  graph: unknown;
  createdBy: string;
  createdAt: string;
};

export type PipelineConfigView = {
  active: PipelineConfigVersionView | null;
  versions: PipelineConfigVersionView[];
  /** POLICY_AUTO is selectable only while this is on (P11). */
  autoSendEnabled: boolean;
};

type VersionRow = { id: string; version: number; approvalMode: PipelineApprovalMode; active: boolean; graph: unknown; createdBy: string; createdAt: Date };

function view(row: VersionRow): PipelineConfigVersionView {
  return { id: row.id, version: row.version, approvalMode: row.approvalMode, active: row.active, graph: row.graph, createdBy: row.createdBy, createdAt: row.createdAt.toISOString() };
}

export async function getPipelineConfig(ctx: AppCtx): Promise<PipelineConfigView> {
  requireCapability(ctx, 'leads.read');
  const versions = await ctx.db.pipelineConfigVersion.findMany({ orderBy: { version: 'desc' } });
  const settings = await ctx.db.workspaceSettings.findFirst({ select: { autoSendEnabled: true } });
  const active = versions.find((v) => v.active) ?? null;
  return { active: active ? view(active) : null, versions: versions.map(view), autoSendEnabled: settings?.autoSendEnabled ?? false };
}

export type SavePipelineConfigInput = {
  graph: unknown;
  approvalMode: unknown;
  /** The active version number the editor saw (0 when the workspace had none). */
  expectedVersion: number;
};

/** Validates and activates a new pipeline version (N+1). 422 PIPELINE_INVALID with the issues; 409 on a stale editor. */
export async function savePipelineConfig(ctx: AppCtx, input: SavePipelineConfigInput): Promise<PipelineConfigVersionView> {
  requireCapability(ctx, 'pipeline.manage');
  const workspaceId = requireWorkspace(ctx);
  const actorId = ctx.actor?.userId ?? `system:${ctx.kind}`;
  return withTx(ctx.db, async (tx) => {
    const settings = await tx.workspaceSettings.findFirst({ select: { autoSendEnabled: true } });
    const result = validatePipelineConfig({ graph: input.graph, approvalMode: input.approvalMode }, { autoSendEnabled: settings?.autoSendEnabled ?? false });
    if (!result.ok) {
      throw new DomainRuleError({
        code: 'PIPELINE_INVALID',
        message: `pipeline config rejected: ${result.issues.map((i) => i.code).join(', ')}`,
        userMessage: result.issues[0]?.message ?? 'The pipeline is not valid.',
        safeDetails: { issues: result.issues },
      });
    }
    const active = await tx.pipelineConfigVersion.findFirst({ where: { active: true } });
    const activeVersion = active?.version ?? 0;
    if (activeVersion !== input.expectedVersion) {
      throw new ConflictError({
        code: 'PIPELINE_VERSION_CONFLICT',
        userMessage: 'The pipeline was changed by someone else. Reload to see the current version.',
        safeDetails: { currentVersion: activeVersion, expectedVersion: input.expectedVersion },
      });
    }
    const latest = await tx.pipelineConfigVersion.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
    const now = ctx.clock.now();
    if (active) await tx.pipelineConfigVersion.update({ where: { id: active.id }, data: { active: false } });
    const created = await tx.pipelineConfigVersion.create({
      data: { workspaceId, version: (latest?.version ?? 0) + 1, graph: result.graph, approvalMode: result.approvalMode, active: true, createdBy: actorId, createdAt: now },
    });
    await recordAudit(tx, ctx, {
      action: 'pipeline.config.activate',
      targetType: 'PipelineConfigVersion',
      targetId: created.id,
      summary: { version: created.version, previousVersion: active?.version ?? null, approvalMode: created.approvalMode, previousApprovalMode: active?.approvalMode ?? null, stages: result.order },
    });
    return view(created);
  });
}

export type ResumeHaltedOptions = {
  /** Stage kinds that now have a registered handler. */
  stages: readonly PipelineStage[];
  /** Limit to one workspace; all workspaces when omitted. */
  workspaceId?: string | null;
  correlationId: string;
};

/** Enqueues one `pipeline.advance` per run halted with STAGE_HANDLER_MISSING whose stage now has a handler. */
export async function resumeHaltedStages(db: PrismaClient, clock: Clock, options: ResumeHaltedOptions): Promise<{ resumed: number; jobIds: string[] }> {
  if (options.stages.length === 0) return { resumed: 0, jobIds: [] };
  const halted = await db.pipelineStageRun.findMany({
    where: {
      status: 'PENDING',
      reasonCode: 'STAGE_HANDLER_MISSING',
      stage: { in: [...options.stages] },
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    select: { id: true, workspaceId: true, executionId: true, stage: true },
  });
  const jobIds: string[] = [];
  for (const run of halted) {
    const { job, created } = await enqueueJob(db, clock, {
      type: PIPELINE_ADVANCE_JOB,
      payload: { executionId: run.executionId, stage: run.stage },
      payloadVersion: PIPELINE_ADVANCE_PAYLOAD_VERSION,
      workspaceId: run.workspaceId,
      idempotencyKey: idempotencyKey(PIPELINE_ADVANCE_JOB, run.executionId, run.stage, 'resume', run.id),
      correlationId: options.correlationId,
      kind: 'default',
    });
    if (created) jobIds.push(job.id);
  }
  return { resumed: jobIds.length, jobIds };
}

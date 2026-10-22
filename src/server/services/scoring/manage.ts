/**
 * The scoring configuration tab (T26, P9, R14): read the versions, preview a proposed
 * configuration on sample leads, and activate it as a new version.
 *
 * - Validation is the shared Zod schema (`scoringConfigSchema`): weights are whole points over
 *   the seven inputs and must sum to 100, unknown keys are refused. A bad config answers 400
 *   SCORING_CONFIG_INVALID with its issues before anything is read or written.
 * - Preview scores the SCORING_PREVIEW_SAMPLE newest (unmerged) leads with the proposed config
 *   through the same pure scorer the pipeline uses, next to the score stored on each lead. It
 *   writes nothing: no version, no job, no audit.
 * - Activation is one transaction: a compare-and-set on the active version the editor saw (409
 *   SCORING_VERSION_CONFLICT otherwise), the old version deactivated, version N+1 created active
 *   (the partial unique index allows one active version), the `lead.rescore` job enqueued (key
 *   `lead.rescore:<versionId>`) and the `scoring.config.activate` audit row. Stored versions are
 *   never edited; going back to an older configuration is a new version with its weights.
 * - Who: an operator (EMPLOYEE) with `scoring.manage` edits. The workspace owner reads only (P9),
 *   although an OWNER otherwise holds every capability in their workspace; so does anyone else
 *   with `leads.read`.
 */
import type { Prisma } from '@/generated/prisma/client';
import { ConflictError, PermissionDeniedError, ValidationError } from '@/lib/errors';
import { SCORING_PREVIEW_SAMPLE, type ScoringActivateDto, type ScoringPreviewDto } from '@/lib/schemas/leads';
import { parseScoringConfig, scoringConfigSchema, type ScoringConfig } from '@/lib/schemas/scoring';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { enqueueLeadRescore } from '@/server/jobs/handlers/lead-rescore';
import type { JobStore } from '@/server/jobs/queue';
import { recordAudit } from '@/server/services/audit/record';
import { scoreInputOf } from './record';
import { scoreLead } from './score';

export type ScoringVersionView = {
  id: string;
  version: number;
  active: boolean;
  createdAt: Date;
  createdByName: string | null;
  /** The stored configuration, or null when it no longer parses (shown as invalid, never used). */
  config: ScoringConfig | null;
};

export type ScoringOverview = {
  workspace: { id: string; slug: string; name: string; timezone: string };
  active: ScoringVersionView | null;
  history: ScoringVersionView[];
  /** The viewer may preview and activate (an operator with scoring.manage). */
  canManage: boolean;
  /** Why the viewer cannot, in plain words (for the permission gate), or null. */
  readOnlyReason: string | null;
};

export class ScoringVersionConflictError extends ConflictError {
  static override readonly defaultCode: string = 'SCORING_VERSION_CONFLICT';
  static override readonly defaultUserMessage: string = 'Someone activated another scoring version since you opened this page. Reload to see it.';
}

function readOnlyReason(ctx: AppCtx): string | null {
  if (ctx.actor?.role !== 'EMPLOYEE') return 'Workspace owners can read the scoring configuration; operators assigned with scoring.manage change it.';
  if (!hasCapability(ctx, 'scoring.manage')) return 'Your assignment does not include scoring.manage. A super admin can grant it from the people page.';
  return null;
}

function requireScoringManager(ctx: AppCtx): void {
  requireCapability(ctx, 'scoring.manage');
  const reason = readOnlyReason(ctx);
  if (reason !== null) throw new PermissionDeniedError({ code: 'SCORING_READ_ONLY', userMessage: reason, safeDetails: { capability: 'scoring.manage' } });
}

function parseProposed(config: unknown): ScoringConfig {
  const parsed = scoringConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new ValidationError({
      code: 'SCORING_CONFIG_INVALID',
      message: 'proposed scoring config does not match the schema',
      userMessage: 'The scoring configuration is not valid. Fix the marked fields and try again.',
      safeDetails: { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    });
  }
  return parsed.data;
}

function safeConfig(weights: unknown): ScoringConfig | null {
  try {
    return parseScoringConfig(weights);
  } catch {
    return null;
  }
}

export async function loadScoringOverview(ctx: AppCtx): Promise<ScoringOverview> {
  requireCapability(ctx, 'leads.read');
  const workspaceId = requireWorkspace(ctx);
  const [workspace, rows] = await Promise.all([
    ctx.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { id: true, slug: true, name: true, timezone: true } }),
    ctx.db.scoringConfigVersion.findMany({ orderBy: { version: 'desc' } }),
  ]);
  const creatorIds = [...new Set(rows.map((r) => r.createdBy))];
  const creators = creatorIds.length === 0 ? [] : await ctx.db.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true } });
  const names = new Map(creators.map((u) => [u.id, u.name]));
  const history: ScoringVersionView[] = rows.map((r) => ({
    id: r.id,
    version: r.version,
    active: r.active,
    createdAt: r.createdAt,
    createdByName: names.get(r.createdBy) ?? null,
    config: safeConfig(r.weights),
  }));
  const reason = readOnlyReason(ctx);
  return { workspace, active: history.find((v) => v.active) ?? null, history, canManage: reason === null, readOnlyReason: reason };
}

export async function previewScoringConfig(ctx: AppCtx, input: { config: unknown }): Promise<ScoringPreviewDto> {
  requireScoringManager(ctx);
  requireWorkspace(ctx);
  const config = parseProposed(input.config);
  const leads = await ctx.db.lead.findMany({
    where: { mergedIntoLeadId: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: SCORING_PREVIEW_SAMPLE,
  });
  const ref = { id: 'preview', version: 0, config };
  const rows = leads.map((lead) => {
    const result = scoreLead(scoreInputOf(lead), ref);
    return {
      leadId: lead.id,
      displayName: lead.displayName,
      currentScore: lead.score,
      proposedScore: result.score,
      delta: lead.score === null ? null : result.score - lead.score,
      unknownInputs: result.unknownInputs.length,
    };
  });
  // Compare like with like (ADR-73): both averages over the scored leads; unscored ones apart.
  const scored = rows.filter((r) => r.currentScore !== null);
  const average = (values: number[]) => (values.length === 0 ? null : Math.round(values.reduce((s, v) => s + v, 0) / values.length));
  return {
    sampleSize: rows.length,
    rows,
    changed: scored.filter((r) => r.delta !== null && r.delta !== 0).length,
    unscored: rows.length - scored.length,
    averageCurrent: average(scored.map((r) => r.currentScore as number)),
    averageProposed: average(scored.map((r) => r.proposedScore)),
  };
}

export async function activateScoringConfig(ctx: AppCtx, input: { config: unknown; expectedActiveVersion: number }): Promise<ScoringActivateDto> {
  requireScoringManager(ctx);
  const workspaceId = requireWorkspace(ctx);
  const config = parseProposed(input.config);
  const actorId = ctx.actor!.userId;

  return withTx(ctx.db, async (tx) => {
    const active = await tx.scoringConfigVersion.findFirst({ where: { active: true }, select: { id: true, version: true } });
    const activeVersion = active?.version ?? 0;
    if (activeVersion !== input.expectedActiveVersion) {
      throw new ScoringVersionConflictError({ safeDetails: { activeVersion, expectedActiveVersion: input.expectedActiveVersion } });
    }
    const latest = await tx.scoringConfigVersion.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
    const version = (latest?.version ?? 0) + 1;
    if (active) {
      const off = await tx.scoringConfigVersion.updateMany({ where: { id: active.id, active: true }, data: { active: false } });
      if (off.count !== 1) throw new ScoringVersionConflictError();
    }
    const created = await tx.scoringConfigVersion.create({
      data: { workspaceId, version, weights: config as unknown as Prisma.InputJsonValue, active: true, createdBy: actorId, createdAt: ctx.clock.now() },
      select: { id: true, version: true },
    });
    const { job } = await enqueueLeadRescore(tx as unknown as JobStore, ctx.clock, { workspaceId, scoringConfigVersionId: created.id, correlationId: ctx.correlationId });
    await recordAudit(tx, ctx, {
      action: 'scoring.config.activate',
      targetType: 'ScoringConfigVersion',
      targetId: created.id,
      workspaceId,
      summary: { version, previousVersion: active?.version ?? null, rescoreJobId: job.id, fields: ['weights'] },
    });
    return { versionId: created.id, version, previousVersion: active?.version ?? null, rescoreJobId: job.id };
  });
}

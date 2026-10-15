/**
 * `lead.rescore` (R14, P9, D4): after a ScoringConfigVersion is activated, rescores every lead of
 * the workspace with it, as a job rather than an inline loop. Leads are processed in id order in
 * batches of `batchSize`, one fenced transaction per batch, so a long rescore keeps its lease and
 * a crash resumes safely (scoring is deterministic, so redoing a batch writes the same values).
 *
 * Each batch first re-checks that the version is still the active one. If another version was
 * activated meanwhile, the job stops (`superseded: true`): that version's own rescore job owns
 * the workspace now. Merged leads are skipped. One `scoring.rescore` audit row records the count.
 * The job key is `lead.rescore:<scoringConfigVersionId>`: one rescore per activated version.
 */
import { z } from 'zod';
import type { Lead } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { getConfig } from '@/lib/config';
import { idempotencyKey } from '@/lib/ids';
import { recordAudit } from '@/server/services/audit/record';
import { loadActiveScoringConfig } from '@/server/services/scoring/config';
import { scoreData, scoreInputOf } from '@/server/services/scoring/record';
import { scoreLead } from '@/server/services/scoring/score';
import { enqueueJob, type JobStore } from '../queue';
import type { JobDefinition } from '../types';
import { deadResult, jobCtx, parseWorkspacePayload } from './lead-job-support';

export const LEAD_RESCORE_JOB = 'lead.rescore';

const payloadSchema = z.object({ scoringConfigVersionId: z.string().min(1).max(64) });

export function enqueueLeadRescore(
  db: JobStore,
  clock: Clock,
  input: { workspaceId: string; scoringConfigVersionId: string; correlationId: string; causationId?: string | null },
) {
  return enqueueJob(db, clock, {
    type: LEAD_RESCORE_JOB,
    payload: { scoringConfigVersionId: input.scoringConfigVersionId },
    workspaceId: input.workspaceId,
    idempotencyKey: idempotencyKey(LEAD_RESCORE_JOB, input.scoringConfigVersionId),
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    kind: 'default',
  });
}

export function createLeadRescoreJob(options: { mode?: () => 'demo' | 'live'; batchSize?: number } = {}): JobDefinition {
  const mode = options.mode ?? (() => getConfig().mode);
  const batchSize = options.batchSize ?? 100;
  return {
    type: LEAD_RESCORE_JOB,
    kind: 'default',
    payloadVersions: [1],
    async handler(job) {
      const parsed = parseWorkspacePayload(job, payloadSchema);
      if (!parsed.ok) return parsed.result;
      const { workspaceId, payload } = parsed;
      const version = await job.db.scoringConfigVersion.findFirst({ where: { id: payload.scoringConfigVersionId, workspaceId }, select: { id: true, version: true } });
      if (!version) return deadResult('SCORING_CONFIG_NOT_FOUND', `no scoring config ${payload.scoringConfigVersionId} in the job's workspace`);
      const ctx = jobCtx(job, workspaceId, mode());

      let afterId: string | null = null;
      let rescored = 0;
      let superseded = false;
      for (;;) {
        const active = await loadActiveScoringConfig(job.db, workspaceId);
        if (active === null || active.id !== version.id) {
          superseded = true;
          break;
        }
        const leads: Lead[] = await job.db.lead.findMany({
          where: { workspaceId, mergedIntoLeadId: null, ...(afterId === null ? {} : { id: { gt: afterId } }) },
          orderBy: { id: 'asc' },
          take: batchSize,
        });
        if (leads.length === 0) break;
        const written = await job.fencedTx(async (tx) => {
          // Re-checked inside the write transaction: an activation in between stops this job.
          const still = await loadActiveScoringConfig(tx, workspaceId);
          if (still === null || still.id !== version.id) return false;
          for (const lead of leads) {
            await tx.lead.updateMany({ where: { id: lead.id, workspaceId }, data: scoreData(scoreLead(scoreInputOf(lead), active)) });
          }
          return true;
        });
        if (!written) {
          superseded = true;
          break;
        }
        rescored += leads.length;
        afterId = leads[leads.length - 1]!.id;
        if (leads.length < batchSize) break;
      }

      return {
        outcome: 'succeeded',
        finalTx: async (tx) => {
          await recordAudit(tx, ctx, {
            action: 'scoring.rescore',
            targetType: 'ScoringConfigVersion',
            targetId: version.id,
            workspaceId,
            summary: { scoreConfigVersion: version.version, rescored, superseded },
          });
        },
      };
    },
  };
}

export const leadRescoreJob = createLeadRescoreJob();

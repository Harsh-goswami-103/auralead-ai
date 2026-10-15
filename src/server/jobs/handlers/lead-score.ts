/**
 * `lead.score` (R14): scores one lead with its workspace's active ScoringConfigVersion and stores
 * the score, reasons, unknown inputs and config version (no network). A workspace without an
 * active config ends the job DEAD with NO_ACTIVE_SCORING_CONFIG, visibly in the job inspector.
 */
import type { Clock } from '@/lib/clock';
import { getConfig } from '@/lib/config';
import { idempotencyKey } from '@/lib/ids';
import { loadActiveScoringConfig } from '@/server/services/scoring/config';
import { scoreInputOf, writeLeadScore } from '@/server/services/scoring/record';
import { scoreLead } from '@/server/services/scoring/score';
import { enqueueJob, type JobStore } from '../queue';
import type { JobDefinition } from '../types';
import { deadResult, jobCtx, leadPayloadSchema, parseWorkspacePayload } from './lead-job-support';

export const LEAD_SCORE_JOB = 'lead.score';

export function enqueueLeadScore(
  db: JobStore,
  clock: Clock,
  input: { workspaceId: string; leadId: string; requestKey: string; correlationId: string; causationId?: string | null },
) {
  return enqueueJob(db, clock, {
    type: LEAD_SCORE_JOB,
    payload: { leadId: input.leadId },
    workspaceId: input.workspaceId,
    idempotencyKey: idempotencyKey(LEAD_SCORE_JOB, input.leadId, input.requestKey),
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    kind: 'default',
  });
}

export function createLeadScoreJob(options: { mode?: () => 'demo' | 'live' } = {}): JobDefinition {
  const mode = options.mode ?? (() => getConfig().mode);
  return {
    type: LEAD_SCORE_JOB,
    kind: 'default',
    payloadVersions: [1],
    async handler(job) {
      const parsed = parseWorkspacePayload(job, leadPayloadSchema);
      if (!parsed.ok) return parsed.result;
      const { workspaceId, payload } = parsed;
      const lead = await job.db.lead.findFirst({ where: { id: payload.leadId, workspaceId } });
      if (!lead) return deadResult('LEAD_NOT_FOUND', `no lead ${payload.leadId} in the job's workspace`);
      const scoring = await loadActiveScoringConfig(job.db, workspaceId);
      if (scoring === null) return deadResult('NO_ACTIVE_SCORING_CONFIG', 'the workspace has no active scoring config');
      const ctx = jobCtx(job, workspaceId, mode());
      return {
        outcome: 'succeeded',
        finalTx: async (tx) => {
          const fresh = await tx.lead.findFirst({ where: { id: lead.id, workspaceId } });
          if (!fresh) return;
          await writeLeadScore(tx, ctx, fresh, scoreLead(scoreInputOf(fresh), scoring), { trigger: LEAD_SCORE_JOB });
        },
      };
    },
  };
}

export const leadScoreJob = createLeadScoreJob();

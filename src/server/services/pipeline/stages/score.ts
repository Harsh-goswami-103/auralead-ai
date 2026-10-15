/**
 * SCORE stage (T12, E9): enrich, then score.
 *
 * `run` (outside any transaction): checks the lead's website through the same enrichment service
 * as `lead.enrich` (DEMO fetches nothing), then scores the lead with the workspace's active
 * ScoringConfigVersion using the website status the check produced. `finalTx` (inside the job's
 * fenced settle, together with the StageRun and the next stage's job) records the website check
 * and the score. The score never blocks on the website: a failed or blocked check only makes the
 * website input unknown.
 *
 * Outcomes:
 * - DONE with `{ score, scoreConfigVersionId, scoreConfigVersion, unknownInputs, website }`.
 * - SKIPPED `NO_ACTIVE_SCORING_CONFIG` when the workspace has no active config (the website check
 *   is still recorded; the pipeline carries on unscored).
 * - An invalid stored config throws ValidationError SCORING_CONFIG_INVALID: the stage FAILS
 *   visibly (STAGE_ERROR) rather than scoring with a guess.
 */
import { getConfig } from '@/lib/config';
import { applyWebsiteCheck, checkLeadWebsite, safeWebsiteFetcher, type WebsiteFetcher } from '@/server/services/enrichment/website';
import { loadActiveScoringConfig } from '@/server/services/scoring/config';
import { scoreInputOf, writeLeadScore } from '@/server/services/scoring/record';
import { scoreLead } from '@/server/services/scoring/score';
import type { StageHandler } from './types';

export type ScoreStageOptions = { fetchWebsite?: WebsiteFetcher };

export function createScoreStage(options: ScoreStageOptions = {}): StageHandler {
  let fetchWebsite = options.fetchWebsite;
  return {
    stage: 'SCORE',
    async run({ ctx, job, lead, execution }) {
      fetchWebsite ??= safeWebsiteFetcher(getConfig().appOrigin);
      const website = await checkLeadWebsite(ctx, lead, { fetchWebsite });
      const websiteRef = website.checked
        ? { checked: true, status: website.status, reasonCode: website.record.reasonCode }
        : { checked: false, status: lead.websiteStatus, reasonCode: website.reasonCode };
      const scoring = await loadActiveScoringConfig(job.db, execution.workspaceId);

      if (scoring === null) {
        return {
          status: 'SKIPPED',
          reasonCode: 'NO_ACTIVE_SCORING_CONFIG',
          outputRef: { website: websiteRef },
          finalTx: async (tx) => {
            await applyWebsiteCheck(tx, ctx, lead, website);
          },
        };
      }

      const websiteStatus = website.checked ? website.status : lead.websiteStatus;
      const result = scoreLead(scoreInputOf(lead, { websiteStatus }), scoring);
      return {
        status: 'DONE',
        outputRef: {
          score: result.score,
          scoreConfigVersionId: result.configVersionId,
          scoreConfigVersion: result.configVersion,
          unknownInputs: result.unknownInputs.map((u) => u.input),
          website: websiteRef,
        },
        finalTx: async (tx) => {
          const { applied } = await applyWebsiteCheck(tx, ctx, lead, website);
          // If the check could not be applied (the website changed meanwhile), score what is stored.
          const fresh = website.checked && !applied ? await tx.lead.findFirst({ where: { id: lead.id, workspaceId: execution.workspaceId } }) : null;
          const final = fresh ? scoreLead(scoreInputOf(fresh), scoring) : result;
          await writeLeadScore(tx, ctx, lead, final, { trigger: 'pipeline.SCORE' });
        },
      };
    },
  };
}

export const scoreStage = createScoreStage();

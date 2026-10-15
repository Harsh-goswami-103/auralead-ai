/**
 * Persisting a score (G-NORM-3): `Lead.score`, the reasons and unknown inputs snapshot, and the
 * ScoringConfigVersion it was computed with, so the explanation stays reproducible after the
 * config changes. Always called inside a fenced job transaction with the raw client, so the
 * workspace is written explicitly.
 */
import type { Lead, Prisma } from '@/generated/prisma/client';
import type { AppCtx } from '@/server/auth/context';
import type { TxClient } from '@/server/jobs/types';
import { recordAudit } from '@/server/services/audit/record';
import type { ScoreInput, ScoreResult } from './score';

export type ScorableLead = Pick<Lead, 'phoneE164' | 'emailNormalized' | 'websiteStatus' | 'rating' | 'reviewCount' | 'category' | 'firstSource'>;

export function scoreInputOf(lead: ScorableLead, overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    phoneE164: lead.phoneE164,
    emailNormalized: lead.emailNormalized,
    websiteStatus: lead.websiteStatus,
    rating: lead.rating,
    reviewCount: lead.reviewCount,
    category: lead.category,
    firstSource: lead.firstSource,
    ...overrides,
  };
}

export function scoreData(result: ScoreResult) {
  return {
    score: result.score,
    scoreReasons: result.reasons as unknown as Prisma.InputJsonValue,
    unknownInputs: result.unknownInputs as unknown as Prisma.InputJsonValue,
    scoreConfigVersionId: result.configVersionId,
  };
}

/** Writes the score onto the lead (same workspace only). `audit: false` is for bulk rescoring. */
export async function writeLeadScore(
  tx: TxClient,
  ctx: AppCtx,
  lead: Pick<Lead, 'id' | 'workspaceId' | 'simulated'>,
  result: ScoreResult,
  opts: { audit?: boolean; trigger?: string } = {},
): Promise<boolean> {
  const updated = await tx.lead.updateMany({ where: { id: lead.id, workspaceId: lead.workspaceId }, data: scoreData(result) });
  if (updated.count !== 1) return false;
  if (opts.audit !== false) {
    await recordAudit(tx, ctx, {
      action: 'lead.score',
      targetType: 'Lead',
      targetId: lead.id,
      workspaceId: lead.workspaceId,
      simulated: lead.simulated,
      summary: {
        score: result.score,
        scoreConfigVersion: result.configVersion,
        unknownInputs: result.unknownInputs.map((u) => u.input),
        trigger: opts.trigger ?? null,
      },
    });
  }
  return true;
}

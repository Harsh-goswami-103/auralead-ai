/**
 * ScoringConfigVersion access (R14, P9). A workspace has at most one active version (partial
 * unique, ADR-47); its `weights` JSON is validated with the shared schema on every read, so the
 * scorer never runs on a config that does not fit (02-errors: invalid config is a
 * ValidationError SCORING_CONFIG_INVALID, never a silent default).
 *
 * Creating and activating versions (preview on 20 sample leads, activation enqueues
 * `lead.rescore`) is the scoring config tab's (T26); it uses `enqueueLeadRescore` from
 * `jobs/handlers/lead-rescore.ts`.
 */
import type { PrismaClient } from '@/generated/prisma/client';
import { parseScoringConfig } from '@/lib/schemas/scoring';
import type { TxClient } from '@/server/jobs/types';
import type { ScoringConfigRef } from './score';

export type ScoringReader = Pick<PrismaClient, 'scoringConfigVersion'> | Pick<TxClient, 'scoringConfigVersion'>;

/** The workspace's active scoring config, parsed; null when the workspace has none. */
export async function loadActiveScoringConfig(db: ScoringReader, workspaceId: string): Promise<ScoringConfigRef | null> {
  const versions = db.scoringConfigVersion as PrismaClient['scoringConfigVersion'];
  const row = await versions.findFirst({ where: { workspaceId, active: true }, select: { id: true, version: true, weights: true } });
  if (!row) return null;
  return { id: row.id, version: row.version, config: parseScoringConfig(row.weights) };
}

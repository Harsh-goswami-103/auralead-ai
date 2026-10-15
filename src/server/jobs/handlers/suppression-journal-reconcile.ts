/**
 * `suppression.journalReconcile` (T18, E8, ADR-38): re-exports Suppression rows whose STOP or CLEAR
 * is not stamped as journaled, for the job's workspace (every workspace for a system job). Queued
 * when an append after commit fails, and by a clear made inside another service's transaction
 * (consent captured at ingestion), with key `suppression.journalReconcile:<suppressionId>:<action>`.
 *
 * Reads go through the unscoped read client, appends run outside any transaction, and the stamps
 * run in the fenced transaction (E5). An entry whose line is already present (append succeeded,
 * stamp lost) is stamped without a second line. Any failed append retries the job with backoff.
 */
import { z } from 'zod';
import { getConfig } from '@/lib/config';
import {
  reconcileSuppressionJournal,
  SUPPRESSION_JOURNAL_PAYLOAD_VERSION,
  SUPPRESSION_JOURNAL_RECONCILE_JOB,
  type JournalDeps,
  type ReconcileReadDb,
  type ReconcileStampTx,
} from '@/server/services/messaging/suppression-journal';
import type { JobDefinition } from '../types';

const payloadSchema = z.object({}).strict();

export function journalDepsFromConfig(): JournalDeps {
  return { journalDir: getConfig().paths.journalDir };
}

export function createSuppressionJournalReconcileJob(options: { deps?: () => JournalDeps } = {}): JobDefinition {
  const deps = options.deps ?? journalDepsFromConfig;
  return {
    type: SUPPRESSION_JOURNAL_RECONCILE_JOB,
    kind: 'default',
    payloadVersions: [SUPPRESSION_JOURNAL_PAYLOAD_VERSION],
    handler: async (ctx) => {
      if (!payloadSchema.safeParse(ctx.job.payload).success) {
        return { outcome: 'dead', reason: 'INVALID_PAYLOAD', errorCode: 'INVALID_PAYLOAD', error: `${ctx.job.type} payload does not match its schema` };
      }
      const result = await reconcileSuppressionJournal(
        ctx.db as unknown as ReconcileReadDb,
        ctx.clock,
        deps(),
        ctx.job.workspaceId,
        (fn) => ctx.fencedTx((tx) => fn(tx as unknown as ReconcileStampTx)),
      );
      ctx.logger.info({ jobId: ctx.job.id, ...result, firstError: undefined }, 'suppression journal reconciled');
      if (result.failed > 0) {
        return { outcome: 'retry', errorCode: 'JOURNAL_APPEND_FAILED', error: `${result.failed} suppression journal entries could not be appended` };
      }
      return { outcome: 'succeeded' };
    },
  };
}

export const suppressionJournalReconcileJob = createSuppressionJournalReconcileJob();

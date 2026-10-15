/**
 * Lease reaper (C8, ADR-05), run by every worker on every loop iteration. For each RUNNING job
 * whose `leaseUntil < now`, in one transaction:
 * - a `DispatchAttempt` for the job is SENDING: the attempt becomes AMBIGUOUS and the job
 *   DEAD(AMBIGUOUS). It is never requeued: the provider may have received the request, and only
 *   positive evidence or an audited operator action resolves it (no blind resend).
 * - otherwise, attempts left: QUEUED with backoff; at max attempts: DEAD(MAX_ATTEMPTS).
 * The open JobAttempt row is closed in the same transaction. The first statement is a
 * conditional write that re-checks the expiry, so two reapers never act on the same lease.
 */
import type { PrismaClient } from '@/generated/prisma/client';
import { withTx } from '@/server/db/tx';
import { DEFAULT_BACKOFF, retryDelayMs, type BackoffPolicy } from './backoff';
import type { ReapAction } from './types';

export type ReapOptions = { now: Date; backoff?: BackoffPolicy; random?: () => number; limit?: number };
export type ReapResult = { jobId: string; action: ReapAction };

export const LEASE_EXPIRED = 'LEASE_EXPIRED';

export async function reapExpiredLeases(db: PrismaClient, options: ReapOptions): Promise<ReapResult[]> {
  const { now } = options;
  const candidates = await db.job.findMany({
    where: { status: 'RUNNING', leaseUntil: { lt: now } },
    select: { id: true },
    orderBy: { leaseUntil: 'asc' },
    take: options.limit ?? 50,
  });
  const results: ReapResult[] = [];
  for (const { id } of candidates) {
    const action = await withTx(db, async (tx) => {
      const claimed = await tx.$executeRaw`
        UPDATE "Job" SET "updatedAt" = ${now}
         WHERE "id" = ${id} AND "status" = 'RUNNING' AND "leaseUntil" < ${now}`;
      if (claimed !== 1) return null;
      const job = await tx.job.findUniqueOrThrow({ where: { id } });
      const sending = await tx.dispatchAttempt.count({ where: { jobId: id, state: 'SENDING' } });

      let result: ReapAction;
      if (sending > 0) {
        await tx.dispatchAttempt.updateMany({
          where: { jobId: id, state: 'SENDING' },
          data: { state: 'AMBIGUOUS', reasonCode: LEASE_EXPIRED, updatedAt: now },
        });
        await tx.job.update({
          where: { id },
          data: {
            status: 'DEAD',
            deadReason: 'AMBIGUOUS',
            retrySafe: false,
            lastErrorCode: LEASE_EXPIRED,
            lastErrorRedacted: 'lease expired while a provider send was in flight',
            claimToken: null,
            leaseUntil: null,
            finishedAt: now,
            updatedAt: now,
          },
        });
        result = 'dead-ambiguous';
      } else if (job.attempts >= job.maxAttempts) {
        await tx.job.update({
          where: { id },
          data: {
            status: 'DEAD',
            deadReason: 'MAX_ATTEMPTS',
            lastErrorCode: LEASE_EXPIRED,
            lastErrorRedacted: 'lease expired on the last allowed attempt',
            claimToken: null,
            leaseUntil: null,
            finishedAt: now,
            updatedAt: now,
          },
        });
        result = 'dead-max-attempts';
      } else {
        const delay = retryDelayMs(Math.max(job.attempts, 1), options.backoff ?? DEFAULT_BACKOFF, { random: options.random });
        await tx.job.update({
          where: { id },
          data: {
            status: 'QUEUED',
            runAt: new Date(now.getTime() + delay),
            lastErrorCode: LEASE_EXPIRED,
            lastErrorRedacted: 'lease expired before the job settled',
            claimToken: null,
            leaseUntil: null,
            updatedAt: now,
          },
        });
        result = 'requeued';
      }
      await tx.jobAttempt.updateMany({
        where: { jobId: id, finishedAt: null },
        data: {
          outcome: result === 'dead-ambiguous' ? 'AMBIGUOUS' : 'LEASE_LOST',
          errorCode: LEASE_EXPIRED,
          finishedAt: now,
        },
      });
      return result;
    });
    if (action) results.push({ jobId: id, action });
  }
  return results;
}

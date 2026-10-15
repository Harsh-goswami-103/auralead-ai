/**
 * Lease fencing (E5, ADR-39). Every job-driven write transaction (preflight, settle, fail, and any
 * domain write a handler makes) calls `fenceJob` as its FIRST statement. It is a write-first
 * check: the UPDATE only matches while this worker still holds the claim, and as a write it also
 * takes the SQLite write lock, so the claim cannot change under the rest of the transaction.
 * Zero rows means the lease was lost (the reaper requeued the job, another worker reclaimed it, or
 * the job was settled): `LeaseLostError` propagates, the transaction rolls back, and the handler
 * must not call a provider.
 *
 * `now` comes from the caller's Clock (no wall-clock reads in src/server).
 */
import type { PrismaClient } from '@/generated/prisma/client';

export class LeaseLostError extends Error {
  readonly code = 'LEASE_LOST';
  readonly jobId: string;

  constructor(jobId: string) {
    super(`lease lost for job ${jobId}: claim token no longer current`);
    this.name = 'LeaseLostError';
    this.jobId = jobId;
  }
}

/** A client or an interactive-transaction client. */
export type FenceDb = Pick<PrismaClient, '$executeRaw'>;

export async function fenceJob(tx: FenceDb, jobId: string, claimToken: string, now: Date): Promise<void> {
  const updated = await tx.$executeRaw`
    UPDATE "Job" SET "updatedAt" = ${now}
     WHERE "id" = ${jobId} AND "claimToken" = ${claimToken} AND "status" = 'RUNNING'`;
  if (updated !== 1) throw new LeaseLostError(jobId);
}

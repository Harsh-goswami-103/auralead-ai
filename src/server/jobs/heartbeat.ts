/**
 * Worker liveness (plan §4.3): a `WorkerHeartbeat` row per worker (every 10 s by default, and on
 * each job start and finish), and lease extension for long jobs (every 20 s by default for a 60 s
 * lease). Lease extension is fenced on the claim token, so a worker that already lost the job
 * learns it here and never moves another worker's lease.
 *
 * Both writes go through `withTx`: the adapter keeps one connection per client and serializes
 * interactive transactions, so a background write never lands inside a handler's open transaction.
 */
import type { PrismaClient } from '@/generated/prisma/client';
import { withTx } from '@/server/db/tx';

export type HeartbeatInput = {
  workerId: string;
  pid: number;
  hostname: string;
  version: string;
  mode: 'demo' | 'live';
  startedAt: Date;
  now: Date;
  currentJobId: string | null;
};

export async function writeHeartbeat(db: PrismaClient, input: HeartbeatInput): Promise<void> {
  const mode = input.mode === 'live' ? 'LIVE' : 'DEMO';
  await withTx(db, (tx) =>
    tx.workerHeartbeat.upsert({
      where: { workerId: input.workerId },
      create: {
        workerId: input.workerId,
        pid: input.pid,
        hostname: input.hostname,
        version: input.version,
        mode,
        startedAt: input.startedAt,
        lastBeatAt: input.now,
        currentJobId: input.currentJobId,
      },
      update: { pid: input.pid, lastBeatAt: input.now, currentJobId: input.currentJobId },
    }),
  );
}

/** Pushes `leaseUntil` to now + leaseMs while the claim is current. False means the lease is lost. */
export async function extendLease(db: PrismaClient, input: { jobId: string; claimToken: string; now: Date; leaseMs: number }): Promise<boolean> {
  const leaseUntil = new Date(input.now.getTime() + input.leaseMs);
  const updated = await withTx(
    db,
    (tx) => tx.$executeRaw`
      UPDATE "Job" SET "leaseUntil" = ${leaseUntil}, "updatedAt" = ${input.now}
       WHERE "id" = ${input.jobId} AND "claimToken" = ${input.claimToken} AND "status" = 'RUNNING'`,
  );
  return updated === 1;
}

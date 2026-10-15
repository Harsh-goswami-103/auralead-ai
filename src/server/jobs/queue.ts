/**
 * Enqueue, claim and cancel (plan §4.3, §6.2).
 *
 * - `enqueueJob` is idempotent on `Job.idempotencyKey` (UNIQUE): a duplicate returns the existing
 *   job with `created: false`. It works on a client or inside a caller's transaction, so services
 *   can enqueue atomically with their own writes.
 * - `claimJob` runs the single-statement claim (`db/raw/claim-job.ts`) and opens the JobAttempt
 *   row in the same transaction. JobAttempt numbers are sequential per job and independent of
 *   `Job.attempts`, which deferrals refund.
 * - Payloads carry ids and `payloadVersion`, never secrets.
 */
import { Prisma, type Job, type PrismaClient } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { newClaimToken } from '@/lib/ids';
import { claimNextJob, type ClaimedJob } from '@/server/db/raw/claim-job';
import { withTx } from '@/server/db/tx';
import { maxAttemptsFor, type JobKind } from './backoff';
import type { TxClient } from './types';

export type JobStore = Pick<PrismaClient, 'job'> | Pick<TxClient, 'job'>;

export type EnqueueInput = {
  type: string;
  payload: Prisma.InputJsonValue;
  payloadVersion?: number;
  /** Null only for system jobs. */
  workspaceId: string | null;
  idempotencyKey: string;
  correlationId: string;
  causationId?: string | null;
  /** Defaults to now. */
  runAt?: Date;
  /** Lower runs first. */
  priority?: number;
  /** Per-conversation ordering: at most one RUNNING job per key. */
  serialKey?: string | null;
  /** Selects the default max attempts (send 5, ai 3, fetch 8, pdf 3, default 5). */
  kind?: JobKind;
  maxAttempts?: number;
  retrySafe?: boolean;
};

export type EnqueueResult = { job: Job; created: boolean };

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export async function enqueueJob(db: JobStore, clock: Clock, input: EnqueueInput): Promise<EnqueueResult> {
  if (input.idempotencyKey.length === 0) throw new RangeError('enqueueJob: idempotencyKey is required');
  const maxAttempts = input.maxAttempts ?? maxAttemptsFor(input.kind);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError('enqueueJob: maxAttempts must be a positive integer');
  const jobs = db.job as PrismaClient['job'];

  const existing = await jobs.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return { job: existing, created: false };

  const now = clock.now();
  try {
    const job = await jobs.create({
      data: {
        type: input.type,
        payload: input.payload,
        payloadVersion: input.payloadVersion ?? 1,
        workspaceId: input.workspaceId,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        causationId: input.causationId ?? null,
        runAt: input.runAt ?? now,
        priority: input.priority ?? 0,
        serialKey: input.serialKey ?? null,
        maxAttempts,
        retrySafe: input.retrySafe ?? false,
        createdAt: now,
        updatedAt: now,
      },
    });
    return { job, created: true };
  } catch (error) {
    // Lost a race with a concurrent enqueue of the same key.
    if (!isUniqueViolation(error)) throw error;
    const winner = await jobs.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (!winner) throw error;
    return { job: winner, created: false };
  }
}

export type ClaimResult = { job: ClaimedJob; attemptId: string };

export async function claimJob(db: PrismaClient, options: { now: Date; leaseMs: number }): Promise<ClaimResult | null> {
  const { now, leaseMs } = options;
  return withTx(db, async (tx) => {
    const job = await claimNextJob(tx, { now, leaseUntil: new Date(now.getTime() + leaseMs), claimToken: newClaimToken() });
    if (!job) return null;
    const previous = await tx.jobAttempt.count({ where: { jobId: job.id } });
    const attempt = await tx.jobAttempt.create({
      data: {
        workspaceId: job.workspaceId,
        jobId: job.id,
        attemptNo: previous + 1,
        startedAt: now,
        correlationId: job.correlationId,
      },
    });
    return { job, attemptId: attempt.id };
  });
}

/**
 * Operator or service cancel (§6.2): a QUEUED job becomes CANCELLED at once; a RUNNING job gets
 * `cancelRequestedAt`, which the runner observes before the handler runs. Terminal jobs are left
 * unchanged. Returns the resulting status.
 */
export async function requestCancel(db: PrismaClient | TxClient, clock: Clock, jobId: string): Promise<Job['status']> {
  const now = clock.now();
  const queued = await db.job.updateMany({
    where: { id: jobId, status: 'QUEUED' },
    data: { status: 'CANCELLED', finishedAt: now, updatedAt: now },
  });
  if (queued.count === 1) return 'CANCELLED';
  await db.job.updateMany({ where: { id: jobId, status: 'RUNNING', cancelRequestedAt: null }, data: { cancelRequestedAt: now, updatedAt: now } });
  const job = await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { status: true } });
  return job.status;
}

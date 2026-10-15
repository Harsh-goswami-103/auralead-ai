/**
 * Job runtime contracts (plan §4.3, §6.2). A handler receives a `JobHandlerContext` and returns a
 * `JobResult`; the runner turns the result (or a thrown error) into exactly one fenced settle.
 *
 * Handler rules:
 * - Every domain write happens inside `ctx.fencedTx` or in the result's `finalTx`, both of which
 *   start with the claimToken fence (E5, ADR-39). Writing through `ctx.db` directly is not allowed.
 * - `finalTx` runs inside the settle transaction, so a domain write and the job's final state
 *   commit together; a crash between them is impossible.
 * - No provider calls inside a transaction; no timers or detached promises.
 * - Throwing: an `AppError` with `retryable` requeues with backoff (bounded by maxAttempts); any
 *   other error is fatal (DEAD). `LeaseLostError` means another worker owns the job now.
 */
import type { Prisma, PrismaClient } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import type { Logger } from '@/lib/logger';
import type { ClaimedJob } from '@/server/db/raw/claim-job';
import type { JobKind } from './backoff';

export type TxClient = Prisma.TransactionClient;

export type FinalTx = (tx: TxClient) => Promise<void>;

export type JobResult =
  | { outcome: 'succeeded'; finalTx?: FinalTx }
  /** Not run yet (pause, throttle, cap): QUEUED at `runAt`, attempt counter refunded. */
  | { outcome: 'deferred'; runAt: Date; reason: string; finalTx?: FinalTx }
  /** Definite, safe-to-repeat failure: requeued with backoff (honoring retryAfterMs) or DEAD at max. */
  | { outcome: 'retry'; errorCode: string; error: string; retryAfterMs?: number; finalTx?: FinalTx }
  /** Terminal failure decided by the handler (e.g. AMBIGUOUS after a write timeout). */
  | { outcome: 'dead'; reason: string; errorCode?: string; error?: string; retrySafe?: boolean; finalTx?: FinalTx }
  | { outcome: 'cancelled'; reason?: string; finalTx?: FinalTx };

export type JobHandlerContext = {
  job: ClaimedJob;
  clock: Clock;
  /** Unscoped client for reads. Writes go through `fencedTx` or `finalTx`. */
  db: PrismaClient;
  logger: Logger;
  correlationId: string;
  /** Aborted when lease extension finds the lease lost: stop before any further side effect. */
  signal: AbortSignal;
  /** A busy-retrying transaction whose first statement is the claimToken fence. */
  fencedTx<R>(fn: (tx: TxClient) => Promise<R>): Promise<R>;
};

export type JobHandler = (ctx: JobHandlerContext) => Promise<JobResult>;

export type JobDefinition = {
  type: string;
  kind: JobKind;
  /** Payload versions this handler understands; anything else goes DEAD (plan §4.3). */
  payloadVersions: readonly number[];
  handler: JobHandler;
};

export type ReapAction = 'requeued' | 'dead-ambiguous' | 'dead-max-attempts';

export type JobEvent =
  | { type: 'claimed'; jobId: string; jobType: string; attempts: number; workerId: string }
  | { type: 'succeeded'; jobId: string; jobType: string; attempts: number; durationMs: number }
  | { type: 'retry'; jobId: string; jobType: string; attempts: number; runAt: string; errorCode: string }
  | { type: 'deferred'; jobId: string; jobType: string; runAt: string; reason: string }
  | { type: 'dead'; jobId: string; jobType: string; attempts: number; reason: string; errorCode: string | null }
  | { type: 'cancelled'; jobId: string; jobType: string; attempts: number }
  | { type: 'lease-lost'; jobId: string; jobType: string; attempts: number }
  | { type: 'reaped'; jobId: string; action: ReapAction };

/**
 * Runs one claimed job and settles it exactly once (plan §4.3, §6.2, E5).
 *
 * Order: pause point `job.claimed` -> type, payloadVersion and cancel checks -> lease extender
 * starts -> handler -> extender stops -> pause point `job.before-settle` -> one fenced settle tx.
 * Every settle starts with `fenceJob`, so a worker whose lease was taken over (reaper requeue plus
 * another worker's claim) writes nothing: it only closes its own JobAttempt log row as LEASE_LOST.
 *
 * Error mapping: a thrown AppError with `retryable` (or DB_BUSY) is a retry; LEASE_LOST is a lost
 * lease; anything else is fatal (DEAD). Error text is stored only after `redactText`.
 */
import type { Prisma, PrismaClient } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { redactText } from '@/lib/redact';
import { fenceJob } from '@/server/db/fence';
import { withTx } from '@/server/db/tx';
import { pausePoint } from '@/server/testing/pause';
import { DEFAULT_BACKOFF, retryDelayMs, type BackoffPolicy } from './backoff';
import { extendLease } from './heartbeat';
import type { ClaimResult } from './queue';
import type { JobRegistry } from './registry';
import type { FinalTx, JobEvent, JobHandlerContext, JobResult, TxClient } from './types';

export type RunnerDeps = {
  db: PrismaClient;
  clock: Clock;
  registry: JobRegistry;
  logger: Logger;
  workerId: string;
  leaseMs: number;
  leaseExtendEveryMs: number;
  backoff?: BackoffPolicy;
  random?: () => number;
  onEvent?: (event: JobEvent) => void;
};

const MAX_ERROR_TEXT = 500;

export function redactErrorText(text: string): string {
  return redactText(text).slice(0, MAX_ERROR_TEXT);
}

function isLeaseLost(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'LEASE_LOST';
}

type Classified = { kind: 'retry'; errorCode: string; error: string; retryAfterMs?: number } | { kind: 'fatal'; errorCode: string; error: string };

function classify(error: unknown): Classified {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (error instanceof AppError) {
    if (error.retryable) {
      return {
        kind: 'retry',
        errorCode: error.code,
        error: text,
        retryAfterMs: error.retryAfterSeconds === undefined ? undefined : error.retryAfterSeconds * 1_000,
      };
    }
    return { kind: 'fatal', errorCode: error.code, error: text };
  }
  if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'DB_BUSY') {
    return { kind: 'retry', errorCode: 'DB_BUSY', error: text };
  }
  return { kind: 'fatal', errorCode: 'UNHANDLED_ERROR', error: text };
}

type Settlement = {
  job: Prisma.JobUpdateInput;
  attempt: { outcome: 'SUCCEEDED' | 'RETRYABLE' | 'FATAL' | 'AMBIGUOUS' | 'DEFERRED'; errorCode?: string | null; errorRedacted?: string | null };
  finalTx?: FinalTx;
  event: JobEvent;
};

export async function runClaimedJob(deps: RunnerDeps, claim: ClaimResult): Promise<JobEvent> {
  const { db, clock, logger } = deps;
  const { job, attemptId } = claim;
  const started = performance.now();
  const base = { jobId: job.id, jobType: job.type };
  const emit = (event: JobEvent): JobEvent => {
    deps.onEvent?.(event);
    logger.info({ event }, `job ${event.type}`);
    return event;
  };
  emit({ type: 'claimed', ...base, attempts: job.attempts, workerId: deps.workerId });

  await pausePoint('job.claimed', { jobId: job.id, workerId: deps.workerId });

  const fencedTx = <R>(fn: (tx: TxClient) => Promise<R>): Promise<R> =>
    withTx(db, async (tx) => {
      await fenceJob(tx, job.id, job.claimToken, clock.now());
      return fn(tx);
    });

  const settle = async (s: Settlement): Promise<JobEvent> => {
    const now = clock.now();
    const durationMs = Math.round(performance.now() - started);
    await fencedTx(async (tx) => {
      if (s.finalTx) await s.finalTx(tx);
      await tx.job.update({ where: { id: job.id }, data: { ...s.job, claimToken: null, leaseUntil: null, updatedAt: now } });
      await tx.jobAttempt.update({
        where: { id: attemptId },
        data: {
          outcome: s.attempt.outcome,
          errorCode: s.attempt.errorCode ?? null,
          errorRedacted: s.attempt.errorRedacted ?? null,
          finishedAt: now,
          durationMs,
        },
      });
    });
    return emit(s.event.type === 'succeeded' ? { ...s.event, durationMs } : s.event);
  };

  const dead = (reason: string, errorCode: string | null, error: string | null, finalTx?: FinalTx, retrySafe?: boolean): Settlement => {
    const now = clock.now();
    const redacted = error === null ? null : redactErrorText(error);
    return {
      job: {
        status: 'DEAD',
        deadReason: reason,
        lastErrorCode: errorCode,
        lastErrorRedacted: redacted,
        finishedAt: now,
        ...(retrySafe === undefined ? {} : { retrySafe }),
      },
      attempt: { outcome: reason === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'FATAL', errorCode, errorRedacted: redacted },
      finalTx,
      event: { type: 'dead', ...base, attempts: job.attempts, reason, errorCode },
    };
  };

  const retry = (errorCode: string, error: string, retryAfterMs?: number, finalTx?: FinalTx): Settlement => {
    const redacted = redactErrorText(error);
    if (job.attempts >= job.maxAttempts) {
      const s = dead('MAX_ATTEMPTS', errorCode, error, finalTx);
      return { ...s, attempt: { outcome: 'RETRYABLE', errorCode, errorRedacted: redacted } };
    }
    const runAt = new Date(clock.now().getTime() + retryDelayMs(job.attempts, deps.backoff ?? DEFAULT_BACKOFF, { retryAfterMs, random: deps.random }));
    return {
      job: { status: 'QUEUED', runAt, lastErrorCode: errorCode, lastErrorRedacted: redacted },
      attempt: { outcome: 'RETRYABLE', errorCode, errorRedacted: redacted },
      finalTx,
      event: { type: 'retry', ...base, attempts: job.attempts, runAt: runAt.toISOString(), errorCode },
    };
  };

  const fromResult = (result: JobResult): Settlement => {
    switch (result.outcome) {
      case 'succeeded':
        return {
          job: { status: 'SUCCEEDED', finishedAt: clock.now() },
          attempt: { outcome: 'SUCCEEDED' },
          finalTx: result.finalTx,
          event: { type: 'succeeded', ...base, attempts: job.attempts, durationMs: 0 },
        };
      case 'deferred':
        return {
          job: { status: 'QUEUED', runAt: result.runAt, attempts: { decrement: 1 }, lastErrorCode: result.reason },
          attempt: { outcome: 'DEFERRED', errorCode: result.reason },
          finalTx: result.finalTx,
          event: { type: 'deferred', ...base, runAt: result.runAt.toISOString(), reason: result.reason },
        };
      case 'retry':
        return retry(result.errorCode, result.error, result.retryAfterMs, result.finalTx);
      case 'dead':
        return dead(result.reason, result.errorCode ?? null, result.error ?? null, result.finalTx, result.retrySafe);
      case 'cancelled':
        return {
          job: { status: 'CANCELLED', finishedAt: clock.now(), lastErrorCode: result.reason ?? 'CANCELLED' },
          attempt: { outcome: 'FATAL', errorCode: 'JOB_CANCELLED' },
          finalTx: result.finalTx,
          event: { type: 'cancelled', ...base, attempts: job.attempts },
        };
    }
  };

  const leaseLost = async (): Promise<JobEvent> => {
    const now = clock.now();
    await withTx(db, (tx) =>
      tx.jobAttempt.updateMany({
        where: { id: attemptId, finishedAt: null },
        data: { outcome: 'LEASE_LOST', errorCode: 'LEASE_LOST', finishedAt: now, durationMs: Math.round(performance.now() - started) },
      }),
    );
    const event = emit({ type: 'lease-lost', ...base, attempts: job.attempts });
    logger.warn({ jobId: job.id }, 'lease lost: another worker owns this job; nothing written');
    return event;
  };

  try {
    const def = deps.registry.get(job.type);
    if (!def) return await settle(dead('UNKNOWN_JOB_TYPE', 'UNKNOWN_JOB_TYPE', `no handler registered for job type ${job.type}`));
    if (!def.payloadVersions.includes(job.payloadVersion)) {
      return await settle(dead('UNKNOWN_PAYLOAD_VERSION', 'UNKNOWN_PAYLOAD_VERSION', `payloadVersion ${job.payloadVersion} is not supported by ${job.type}`));
    }
    if (job.cancelRequestedAt !== null) return await settle(fromResult({ outcome: 'cancelled', reason: 'CANCEL_REQUESTED' }));

    const abort = new AbortController();
    const extender = startLeaseExtender(deps, job.id, job.claimToken, abort);
    const ctx: JobHandlerContext = {
      job,
      clock,
      db,
      logger: logger.child({ jobId: job.id, correlationId: job.correlationId }),
      correlationId: job.correlationId,
      signal: abort.signal,
      fencedTx,
    };
    let settlement: Settlement | null = null;
    let lost = false;
    try {
      settlement = fromResult(await def.handler(ctx));
    } catch (error) {
      if (isLeaseLost(error)) lost = true;
      else {
        const c = classify(error);
        logger.warn({ jobId: job.id, errorCode: c.errorCode, error: redactErrorText(c.error) }, 'job handler failed');
        settlement = c.kind === 'retry' ? retry(c.errorCode, c.error, c.retryAfterMs) : dead('FATAL', c.errorCode, c.error);
      }
    } finally {
      await extender.stop();
    }
    if (lost || settlement === null || abort.signal.aborted) return await leaseLost();

    await pausePoint('job.before-settle', { jobId: job.id, workerId: deps.workerId });
    return await settle(settlement);
  } catch (error) {
    if (isLeaseLost(error)) return leaseLost();
    throw error;
  }
}

type Extender = { stop(): Promise<void> };

function startLeaseExtender(deps: RunnerDeps, jobId: string, claimToken: string, abort: AbortController): Extender {
  let inflight: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    inflight = inflight.then(async () => {
      if (abort.signal.aborted) return;
      try {
        const ok = await extendLease(deps.db, { jobId, claimToken, now: deps.clock.now(), leaseMs: deps.leaseMs });
        if (!ok) abort.abort(new Error('LEASE_LOST'));
      } catch (error) {
        deps.logger.warn({ jobId, error: redactErrorText(String(error)) }, 'lease extension failed; will retry');
      }
    });
  }, deps.leaseExtendEveryMs);
  return {
    async stop() {
      clearInterval(timer);
      await inflight;
    },
  };
}

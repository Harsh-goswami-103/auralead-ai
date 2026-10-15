/**
 * The worker loop (plan §4.3): per iteration, refresh the clock (DbOffsetClock in DEMO test
 * control), run the reaper, claim one job, run and settle it. When nothing is claimable it sleeps
 * `idlePollMs`. A heartbeat row is written every `heartbeatEveryMs` and on each job start/finish.
 *
 * `stop()` stops claiming, lets the job in flight finish (up to `shutdownGraceMs`) and resolves.
 * Correctness never depends on it: a killed worker's lease expires and the reaper takes over.
 * Concurrency is 1.
 */
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PrismaClient } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { randomBase64Url } from '@/lib/ids';
import type { Logger } from '@/lib/logger';
import { DEFAULT_BACKOFF, type BackoffPolicy } from '@/server/jobs/backoff';
import { writeHeartbeat } from '@/server/jobs/heartbeat';
import { claimJob } from '@/server/jobs/queue';
import { reapExpiredLeases } from '@/server/jobs/reaper';
import type { JobRegistry } from '@/server/jobs/registry';
import { redactErrorText, runClaimedJob } from '@/server/jobs/runner';
import type { JobEvent } from '@/server/jobs/types';

export type WorkerTuning = {
  leaseMs: number;
  leaseExtendEveryMs: number;
  heartbeatEveryMs: number;
  idlePollMs: number;
  shutdownGraceMs: number;
  backoff: BackoffPolicy;
};

export const DEFAULT_TUNING: WorkerTuning = {
  leaseMs: 60_000,
  leaseExtendEveryMs: 20_000,
  heartbeatEveryMs: 10_000,
  idlePollMs: 1_000,
  shutdownGraceMs: 25_000,
  backoff: DEFAULT_BACKOFF,
};

export type WorkerDeps = {
  db: PrismaClient;
  clock: Clock;
  /** Re-reads shifted test time once per loop iteration (DbOffsetClock.refresh). */
  refreshClock?: () => Promise<void>;
  registry: JobRegistry;
  logger: Logger;
  mode: 'demo' | 'live';
  version: string;
  workerId?: string;
  random?: () => number;
  onEvent?: (event: JobEvent) => void;
  /** run() waits for this before its first iteration. */
  startGate?: Promise<void>;
};

export type Worker = {
  readonly workerId: string;
  /** One iteration: reap, claim, run. */
  tick(): Promise<'ran' | 'idle'>;
  /** Loops until stop(). */
  run(): Promise<void>;
  stop(reason?: string): Promise<void>;
};

function positiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`worker tuning ${name} must be a positive integer`);
  return value;
}

export function resolveTuning(partial: Partial<WorkerTuning> = {}): WorkerTuning {
  const t = { ...DEFAULT_TUNING, ...partial };
  positiveInt('leaseMs', t.leaseMs);
  positiveInt('leaseExtendEveryMs', t.leaseExtendEveryMs);
  positiveInt('heartbeatEveryMs', t.heartbeatEveryMs);
  positiveInt('idlePollMs', t.idlePollMs);
  positiveInt('shutdownGraceMs', t.shutdownGraceMs);
  if (t.leaseExtendEveryMs >= t.leaseMs) throw new RangeError('worker tuning leaseExtendEveryMs must be shorter than leaseMs');
  return t;
}

export function createWorker(deps: WorkerDeps, partialTuning: Partial<WorkerTuning> = {}): Worker {
  const tuning = resolveTuning(partialTuning);
  const { db, clock, logger } = deps;
  const workerId = deps.workerId ?? `${os.hostname()}-${process.pid}-${randomBase64Url(6)}`;
  const startedAt = clock.now();
  let currentJobId: string | null = null;
  let stopping = false;
  let runPromise: Promise<void> | null = null;
  const idle = new AbortController();

  let beatChain: Promise<void> = Promise.resolve();
  const beat = (): Promise<void> => {
    beatChain = beatChain.then(async () => {
      try {
        await writeHeartbeat(db, {
          workerId,
          pid: process.pid,
          hostname: os.hostname(),
          version: deps.version,
          mode: deps.mode,
          startedAt,
          now: clock.now(),
          currentJobId,
        });
      } catch (error) {
        logger.warn({ error: redactErrorText(String(error)) }, 'heartbeat write failed');
      }
    });
    return beatChain;
  };

  const emit = (event: JobEvent): void => {
    deps.onEvent?.(event);
  };

  async function tick(): Promise<'ran' | 'idle'> {
    if (deps.refreshClock) await deps.refreshClock();
    const now = clock.now();
    const reaped = await reapExpiredLeases(db, { now, backoff: tuning.backoff, random: deps.random });
    for (const r of reaped) {
      const event: JobEvent = { type: 'reaped', jobId: r.jobId, action: r.action };
      logger.warn({ event }, 'reaped an expired lease');
      emit(event);
    }
    const claim = await claimJob(db, { now: clock.now(), leaseMs: tuning.leaseMs });
    if (!claim) return 'idle';
    currentJobId = claim.job.id;
    await beat();
    try {
      await runClaimedJob(
        {
          db,
          clock,
          registry: deps.registry,
          logger,
          workerId,
          leaseMs: tuning.leaseMs,
          leaseExtendEveryMs: tuning.leaseExtendEveryMs,
          backoff: tuning.backoff,
          random: deps.random,
          onEvent: emit,
        },
        claim,
      );
    } finally {
      currentJobId = null;
      await beat();
    }
    return 'ran';
  }

  async function loop(): Promise<void> {
    if (deps.startGate) await deps.startGate;
    await beat();
    const timer = setInterval(() => void beat(), tuning.heartbeatEveryMs);
    try {
      while (!stopping) {
        let result: 'ran' | 'idle' = 'idle';
        try {
          result = await tick();
        } catch (error) {
          logger.error({ error: redactErrorText(String(error)) }, 'worker iteration failed');
        }
        if (result === 'idle' && !stopping) {
          await sleep(tuning.idlePollMs, undefined, { signal: idle.signal }).catch(() => undefined);
        }
      }
    } finally {
      clearInterval(timer);
      await beat();
      logger.info({ workerId }, 'worker stopped');
    }
  }

  return {
    workerId,
    tick,
    run() {
      if (runPromise) throw new Error('worker is already running');
      logger.info({ workerId, mode: deps.mode, version: deps.version }, 'worker started');
      runPromise = loop();
      return runPromise;
    },
    async stop(reason = 'stop requested') {
      if (!stopping) logger.info({ workerId, reason }, 'worker stopping: no new claims');
      stopping = true;
      idle.abort();
      if (!runPromise) return;
      const grace = new AbortController();
      const finished = await Promise.race([
        runPromise.then(() => true),
        sleep(tuning.shutdownGraceMs, false, { signal: grace.signal }).catch(() => false),
      ]);
      grace.abort();
      if (!finished) logger.warn({ workerId, currentJobId }, 'shutdown grace elapsed with a job in flight; its lease will expire');
    },
  };
}

/**
 * Queue health (R33, T24): one read model for the admin jobs page and `GET
 * /api/admin/system/queue-health`.
 *  - Worker liveness from the newest WorkerHeartbeat of this mode: a beat older than 30 s (or none)
 *    reads "Worker not running" (the worker beats every 10 s, plan §4.3).
 *  - AMBIGUOUS dispatch attempts awaiting an operator ("Delivery unknown").
 *  - QUEUED jobs that are due, the age of the oldest due one (how far the worker is behind), and
 *    retry-waiting jobs (QUEUED with a future runAt, the C7 "RETRY_WAIT" label).
 *  - Job counts per status, and the global outbound pause state.
 */
import type { JobStatus } from '@/generated/prisma/client';
import { baseClientOf, type AppCtx } from '@/server/auth/context';
import { requireRole } from '@/server/auth/guards';
import { dbMode } from '@/server/auth/session';
import { WORKER_STALE_AFTER_MS } from '@/server/services/shell/panel-home';
import { readOutboundPause, type OutboundPauseState } from '@/server/services/admin/outbound-pause';

export const WORKER_NOT_RUNNING_LABEL = 'Worker not running';
export { WORKER_STALE_AFTER_MS };

export type QueueHealth = {
  asOf: Date;
  worker: { running: boolean; label: string; workerId: string | null; lastBeatAt: Date | null; ageMs: number | null; currentJobId: string | null; version: string | null };
  byStatus: Record<JobStatus, number>;
  dueQueued: number;
  retryWaiting: number;
  oldestDueQueued: { jobId: string; type: string; runAt: Date; ageMs: number } | null;
  ambiguousAttempts: number;
  outbound: OutboundPauseState | null;
};

export async function loadQueueHealth(ctx: AppCtx, opts: { lockFile?: string; envPaused?: boolean } = {}): Promise<QueueHealth> {
  requireRole(ctx, 'SUPER_ADMIN');
  const prisma = baseClientOf(ctx);
  const now = ctx.clock.now();

  const beat = await prisma.workerHeartbeat.findFirst({ where: { mode: dbMode(ctx.mode) }, orderBy: { lastBeatAt: 'desc' } });
  const ageMs = beat ? now.getTime() - beat.lastBeatAt.getTime() : null;
  const running = ageMs !== null && ageMs <= WORKER_STALE_AFTER_MS;

  const grouped = await prisma.job.groupBy({ by: ['status'], _count: { _all: true } });
  const byStatus: Record<JobStatus, number> = { QUEUED: 0, RUNNING: 0, SUCCEEDED: 0, DEAD: 0, CANCELLED: 0 };
  for (const g of grouped) byStatus[g.status] = g._count._all;

  const [dueQueued, retryWaiting, oldest, ambiguousAttempts] = await Promise.all([
    prisma.job.count({ where: { status: 'QUEUED', runAt: { lte: now } } }),
    prisma.job.count({ where: { status: 'QUEUED', runAt: { gt: now } } }),
    prisma.job.findFirst({ where: { status: 'QUEUED', runAt: { lte: now } }, orderBy: [{ runAt: 'asc' }, { id: 'asc' }], select: { id: true, type: true, runAt: true } }),
    prisma.dispatchAttempt.count({ where: { state: 'AMBIGUOUS' } }),
  ]);

  return {
    asOf: now,
    worker: {
      running,
      label: running ? 'Running' : WORKER_NOT_RUNNING_LABEL,
      workerId: beat?.workerId ?? null,
      lastBeatAt: beat?.lastBeatAt ?? null,
      ageMs,
      currentJobId: beat?.currentJobId ?? null,
      version: beat?.version ?? null,
    },
    byStatus,
    dueQueued,
    retryWaiting,
    oldestDueQueued: oldest ? { jobId: oldest.id, type: oldest.type, runAt: oldest.runAt, ageMs: now.getTime() - oldest.runAt.getTime() } : null,
    ambiguousAttempts,
    outbound: opts.lockFile === undefined ? null : await readOutboundPause(prisma, { lockFile: opts.lockFile, envPaused: opts.envPaused ?? false }),
  };
}

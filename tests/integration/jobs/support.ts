/**
 * Helpers for the T07 job-runtime tests: spawn real worker processes (tests/integration/jobs/
 * fixtures/job-worker.ts, which boots through the production worker/boot.ts with test handlers),
 * seed jobs, poll the DB, and drive file-based pause points (src/server/testing/pause.ts).
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient } from '@/generated/prisma/client';
import { spawnTsx, type SpawnedNode } from '../../support/spawn';

export const JOB_WORKER = path.resolve(import.meta.dirname, 'fixtures', 'job-worker.ts');
export const RUN_AT = new Date('2026-01-01T00:00:00.000Z');
const TEST_TOKEN = 'test-control-token-for-job-runtime-tests';

export type WorkerTuning = {
  leaseMs?: number;
  leaseExtendEveryMs?: number;
  heartbeatEveryMs?: number;
  idlePollMs?: number;
  shutdownGraceMs?: number;
  backoff?: { baseMs: number; capMs: number; jitterRatio: number };
};

export type SpawnWorkerOptions = {
  name: string;
  tuning?: WorkerTuning;
  /** Wait for a GO line on stdin before the first loop iteration. */
  waitForGo?: boolean;
  pause?: { dir: string; points: string[] };
};

export function spawnJobWorker(url: string, options: SpawnWorkerOptions): SpawnedNode {
  return spawnTsx(JOB_WORKER, {
    env: {
      DATABASE_URL: url,
      APP_MODE: 'demo',
      NEXT_PUBLIC_APP_MODE: 'demo',
      AURALEAD_TEST_CONTROL: '1',
      TEST_CONTROL_TOKEN: TEST_TOKEN,
      LOG_LEVEL: 'warn',
      NODE_ENV: 'test',
      WORKER_NAME: options.name,
      WORKER_TUNING: JSON.stringify(options.tuning ?? {}),
      WAIT_FOR_GO: options.waitForGo ? '1' : '0',
      AURALEAD_PAUSE_DIR: options.pause?.dir,
      AURALEAD_PAUSE_AT: options.pause?.points.join(','),
    },
  });
}

export async function waitReady(w: SpawnedNode): Promise<void> {
  await w.waitForLine((l) => l === 'READY', 30_000);
}

/** Graceful stop through the worker's own stop() (Windows has no deliverable SIGINT for children). */
export async function stopWorker(w: SpawnedNode): Promise<void> {
  if (w.child.exitCode !== null) return;
  w.send('STOP');
  const exit = await w.waitForExit(40_000);
  if (exit.code !== 0) throw new Error(`worker ${w.pid} exited ${JSON.stringify(exit)}; stderr: ${w.stderr()}`);
}

/** `RAN <jobId> <worker>` lines: one per completed handler body (before settle). */
export function ranLines(w: SpawnedNode): Array<{ jobId: string; worker: string }> {
  return w.lines
    .filter((l) => l.startsWith('RAN '))
    .map((l) => {
      const [, jobId, worker] = l.split(' ');
      return { jobId: jobId!, worker: worker! };
    });
}

export function events(w: SpawnedNode): Array<Record<string, unknown>> {
  return w.lines.filter((l) => l.startsWith('EVENT ')).map((l) => JSON.parse(l.slice('EVENT '.length)) as Record<string, unknown>);
}

export async function seedJobs(
  db: PrismaClient,
  count: number,
  options: { type: string; prefix: string; payload?: Record<string, unknown>; serialKey?: string | null; maxAttempts?: number },
): Promise<string[]> {
  await db.job.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      type: options.type,
      payload: { ...(options.payload ?? {}), i },
      runAt: new Date(RUN_AT.getTime() + i),
      idempotencyKey: `${options.prefix}-${i}`,
      correlationId: `corr-${options.prefix}-${i}`,
      serialKey: options.serialKey ?? null,
      maxAttempts: options.maxAttempts ?? 5,
    })),
  });
  const rows = await db.job.findMany({ where: { idempotencyKey: { startsWith: `${options.prefix}-` } }, select: { id: true } });
  return rows.map((r) => r.id);
}

export async function setTestClockOffset(db: PrismaClient, offsetMs: number): Promise<void> {
  await db.testClock.upsert({
    where: { id: 1 },
    create: { id: 1, offsetMs: BigInt(offsetMs), frozenAt: null },
    update: { offsetMs: BigInt(offsetMs), frozenAt: null },
  });
}

export async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs: number, what: string): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (performance.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function makePauseDir(base: string): Promise<string> {
  const dir = path.join(base, 'pause');
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function waitPaused(dir: string, point: string, timeoutMs = 30_000): Promise<void> {
  await waitFor(async () => existsSync(path.join(dir, `${point}.reached.json`)), timeoutMs, `pause point ${point}`);
}

export async function releasePause(dir: string, point: string): Promise<void> {
  await writeFile(path.join(dir, `${point}.release`), 'go');
}

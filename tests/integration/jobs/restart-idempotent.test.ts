// T07: killing the worker 3 times mid-batch (taskkill /F, no shutdown hooks) and restarting gives the
// same end state as one uninterrupted run: every job SUCCEEDED once, one domain row per job.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { createTestDb, type TestDb } from '../../support/db';
import { terminate, terminateAll } from '../../support/spawn';
import { ranLines, seedJobs, spawnJobWorker, stopWorker, waitFor, waitReady, type WorkerTuning } from './support';

const JOBS = 30;
const TUNING: WorkerTuning = { leaseMs: 1_500, leaseExtendEveryMs: 400, idlePollMs: 30, backoff: { baseMs: 50, capMs: 200, jitterRatio: 0 } };

let single: TestDb;
let restarted: TestDb;

beforeAll(async () => {
  [single, restarted] = await Promise.all([createTestDb({ label: 'jobs-single' }), createTestDb({ label: 'jobs-restart' })]);
});

afterAll(async () => {
  await terminateAll();
  await Promise.all([single?.destroy(), restarted?.destroy()]);
});

type Counts = { succeeded: number; other: number; audits: number; distinctAuditTargets: number };

async function counts(db: PrismaClient): Promise<Counts> {
  const audits = await db.auditEvent.findMany({ where: { action: 'test.record' }, select: { targetId: true } });
  return {
    succeeded: await db.job.count({ where: { status: 'SUCCEEDED' } }),
    other: await db.job.count({ where: { status: { not: 'SUCCEEDED' } } }),
    audits: audits.length,
    distinctAuditTargets: new Set(audits.map((a) => a.targetId)).size,
  };
}

async function allDone(db: PrismaClient): Promise<boolean> {
  return (await db.job.count({ where: { status: 'SUCCEEDED' } })) === JOBS;
}

describe('restart idempotency', () => {
  it('3 hard restarts mid-batch end with the same counts as a single run', async () => {
    const singleDb = single.client();
    await seedJobs(singleDb, JOBS, { type: 'test.record', prefix: 'batch', payload: { sleepMs: 150 } });
    const one = spawnJobWorker(single.url, { name: 'single', tuning: TUNING });
    await waitReady(one);
    await waitFor(() => allDone(singleDb), 60_000, 'single run done');
    await stopWorker(one);
    const reference = await counts(singleDb);
    expect(reference).toEqual({ succeeded: JOBS, other: 0, audits: JOBS, distinctAuditTargets: JOBS });

    const db = restarted.client();
    await seedJobs(db, JOBS, { type: 'test.record', prefix: 'batch', payload: { sleepMs: 150 } });
    let kills = 0;
    for (const killAfter of [4, 6, 6]) {
      const w = spawnJobWorker(restarted.url, { name: `run${kills}`, tuning: TUNING });
      await waitReady(w);
      // Kill while a handler is in flight: after the Nth START line, before its settle.
      await w.waitForLine(() => w.lines.filter((l) => l.startsWith('START ')).length >= killAfter, 60_000);
      await terminate(w);
      kills++;
    }
    expect(kills).toBe(3);
    expect(await allDone(db)).toBe(false);
    // At least one job was left RUNNING by a killed worker (its lease must be reaped).
    const final = spawnJobWorker(restarted.url, { name: 'final', tuning: TUNING });
    await waitReady(final);
    await waitFor(() => allDone(db), 60_000, 'restarted run done');
    await stopWorker(final);

    expect(await counts(db)).toEqual(reference);
    const reclaimed = await db.job.count({ where: { attempts: { gt: 1 } } });
    expect(reclaimed).toBeGreaterThanOrEqual(1);
    expect(ranLines(final).length).toBeGreaterThan(0);
  });
});

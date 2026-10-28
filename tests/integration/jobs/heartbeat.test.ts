// T07 / plan §4.3: a job longer than its lease keeps it through lease extension (no double claim by
// a second worker's reaper), and the worker heartbeat row updates within 10 s.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { createTestDb, type TestDb } from '../../support/db';
import { terminateAll } from '../../support/spawn';
import { events, ranLines, seedJobs, spawnJobWorker, stopWorker, waitFor, waitReady } from './support';

let testDb: TestDb;
let db: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb({ label: 'jobs-heartbeat' });
  db = testDb.client();
});

afterAll(async () => {
  await terminateAll();
  await testDb?.destroy();
});

describe('lease extension and worker heartbeat', () => {
  it('extends the lease of a long job so another worker never reclaims it; heartbeat updates within 10 s', async () => {
    const [jobId] = await seedJobs(db, 1, { type: 'test.record', prefix: 'long', payload: { sleepMs: 6_000 } });

    // Lease 2 s, extended every 500 ms; the job runs 6 s (three lease lengths).
    const a = spawnJobWorker(testDb.url, { name: 'A', tuning: { leaseMs: 2_000, leaseExtendEveryMs: 500, idlePollMs: 50 } });
    await waitReady(a);
    await a.waitForLine((l) => l.startsWith(`START ${jobId}`), 30_000);

    // Both facts below exist only while the 6 s job runs (the heartbeat names the job from claim to
    // finish; the extended lease needs status RUNNING). Start observing them before B is spawned:
    // spawning a second worker can take seconds on a loaded host and would otherwise eat the window.
    const firstLease = (await db.job.findUniqueOrThrow({ where: { id: jobId } })).leaseUntil!;
    const observed = Promise.all([
      waitFor(
        async () => (await db.workerHeartbeat.findMany()).find((h) => h.currentJobId === jobId) ?? null,
        10_000,
        'heartbeat row naming the running job',
      ),
      waitFor(
        async () => {
          const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
          return job.status === 'RUNNING' && job.leaseUntil !== null && job.leaseUntil.getTime() > firstLease.getTime() + 1_000;
        },
        10_000,
        'lease extended',
      ),
    ]);
    observed.catch(() => undefined); // awaited below; this only prevents an unhandled rejection while B spawns

    const b = spawnJobWorker(testDb.url, { name: 'B', tuning: { leaseMs: 2_000, leaseExtendEveryMs: 500, idlePollMs: 50 } });
    await waitReady(b);

    const [beatA] = await observed;
    expect(beatA.pid).toBe(a.pid);
    expect(beatA.mode).toBe('DEMO');

    await waitFor(async () => (await db.job.findUniqueOrThrow({ where: { id: jobId } })).status === 'SUCCEEDED', 30_000, 'job done');
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.attempts).toBe(1);
    expect(await db.jobAttempt.count({ where: { jobId } })).toBe(1);
    expect(ranLines(a).map((r) => r.jobId)).toEqual([jobId]);
    expect(b.lines.filter((l) => l.startsWith('START '))).toEqual([]);
    expect(events(b).filter((e) => e.type === 'reaped')).toEqual([]);

    // Default heartbeat interval (10 s): the row's lastBeatAt advances within 10 s.
    await stopWorker(a);
    const c = spawnJobWorker(testDb.url, { name: 'C', tuning: { idlePollMs: 50 } });
    await waitReady(c);
    const first = await waitFor(async () => (await db.workerHeartbeat.findMany({ where: { pid: c.pid } }))[0] ?? null, 10_000, 'C first beat');
    const t0 = performance.now();
    const next = await waitFor(
      async () => {
        const row = await db.workerHeartbeat.findUnique({ where: { workerId: first.workerId } });
        return row && row.lastBeatAt.getTime() > first.lastBeatAt.getTime() ? row : null;
      },
      12_000,
      'C second beat',
    );
    expect(performance.now() - t0).toBeLessThanOrEqual(10_500);
    expect(next.startedAt.toISOString()).toBe(first.startedAt.toISOString());
    expect(next.version.length).toBeGreaterThan(0);
    await Promise.all([stopWorker(b), stopWorker(c)]);
  });
});

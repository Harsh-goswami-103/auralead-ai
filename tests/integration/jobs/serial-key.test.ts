// T07 / plan §4.3: jobs sharing a serialKey (per-conversation ordering) are never RUNNING together.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { claimJob } from '@/server/jobs/queue';
import { createTestDb, type TestDb } from '../../support/db';
import { terminateAll } from '../../support/spawn';
import { ranLines, seedJobs, spawnJobWorker, stopWorker, waitFor, waitReady } from './support';

let testDb: TestDb;
let db: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb({ label: 'jobs-serial' });
  db = testDb.client();
});

afterAll(async () => {
  await terminateAll();
  await testDb?.destroy();
});

describe('serialKey exclusivity', () => {
  it('the claim skips a serialKey that already has a RUNNING job', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    await seedJobs(db, 2, { type: 'test.serial', prefix: 'claim-conv', serialKey: 'conv-claim' });
    await seedJobs(db, 1, { type: 'test.serial', prefix: 'claim-free' });

    const first = await claimJob(db, { now, leaseMs: 60_000 });
    expect(first?.job.serialKey).toBe('conv-claim');
    const second = await claimJob(db, { now, leaseMs: 60_000 });
    expect(second?.job.serialKey).toBeNull();
    expect(await claimJob(db, { now, leaseMs: 60_000 })).toBeNull();

    // Once the first settles, its sibling becomes claimable.
    await db.job.update({ where: { id: first!.job.id }, data: { status: 'SUCCEEDED', claimToken: null, leaseUntil: null } });
    const third = await claimJob(db, { now, leaseMs: 60_000 });
    expect(third?.job.serialKey).toBe('conv-claim');
    expect(third?.job.id).not.toBe(first!.job.id);
    await db.job.updateMany({ where: { status: 'RUNNING' }, data: { status: 'SUCCEEDED', claimToken: null, leaseUntil: null } });
  });

  it('two worker processes never run two jobs of one serialKey at the same time', async () => {
    const serial = await seedJobs(db, 6, { type: 'test.serial', prefix: 'conv', serialKey: 'conv-1', payload: { sleepMs: 150 } });
    const free = await seedJobs(db, 6, { type: 'test.serial', prefix: 'free', payload: { sleepMs: 150 } });
    const total = await db.job.count();

    const tuning = { idlePollMs: 20, heartbeatEveryMs: 1_000 };
    const workers = ['A', 'B'].map((name) => spawnJobWorker(testDb.url, { name, tuning, waitForGo: true }));
    await Promise.all(workers.map(waitReady));
    for (const w of workers) w.send('GO');

    // Sample the DB while they run: never two RUNNING rows for conv-1.
    let maxConcurrent = 0;
    await waitFor(
      async () => {
        const running = await db.job.count({ where: { serialKey: 'conv-1', status: 'RUNNING' } });
        maxConcurrent = Math.max(maxConcurrent, running);
        return (await db.job.count({ where: { status: 'SUCCEEDED' } })) === total;
      },
      60_000,
      'all serial and free jobs SUCCEEDED',
    );
    await Promise.all(workers.map(stopWorker));

    expect(maxConcurrent).toBeLessThanOrEqual(1);
    for (const w of workers) expect(w.lines.filter((l) => l.startsWith('OVERLAP '))).toEqual([]);
    const ran = workers.flatMap(ranLines).map((r) => r.jobId);
    expect(new Set(ran)).toEqual(new Set([...serial, ...free]));
    expect(ran).toHaveLength(serial.length + free.length);
  });
});

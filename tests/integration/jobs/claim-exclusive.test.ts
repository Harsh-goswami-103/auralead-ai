// T07: two real worker processes drain 50 jobs; every job's handler runs exactly once.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { createTestDb, type TestDb } from '../../support/db';
import { terminateAll } from '../../support/spawn';
import { ranLines, seedJobs, spawnJobWorker, stopWorker, waitFor, waitReady } from './support';

const JOBS = 50;
let testDb: TestDb;
let db: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb({ label: 'jobs-claim' });
  db = testDb.client();
});

afterAll(async () => {
  await terminateAll();
  await testDb?.destroy();
});

describe('claim exclusivity across worker processes', () => {
  it(`runs each of ${JOBS} jobs exactly once with 2 workers`, async () => {
    const ids = await seedJobs(db, JOBS, { type: 'test.record', prefix: 'excl', payload: { sleepMs: 30 } });
    const tuning = { idlePollMs: 50, heartbeatEveryMs: 1_000 };
    const workers = ['A', 'B'].map((name) => spawnJobWorker(testDb.url, { name, tuning, waitForGo: true }));
    await Promise.all(workers.map(waitReady));
    for (const w of workers) w.send('GO');

    await waitFor(async () => (await db.job.count({ where: { status: 'SUCCEEDED' } })) === JOBS, 60_000, 'all jobs SUCCEEDED');
    await Promise.all(workers.map(stopWorker));

    const ran = workers.flatMap(ranLines);
    expect(ran).toHaveLength(JOBS);
    expect(new Set(ran.map((r) => r.jobId))).toEqual(new Set(ids));
    // Both processes really competed.
    expect(new Set(ran.map((r) => r.worker))).toEqual(new Set(['A', 'B']));

    const jobs = await db.job.findMany();
    expect(jobs.every((j) => j.status === 'SUCCEEDED' && j.attempts === 1 && j.finishedAt !== null)).toBe(true);
    expect(jobs.every((j) => j.claimToken === null && j.leaseUntil === null)).toBe(true);

    const attempts = await db.jobAttempt.findMany();
    expect(attempts).toHaveLength(JOBS);
    expect(attempts.every((a) => a.outcome === 'SUCCEEDED' && a.attemptNo === 1 && a.finishedAt !== null)).toBe(true);

    const audits = await db.auditEvent.findMany({ where: { action: 'test.record' } });
    expect(audits).toHaveLength(JOBS);
    expect(new Set(audits.map((a) => a.targetId))).toEqual(new Set(ids));

    // Both workers left a heartbeat row with no current job after a graceful stop.
    const beats = await db.workerHeartbeat.findMany();
    expect(beats).toHaveLength(2);
    expect(beats.every((b) => b.currentJobId === null && b.mode === 'DEMO')).toBe(true);
  });
});

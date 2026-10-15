// E5 / ADR-39 with a generic handler: worker A is paused right after its claim, its lease expires,
// worker B reclaims and completes the job, then A resumes. A's fenced transaction throws
// LeaseLostError, so none of A's domain writes exist and B's settle is untouched.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { createTestDb, type TestDb } from '../../support/db';
import { terminateAll } from '../../support/spawn';
import {
  events,
  makePauseDir,
  releasePause,
  seedJobs,
  setTestClockOffset,
  spawnJobWorker,
  stopWorker,
  waitFor,
  waitPaused,
  waitReady,
} from './support';

let testDb: TestDb;
let db: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb({ label: 'jobs-fencing' });
  db = testDb.client();
  await setTestClockOffset(db, 0);
});

afterAll(async () => {
  await terminateAll();
  await testDb?.destroy();
});

describe('lease fencing (E5)', () => {
  it('a resumed worker that lost its lease writes nothing', async () => {
    const [jobId] = await seedJobs(db, 1, { type: 'test.fenced', prefix: 'fence' });
    const pauseDir = await makePauseDir(testDb.dir);

    const a = spawnJobWorker(testDb.url, { name: 'A', tuning: { idlePollMs: 50 }, pause: { dir: pauseDir, points: ['job.claimed'] } });
    await waitReady(a);
    await waitPaused(pauseDir, 'job.claimed');
    const tokenA = (await db.job.findUniqueOrThrow({ where: { id: jobId } })).claimToken;
    expect(tokenA).toBeTruthy();

    // A's 60 s lease expires (shared DbOffsetClock), B reaps, reclaims and completes.
    await setTestClockOffset(db, 120_000);
    const b = spawnJobWorker(testDb.url, { name: 'B', tuning: { idlePollMs: 50, backoff: { baseMs: 100, capMs: 1_000, jitterRatio: 0 } } });
    await waitReady(b);
    await waitFor(async () => (await db.job.findUniqueOrThrow({ where: { id: jobId } })).status === 'SUCCEEDED', 30_000, 'B completes');
    await stopWorker(b);
    const afterB = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(afterB.attempts).toBe(2);
    expect(b.lines.some((l) => l.startsWith(`FENCED_WRITE_OK ${jobId} B`))).toBe(true);

    // A resumes from its pause point and runs the handler with its stale claim.
    await releasePause(pauseDir, 'job.claimed');
    await waitFor(async () => events(a).find((e) => e.type === 'lease-lost' && e.jobId === jobId) ?? null, 30_000, 'A reports lease lost');
    await stopWorker(a);

    expect(a.lines.some((l) => l.startsWith('FENCED_WRITE_OK'))).toBe(false);
    expect(a.lines.some((l) => l.startsWith('RAN'))).toBe(false);
    const audits = await db.auditEvent.findMany({ where: { targetId: jobId } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.summary).toMatchObject({ worker: 'B', attempt: 2 });

    // B's settle is unchanged by A.
    const final = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(final).toMatchObject({ status: 'SUCCEEDED', attempts: 2, claimToken: null });
    expect(final.updatedAt.toISOString()).toBe(afterB.updatedAt.toISOString());
    const attempts = await db.jobAttempt.findMany({ where: { jobId }, orderBy: { attemptNo: 'asc' } });
    expect(attempts.map((x) => [x.attemptNo, x.outcome])).toEqual([
      [1, 'LEASE_LOST'],
      [2, 'SUCCEEDED'],
    ]);
  });
});

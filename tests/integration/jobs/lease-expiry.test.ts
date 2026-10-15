// T07 / C8: a killed worker's job is reclaimed after its lease expires; the reaper never requeues
// a job holding a SENDING DispatchAttempt (AMBIGUOUS + DEAD instead).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { claimJob } from '@/server/jobs/queue';
import { reapExpiredLeases } from '@/server/jobs/reaper';
import { FixedClock } from '@/lib/clock';
import { createTestDb, type TestDb } from '../../support/db';
import { terminate, terminateAll } from '../../support/spawn';
import { createTenantGraph, type TenantGraph } from '../db/fixtures';
import {
  events,
  makePauseDir,
  ranLines,
  seedJobs,
  setTestClockOffset,
  spawnJobWorker,
  stopWorker,
  waitFor,
  waitPaused,
  waitReady,
} from './support';

const NO_JITTER = { baseMs: 1_000, capMs: 60_000, jitterRatio: 0 };
let testDb: TestDb;
let db: PrismaClient;
let graph: TenantGraph;

beforeAll(async () => {
  testDb = await createTestDb({ label: 'jobs-lease' });
  db = testDb.client();
  graph = await createTenantGraph(db, 'lease');
});

afterAll(async () => {
  await terminateAll();
  await testDb?.destroy();
});

describe('lease expiry after a crash (2 processes)', () => {
  it('SIGKILL worker A mid-job; past the lease, worker B reclaims and finishes with attempts 2', async () => {
    const [jobId] = await seedJobs(db, 1, { type: 'test.record', prefix: 'crash' });
    const pauseDir = await makePauseDir(testDb.dir);

    const a = spawnJobWorker(testDb.url, { name: 'A', tuning: { idlePollMs: 50 }, pause: { dir: pauseDir, points: ['job.claimed'] } });
    await waitReady(a);
    await waitPaused(pauseDir, 'job.claimed');
    const claimedByA = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(claimedByA).toMatchObject({ status: 'RUNNING', attempts: 1 });
    await terminate(a); // taskkill /F: no shutdown hooks run

    // Move every worker's clock past A's 60 s lease.
    await setTestClockOffset(db, 120_000);
    const b = spawnJobWorker(testDb.url, { name: 'B', tuning: { idlePollMs: 50, backoff: { baseMs: 100, capMs: 1_000, jitterRatio: 0 } } });
    await waitReady(b);
    await waitFor(async () => (await db.job.findUniqueOrThrow({ where: { id: jobId } })).status === 'SUCCEEDED', 30_000, 'B finishes the job');
    await stopWorker(b);

    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.attempts).toBe(2);
    expect(ranLines(a)).toHaveLength(0);
    expect(ranLines(b).map((r) => r.jobId)).toEqual([jobId]);
    expect(events(b).some((e) => e.type === 'reaped' && e.jobId === jobId && e.action === 'requeued')).toBe(true);

    const attempts = await db.jobAttempt.findMany({ where: { jobId }, orderBy: { attemptNo: 'asc' } });
    expect(attempts.map((x) => [x.attemptNo, x.outcome])).toEqual([
      [1, 'LEASE_LOST'],
      [2, 'SUCCEEDED'],
    ]);
    expect(await db.auditEvent.count({ where: { targetId: jobId } })).toBe(1);
  });
});

describe('reaper rules (in-process)', () => {
  async function runningJob(key: string, now: Date, leaseMs: number, extra: { maxAttempts?: number } = {}) {
    await db.job.create({
      data: {
        workspaceId: graph.workspaceId,
        type: 'test.reaper',
        payload: {},
        runAt: new Date(now.getTime() - 1),
        idempotencyKey: key,
        correlationId: `corr-${key}`,
        maxAttempts: extra.maxAttempts ?? 5,
      },
    });
    const claimed = await claimJob(db, { now, leaseMs });
    if (!claimed || claimed.job.idempotencyKey !== key) throw new Error(`expected to claim ${key}`);
    return claimed;
  }

  it('leaves unexpired leases alone and requeues expired ones with backoff', async () => {
    const clock = new FixedClock('2030-01-01T00:00:00.000Z');
    const claimed = await runningJob('reap-requeue', clock.now(), 60_000);

    clock.advance(59_000);
    expect(await reapExpiredLeases(db, { now: clock.now(), backoff: NO_JITTER })).toEqual([]);

    clock.advance(2_000);
    const reaped = await reapExpiredLeases(db, { now: clock.now(), backoff: NO_JITTER });
    expect(reaped).toEqual([{ jobId: claimed.job.id, action: 'requeued' }]);
    const job = await db.job.findUniqueOrThrow({ where: { id: claimed.job.id } });
    expect(job).toMatchObject({ status: 'QUEUED', claimToken: null, leaseUntil: null, lastErrorCode: 'LEASE_EXPIRED', attempts: 1 });
    expect(job.runAt.toISOString()).toBe(new Date(clock.now().getTime() + 1_000).toISOString());
    const attempt = await db.jobAttempt.findUniqueOrThrow({ where: { id: claimed.attemptId } });
    expect(attempt.outcome).toBe('LEASE_LOST');
    await db.job.update({ where: { id: job.id }, data: { status: 'CANCELLED' } });
  });

  it('marks DEAD instead of requeueing when the job is at max attempts', async () => {
    const clock = new FixedClock('2030-02-01T00:00:00.000Z');
    const claimed = await runningJob('reap-max', clock.now(), 1_000, { maxAttempts: 1 });
    clock.advance(5_000);
    expect(await reapExpiredLeases(db, { now: clock.now(), backoff: NO_JITTER })).toEqual([{ jobId: claimed.job.id, action: 'dead-max-attempts' }]);
    const job = await db.job.findUniqueOrThrow({ where: { id: claimed.job.id } });
    expect(job).toMatchObject({ status: 'DEAD', deadReason: 'MAX_ATTEMPTS', lastErrorCode: 'LEASE_EXPIRED', claimToken: null });
    expect(job.finishedAt?.toISOString()).toBe(clock.now().toISOString());
  });

  it('never requeues a job holding a SENDING DispatchAttempt: attempt AMBIGUOUS, job DEAD(AMBIGUOUS)', async () => {
    const clock = new FixedClock('2030-03-01T00:00:00.000Z');
    const claimed = await runningJob('reap-sending', clock.now(), 1_000);
    const attempt = await db.dispatchAttempt.create({
      data: {
        workspaceId: graph.workspaceId,
        messageId: graph.messageId,
        channel: 'WHATSAPP',
        attemptNo: 1,
        state: 'SENDING',
        sendIntent: 'MANUAL_SINGLE',
        initiatedBy: 'user-1',
        idempotencyKey: 'dispatch-reap-sending',
        jobId: claimed.job.id,
      },
    });
    clock.advance(5_000);
    expect(await reapExpiredLeases(db, { now: clock.now(), backoff: NO_JITTER })).toEqual([{ jobId: claimed.job.id, action: 'dead-ambiguous' }]);

    const job = await db.job.findUniqueOrThrow({ where: { id: claimed.job.id } });
    expect(job).toMatchObject({ status: 'DEAD', deadReason: 'AMBIGUOUS', claimToken: null, retrySafe: false });
    const after = await db.dispatchAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(after.state).toBe('AMBIGUOUS');
    expect(after.reasonCode).toBe('LEASE_EXPIRED');
    expect((await db.jobAttempt.findUniqueOrThrow({ where: { id: claimed.attemptId } })).outcome).toBe('AMBIGUOUS');

    // Nothing is claimable afterwards: the job is not silently retried.
    clock.advance(3_600_000);
    expect(await claimJob(db, { now: clock.now(), leaseMs: 1_000 })).toBeNull();
  });
});

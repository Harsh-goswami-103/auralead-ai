/**
 * C8, R6, AT12: a worker process is SIGKILLed (taskkill /F, no shutdown hooks) after it committed
 * SENDING and called the provider (paused at P3, before its settle). Once the lease expires the
 * reaper sets the attempt AMBIGUOUS, the Message "Delivery unknown" and the job DEAD(AMBIGUOUS);
 * the DEMO transport's outbox shows exactly 1 call, and nothing is requeued.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reapExpiredLeases } from '@/server/jobs/reaper';
import { terminate, terminateAll } from '../../support/spawn';
import { createProcessHarness, queueTemplateSend, spawnDispatchWorker, waOutbox, type ProcessHarness } from '../dispatch/process-support';
import { waitPaused } from './support';

let h: ProcessHarness;
beforeAll(async () => {
  h = await createProcessHarness('lease-expiry-send');
}, 120_000);
afterAll(async () => {
  await terminateAll();
  await h?.destroy();
});

describe('lease expiry after SENDING (C8)', () => {
  it('SIGKILL after the provider call: AMBIGUOUS, job DEAD(AMBIGUOUS), adapter call count 1', async () => {
    const r = await queueTemplateSend(h);
    const w = spawnDispatchWorker(h, { name: 'A', pausePoints: ['dispatch.p3'], tuning: { leaseMs: 3_000, leaseExtendEveryMs: 1_000 } });
    await w.waitForLine((l) => l === 'READY', 30_000);
    await waitPaused(h.pauseDir, 'dispatch.p3');
    expect((await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: r.attemptId } })).state).toBe('SENDING');
    expect(waOutbox(h)).toHaveLength(1);

    await terminate(w);
    const job = await h.db.job.findUniqueOrThrow({ where: { id: r.jobId } });
    expect(job.status).toBe('RUNNING');

    const reaped = await reapExpiredLeases(h.db, { now: new Date(job.leaseUntil!.getTime() + 1) });
    expect(reaped).toEqual([{ jobId: r.jobId, action: 'dead-ambiguous' }]);

    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: r.attemptId } })).toMatchObject({ state: 'AMBIGUOUS', reasonCode: 'LEASE_EXPIRED' });
    expect((await h.db.message.findUniqueOrThrow({ where: { id: r.messageId } })).status).toBe('UNKNOWN');
    expect(await h.db.job.findUniqueOrThrow({ where: { id: r.jobId } })).toMatchObject({ status: 'DEAD', deadReason: 'AMBIGUOUS', retrySafe: false });
    expect(await h.db.dispatchAttempt.count({ where: { messageId: r.messageId } })).toBe(1);
    expect(waOutbox(h)).toHaveLength(1);
  }, 120_000);
});

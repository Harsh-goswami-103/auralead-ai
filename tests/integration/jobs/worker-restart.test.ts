/**
 * AT12, R6 (no blind resend): a worker is killed at P3 (the provider was called, the settle did not
 * commit). A new worker process starts; when the old lease has expired (test clock moved forward)
 * its reaper turns the attempt AMBIGUOUS and the job DEAD(AMBIGUOUS). The restarted worker makes 0
 * extra provider calls and never creates attempt 2.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { terminate, terminateAll } from '../../support/spawn';
import { createProcessHarness, queueTemplateSend, spawnDispatchWorker, waOutbox, type ProcessHarness } from '../dispatch/process-support';
import { setTestClockOffset, stopWorker, waitFor, waitPaused } from './support';

let h: ProcessHarness;
beforeAll(async () => {
  h = await createProcessHarness('worker-restart-send');
}, 120_000);
afterAll(async () => {
  await terminateAll();
  await h?.destroy();
});

describe('worker restart after the provider call (AT12)', () => {
  it('kill at P3, restart: AMBIGUOUS, 0 extra calls', async () => {
    const r = await queueTemplateSend(h);
    const first = spawnDispatchWorker(h, { name: 'first', pausePoints: ['dispatch.p3'], tuning: { leaseMs: 60_000, leaseExtendEveryMs: 20_000 } });
    await first.waitForLine((l) => l === 'READY', 30_000);
    await waitPaused(h.pauseDir, 'dispatch.p3');
    expect(waOutbox(h)).toHaveLength(1);
    await terminate(first);

    // The restarted worker runs 2 minutes ahead (DEMO test clock), past the dead worker's lease.
    await setTestClockOffset(h.db, 120_000);
    const second = spawnDispatchWorker(h, { name: 'second' });
    await second.waitForLine((l) => l === 'READY', 30_000);
    await waitFor(async () => (await h.db.job.findUniqueOrThrow({ where: { id: r.jobId } })).status === 'DEAD', 30_000, 'job DEAD after restart');
    // Give the restarted worker a few more loop iterations to prove it does not resend.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await stopWorker(second);

    expect(await h.db.job.findUniqueOrThrow({ where: { id: r.jobId } })).toMatchObject({ status: 'DEAD', deadReason: 'AMBIGUOUS' });
    expect(await h.db.dispatchAttempt.findMany({ where: { messageId: r.messageId } })).toEqual([expect.objectContaining({ id: r.attemptId, state: 'AMBIGUOUS' })]);
    expect((await h.db.message.findUniqueOrThrow({ where: { id: r.messageId } })).status).toBe('UNKNOWN');
    expect(waOutbox(h)).toHaveLength(1);
    expect(second.lines.some((l) => l.includes('"type":"reaped"') && l.includes('dead-ambiguous'))).toBe(true);
  }, 120_000);
});

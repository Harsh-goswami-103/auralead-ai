/**
 * E5 (ADR-39): worker A is paused at P1 right after its claim; its lease expires; worker B (its own
 * DB client) reaps, reclaims and completes the send. When A resumes, its preflight transaction
 * throws LeaseLostError at the fence: the provider call count stays 1 and A writes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@/lib/logger';
import { buildJobRegistry } from '@/server/jobs/registry';
import type { JobEvent } from '@/server/jobs/types';
import { setPauseHandler } from '@/server/testing/pause';
import { approveAndSendQuote } from '@/server/services/messaging/dispatch';
import { createWorker } from '../../../worker/worker';
import { createDispatchHarness, DEPS, eligibleLead, quoteWithPdf, type DispatchHarness } from './support';

let h: DispatchHarness;
beforeAll(async () => {
  h = await createDispatchHarness('lease-fencing-send');
}, 120_000);
afterAll(async () => {
  setPauseHandler('dispatch.p1', null);
  await h?.destroy();
});

describe('lease fencing on the send path (E5)', () => {
  it("A's preflight after losing its lease throws LeaseLostError; 1 provider call; no writes from A", async () => {
    const lead = await eligibleLead(h.db);
    const { quote } = await quoteWithPdf(h, lead.id);
    const r = await approveAndSendQuote(await h.owner(), { quoteId: quote.id, expectedVersion: 1, channel: 'EMAIL' }, DEPS);

    const tuning = { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } };
    const eventsA: JobEvent[] = [];
    const workerA = createWorker(
      { db: h.testDb.client(), clock: h.clock, registry: buildJobRegistry(h.defs), logger: createLogger({ level: 'silent' }), mode: 'demo', version: 'test', workerId: 'A', random: () => 0, onEvent: (e) => eventsA.push(e) },
      tuning,
    );
    const workerB = createWorker(
      { db: h.testDb.client(), clock: h.clock, registry: buildJobRegistry(h.defs), logger: createLogger({ level: 'silent' }), mode: 'demo', version: 'test', workerId: 'B', random: () => 0 },
      tuning,
    );

    let hold = true;
    let release: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const atP1 = new Promise<void>((resolve) => (reached = resolve));
    setPauseHandler('dispatch.p1', async () => {
      if (!hold) return;
      hold = false;
      reached();
      await new Promise<void>((resolve) => (release = resolve));
    });

    const runningA = workerA.tick();
    await atP1;
    const auditBefore = await h.db.auditEvent.count();

    h.clock.advance(61_000); // A's lease is gone
    await workerB.tick(); // reaper requeues A's job (no SENDING attempt yet)
    expect((await h.db.job.findUniqueOrThrow({ where: { id: r.jobId } })).status).toBe('QUEUED');
    h.clock.advance(2_000);
    expect(await workerB.tick()).toBe('ran'); // B claims, preflights, sends, settles
    expect(h.email.calls).toHaveLength(1);
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: r.attemptId } })).toMatchObject({ state: 'SENT' });
    const auditAfterB = await h.db.auditEvent.count();

    release();
    await runningA;
    expect(eventsA.some((e) => e.type === 'lease-lost')).toBe(true);
    expect(h.email.calls).toHaveLength(1);
    expect(await h.db.auditEvent.count()).toBe(auditAfterB);
    expect(auditAfterB).toBeGreaterThan(auditBefore);
    expect(await h.db.dispatchAttempt.count({ where: { messageId: r.messageId } })).toBe(1);
    expect(await h.db.job.findUniqueOrThrow({ where: { id: r.jobId } })).toMatchObject({ status: 'SUCCEEDED' });
    const attemptsLog = await h.db.jobAttempt.findMany({ where: { jobId: r.jobId }, orderBy: { attemptNo: 'asc' } });
    expect(attemptsLog.map((a) => a.outcome)).toEqual(['LEASE_LOST', 'SUCCEEDED']);
  }, 60_000);
});

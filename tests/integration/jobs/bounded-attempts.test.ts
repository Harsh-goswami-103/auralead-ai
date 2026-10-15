// T07 / plan §4.3, §6.2: retry with growing backoff, DEAD at max attempts with a redacted error,
// fatal errors die at once, deferrals refund the attempt, unknown types and payload versions die.
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { ProviderUnavailableError, ValidationError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { enqueueJob } from '@/server/jobs/queue';
import { JobRegistry } from '@/server/jobs/registry';
import type { JobEvent } from '@/server/jobs/types';
import { createWorker, type Worker } from '../../../worker/worker';
import { createTestDb, type TestDb } from '../../support/db';

const PHONE = '+919812345678';
const EMAIL = 'owner@example.com';
const API_KEY = 'sk-ant-api03-SECRETSECRETSECRET';

let testDb: TestDb;
let db: PrismaClient;
let clock: FixedClock;
let worker: Worker;
let eventsSeen: JobEvent[];
let logText: string;
let flakyCalls: number;

const registry = new JobRegistry();
registry.register({
  type: 'test.flaky',
  kind: 'default',
  payloadVersions: [1],
  async handler() {
    flakyCalls++;
    throw new ProviderUnavailableError({ message: `upstream 503 while messaging ${PHONE} / ${EMAIL} with key ${API_KEY}` });
  },
});
registry.register({
  type: 'test.ai-flaky',
  kind: 'ai',
  payloadVersions: [1],
  async handler() {
    throw new ProviderUnavailableError({ message: 'model overloaded' });
  },
});
registry.register({
  type: 'test.fatal',
  kind: 'default',
  payloadVersions: [1],
  async handler() {
    throw new ValidationError({ message: `bad payload for ${PHONE}` });
  },
});
registry.register({
  type: 'test.defer',
  kind: 'default',
  payloadVersions: [1],
  async handler(ctx) {
    const payload = ctx.job.payload as { deferred?: boolean };
    if (ctx.job.attempts === 1 && !payload.deferred) {
      return { outcome: 'deferred', runAt: new Date(ctx.clock.now().getTime() + 30_000), reason: 'OUTBOUND_PAUSED' };
    }
    return { outcome: 'succeeded' };
  },
});
registry.register({
  type: 'test.retry-after',
  kind: 'send',
  payloadVersions: [1],
  async handler() {
    return { outcome: 'retry', errorCode: 'PROVIDER_RATE_LIMITED', error: 'HTTP 429', retryAfterMs: 90_000 };
  },
});
registry.register({
  type: 'test.v2only',
  kind: 'default',
  payloadVersions: [2],
  async handler() {
    return { outcome: 'succeeded' };
  },
});

beforeAll(async () => {
  testDb = await createTestDb({ label: 'jobs-bounded' });
  db = testDb.client();
});

afterAll(async () => {
  await testDb?.destroy();
});

beforeEach(async () => {
  await db.jobAttempt.deleteMany();
  await db.job.deleteMany();
  clock = new FixedClock('2030-01-01T00:00:00.000Z');
  eventsSeen = [];
  logText = '';
  flakyCalls = 0;
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logText += chunk.toString('utf8');
      cb();
    },
  });
  worker = createWorker(
    {
      db,
      clock,
      registry,
      logger: createLogger({ level: 'info', destination }),
      mode: 'demo',
      version: 'test',
      random: () => 0,
      onEvent: (e) => eventsSeen.push(e),
    },
    { backoff: { baseMs: 1_000, capMs: 600_000, jitterRatio: 0.2 } },
  );
});

async function enqueue(type: string, key: string, kind?: 'ai' | 'send', payloadVersion = 1) {
  const { job } = await enqueueJob(db, clock, {
    type,
    payload: {},
    payloadVersion,
    workspaceId: null,
    idempotencyKey: key,
    correlationId: `corr-${key}`,
    kind,
  });
  return job;
}

describe('bounded attempts', () => {
  it('backs off with growing delays and goes DEAD at max attempts with a redacted error', async () => {
    const job = await enqueue('test.flaky', 'flaky-1');
    expect(job.maxAttempts).toBe(5);

    const delays: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await worker.tick()).toBe('ran');
      const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
      expect(row.attempts).toBe(attempt);
      if (attempt < 5) {
        expect(row.status).toBe('QUEUED');
        expect(row.claimToken).toBeNull();
        const delay = row.runAt.getTime() - clock.now().getTime();
        delays.push(delay);
        // Not claimable before runAt.
        clock.advance(delay - 1);
        expect(await worker.tick()).toBe('idle');
        clock.advance(1);
      } else {
        expect(row.status).toBe('DEAD');
        expect(row.deadReason).toBe('MAX_ATTEMPTS');
        expect(row.lastErrorCode).toBe('PROVIDER_UNAVAILABLE');
        expect(row.finishedAt?.toISOString()).toBe(clock.now().toISOString());
        expect(row.lastErrorRedacted).toContain('upstream 503');
        for (const secret of [PHONE, '9812345678', EMAIL, API_KEY]) expect(row.lastErrorRedacted).not.toContain(secret);
      }
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(flakyCalls).toBe(5);

    // DEAD is terminal: no automatic transition out of it.
    clock.advance(86_400_000);
    expect(await worker.tick()).toBe('idle');
    expect(flakyCalls).toBe(5);

    const attempts = await db.jobAttempt.findMany({ where: { jobId: job.id }, orderBy: { attemptNo: 'asc' } });
    expect(attempts.map((a) => a.attemptNo)).toEqual([1, 2, 3, 4, 5]);
    expect(attempts.every((a) => a.outcome === 'RETRYABLE' && a.errorCode === 'PROVIDER_UNAVAILABLE')).toBe(true);
    for (const a of attempts) for (const secret of [PHONE, EMAIL, API_KEY]) expect(a.errorRedacted).not.toContain(secret);

    expect(eventsSeen.filter((e) => e.type === 'retry')).toHaveLength(4);
    expect(eventsSeen.filter((e) => e.type === 'dead')).toHaveLength(1);
    for (const secret of [PHONE, EMAIL, API_KEY]) expect(logText).not.toContain(secret);
  });

  it('uses the per-kind maximum (ai: 3)', async () => {
    const job = await enqueue('test.ai-flaky', 'ai-1', 'ai');
    expect(job.maxAttempts).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(await worker.tick()).toBe('ran');
      clock.advance(3_600_000);
    }
    const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: 'DEAD', attempts: 3, deadReason: 'MAX_ATTEMPTS' });
  });

  it('a non-retryable error goes DEAD after one attempt', async () => {
    const job = await enqueue('test.fatal', 'fatal-1');
    expect(await worker.tick()).toBe('ran');
    const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: 'DEAD', attempts: 1, deadReason: 'FATAL', lastErrorCode: 'VALIDATION_FAILED' });
    expect(row.lastErrorRedacted).not.toContain(PHONE);
    expect((await db.jobAttempt.findFirstOrThrow({ where: { jobId: job.id } })).outcome).toBe('FATAL');
  });

  it('a deferral requeues later and refunds the attempt counter', async () => {
    const job = await enqueue('test.defer', 'defer-1');
    expect(await worker.tick()).toBe('ran');
    let row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: 'QUEUED', attempts: 0, claimToken: null, lastErrorCode: 'OUTBOUND_PAUSED' });
    expect(row.runAt.toISOString()).toBe(new Date(clock.now().getTime() + 30_000).toISOString());
    await db.job.update({ where: { id: job.id }, data: { payload: { deferred: true } } });

    clock.advance(30_000);
    expect(await worker.tick()).toBe('ran');
    row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
    const attempts = await db.jobAttempt.findMany({ where: { jobId: job.id }, orderBy: { attemptNo: 'asc' } });
    expect(attempts.map((a) => [a.attemptNo, a.outcome])).toEqual([
      [1, 'DEFERRED'],
      [2, 'SUCCEEDED'],
    ]);
  });

  it('a retry result honors Retry-After when it is longer than the backoff', async () => {
    const job = await enqueue('test.retry-after', 'ra-1', 'send');
    expect(job.maxAttempts).toBe(5);
    expect(await worker.tick()).toBe('ran');
    const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: 'QUEUED', attempts: 1, lastErrorCode: 'PROVIDER_RATE_LIMITED' });
    expect(row.runAt.getTime() - clock.now().getTime()).toBe(90_000);
  });

  it('unknown job types and unknown payload versions go DEAD without running', async () => {
    const unknown = await enqueue('test.nobody-handles-this', 'unknown-1');
    const v1 = await enqueue('test.v2only', 'v1-1');
    expect(await worker.tick()).toBe('ran');
    expect(await worker.tick()).toBe('ran');
    expect(await db.job.findUniqueOrThrow({ where: { id: unknown.id } })).toMatchObject({ status: 'DEAD', deadReason: 'UNKNOWN_JOB_TYPE' });
    expect(await db.job.findUniqueOrThrow({ where: { id: v1.id } })).toMatchObject({ status: 'DEAD', deadReason: 'UNKNOWN_PAYLOAD_VERSION' });
  });

  it('enqueue is idempotent by idempotencyKey', async () => {
    const first = await enqueueJob(db, clock, { type: 'test.defer', payload: { a: 1 }, workspaceId: null, idempotencyKey: 'dup-1', correlationId: 'c1' });
    const second = await enqueueJob(db, clock, { type: 'test.defer', payload: { a: 2 }, workspaceId: null, idempotencyKey: 'dup-1', correlationId: 'c2' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(await db.job.count({ where: { idempotencyKey: 'dup-1' } })).toBe(1);
  });

  it('cancelRequestedAt observed before the handler runs cancels the job', async () => {
    const job = await enqueue('test.flaky', 'cancel-1');
    await db.job.update({ where: { id: job.id }, data: { cancelRequestedAt: clock.now() } });
    expect(await worker.tick()).toBe('ran');
    expect(flakyCalls).toBe(0);
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'CANCELLED', attempts: 1 });
  });
});

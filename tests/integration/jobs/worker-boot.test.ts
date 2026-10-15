// T07 / plan §4.3: the worker refuses to start with pending migrations, and a graceful stop stops
// claiming but finishes the job in flight.
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { createLogger } from '@/lib/logger';
import { enqueueJob } from '@/server/jobs/queue';
import { JobRegistry } from '@/server/jobs/registry';
import { findPendingMigrations } from '../../../worker/migrations';
import { createWorker } from '../../../worker/worker';
import { createTestDb, type TestDb } from '../../support/db';
import { REPO_ROOT, terminateAll } from '../../support/spawn';
import { spawnJobWorker, waitFor } from './support';

const MIGRATIONS = path.join(REPO_ROOT, 'prisma', 'migrations');
let migrated: TestDb;
let empty: TestDb;

beforeAll(async () => {
  [migrated, empty] = await Promise.all([createTestDb({ label: 'boot-ok' }), createTestDb({ label: 'boot-empty', migrate: false })]);
});

afterAll(async () => {
  await terminateAll();
  await Promise.all([migrated?.destroy(), empty?.destroy()]);
});

describe('pending migration refusal', () => {
  it('reports no pending migrations on a migrated DB and all of them on an empty one', async () => {
    expect(await findPendingMigrations(migrated.client(), MIGRATIONS)).toEqual([]);
    const pending = await findPendingMigrations(empty.client(), MIGRATIONS);
    expect(pending.length).toBeGreaterThanOrEqual(2);
    expect(pending).toContain('20261015170634_init_jobs');
  });

  it('the worker process exits 1 without claiming against an unmigrated DB', async () => {
    const w = spawnJobWorker(empty.url, { name: 'X' });
    const exit = await w.waitForExit(30_000);
    expect(exit.code).toBe(1);
    expect(w.lines).not.toContain('READY');
    expect(`${w.stderr()}\n${w.lines.join('\n')}`).toMatch(/pending migrations/i);
  });
});

describe('graceful stop', () => {
  it('stops claiming and finishes the job in flight', async () => {
    const db: PrismaClient = migrated.client();
    const clock = new FixedClock('2030-01-01T00:00:00.000Z');
    const registry = new JobRegistry();
    let started = 0;
    registry.register({
      type: 'test.slow',
      kind: 'default',
      payloadVersions: [1],
      async handler() {
        started++;
        await sleep(600);
        return { outcome: 'succeeded' };
      },
    });
    const first = await enqueueJob(db, clock, { type: 'test.slow', payload: {}, workspaceId: null, idempotencyKey: 'slow-1', correlationId: 'c1' });
    const second = await enqueueJob(db, clock, { type: 'test.slow', payload: {}, workspaceId: null, idempotencyKey: 'slow-2', correlationId: 'c2' });

    const worker = createWorker(
      { db, clock, registry, logger: createLogger({ level: 'silent' }), mode: 'demo', version: 'test' },
      { idlePollMs: 20, heartbeatEveryMs: 60_000 },
    );
    const running = worker.run();
    await waitFor(async () => started === 1, 10_000, 'first job started');
    await worker.stop('test');
    await running;

    expect((await db.job.findUniqueOrThrow({ where: { id: first.job.id } })).status).toBe('SUCCEEDED');
    expect((await db.job.findUniqueOrThrow({ where: { id: second.job.id } })).status).toBe('QUEUED');
    expect(started).toBe(1);
    const beat = await db.workerHeartbeat.findUniqueOrThrow({ where: { workerId: worker.workerId } });
    expect(beat.currentJobId).toBeNull();
  });
});

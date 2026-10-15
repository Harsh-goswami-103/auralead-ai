// T02 spike: the single-statement claim is exclusive across two OS processes on one SQLite file.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../support/db';
import { spawnTsx, terminateAll, type SpawnedNode } from '../../support/spawn';

const JOBS = 200;
const WORKER = path.resolve(import.meta.dirname, 'fixtures', 'claim-worker.ts');

type WorkerResult = { workerId: string; pid: number; claimed: string[]; busyErrors: number; lostRaces: number };

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb({ label: 'claim' });
  const prisma = db.client();
  const runAt = new Date('2026-01-01T00:00:00.000Z');
  await prisma.job.createMany({
    data: Array.from({ length: JOBS }, (_, i) => ({
      type: 'spike.noop',
      payload: { i },
      priority: i % 3,
      runAt: new Date(runAt.getTime() + i),
      idempotencyKey: `spike-claim-${i}`,
      correlationId: `corr-${i}`,
    })),
  });
});

afterAll(async () => {
  await terminateAll();
  await db?.destroy();
});

describe('two-process claim', () => {
  it(`claims ${JOBS} jobs exactly once across 2 processes with no lost jobs and no SQLITE_BUSY`, async () => {
    const workers: SpawnedNode[] = ['A', 'B'].map((id) =>
      spawnTsx(WORKER, { env: { DATABASE_URL: db.url, WORKER_ID: id } }),
    );
    expect(new Set(workers.map((w) => w.pid)).size).toBe(2);
    expect(workers.every((w) => w.pid !== process.pid)).toBe(true);

    await Promise.all(workers.map((w) => w.waitForLine((l) => l === 'READY', 30_000)));
    for (const w of workers) w.send('GO');

    const exits = await Promise.all(workers.map((w) => w.waitForExit(60_000)));
    for (const [i, exit] of exits.entries()) {
      expect(exit, `worker ${i} stderr: ${workers[i]!.stderr()}`).toEqual({ code: 0, signal: null });
    }

    const results: WorkerResult[] = workers.map((w) => {
      const line = w.lines.find((l) => l.startsWith('RESULT '));
      if (!line) throw new Error(`no RESULT from pid ${w.pid}; stderr: ${w.stderr()}`);
      return JSON.parse(line.slice('RESULT '.length)) as WorkerResult;
    });

    const all = results.flatMap((r) => r.claimed);
    expect(all).toHaveLength(JOBS);
    expect(new Set(all).size).toBe(JOBS);
    // Both processes really competed (each won some claims).
    for (const r of results) expect(r.claimed.length).toBeGreaterThan(0);
    expect(results.reduce((n, r) => n + r.busyErrors, 0)).toBe(0);

    const prisma = db.client();
    expect(await prisma.job.count({ where: { status: 'QUEUED' } })).toBe(0);
    expect(await prisma.job.count({ where: { status: 'RUNNING', attempts: 1 } })).toBe(JOBS);
    const rows = await prisma.job.findMany({ select: { id: true, claimToken: true, leaseUntil: true, startedAt: true } });
    expect(new Set(rows.map((r) => r.claimToken)).size).toBe(JOBS);
    expect(rows.every((r) => r.leaseUntil instanceof Date && r.startedAt instanceof Date)).toBe(true);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(all));

    console.info(
      `[T02 spike] claims per process: ${results.map((r) => `${r.workerId}=${r.claimed.length}`).join(', ')}; ` +
        `lost races: ${results.map((r) => `${r.workerId}=${r.lostRaces}`).join(', ')}; busy errors: 0`,
    );
  });
});

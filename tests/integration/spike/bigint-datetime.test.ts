// T02 spike: BigInt and DateTime representations agree between Prisma-typed queries and raw SQL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { claimNextJob } from '@/server/db/raw/claim-job';
import { createTestDb, type TestDb } from '../../support/db';

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await createTestDb({ label: 'bigint-dt' });
  prisma = db.client();
});

afterAll(async () => {
  await db?.destroy();
});

const T = (iso: string) => new Date(iso);

async function makeJob(key: string, runAt: Date) {
  return prisma.job.create({
    data: { type: 'spike.noop', payload: {}, runAt, idempotencyKey: key, correlationId: key },
  });
}

describe('BigInt round trip through the adapter', () => {
  // `BIGINT` is the column type Prisma emits for a `BigInt` field on SQLite (checked with
  // `prisma migrate diff` in T02), so this is how every *Paise column behaves.
  it('10^11 and 2^53 + 1 in a BIGINT column survive a raw write and read as exact bigint values', async () => {
    await prisma.$executeRawUnsafe('CREATE TABLE "SpikeMoney" ("id" INTEGER PRIMARY KEY, "paise" BIGINT NOT NULL)');
    const values = [10n ** 11n, 2n ** 53n + 1n, -(10n ** 11n)];
    for (const [i, v] of values.entries()) {
      await prisma.$executeRaw`INSERT INTO "SpikeMoney" ("id", "paise") VALUES (${i + 1}, ${v})`;
    }
    const rows = await prisma.$queryRaw<Array<{ id: unknown; paise: unknown }>>`SELECT "id", "paise" FROM "SpikeMoney" ORDER BY "id"`;
    expect(rows.map((r) => r.paise)).toEqual(values);
    expect(rows.every((r) => typeof r.paise === 'bigint')).toBe(true);

    const [sum] = await prisma.$queryRaw<Array<{ total: unknown }>>`SELECT SUM("paise") AS total FROM "SpikeMoney"`;
    expect(sum?.total).toBe(2n ** 53n + 1n);

    const [bound] = await prisma.$queryRaw<Array<{ v: unknown }>>`SELECT ${10n ** 11n} * 3 AS v`;
    expect(bound?.v).toBe(3n * 10n ** 11n);
  });

  it('storage is exact, but raw reads of INTEGER-declared columns (Prisma Int) come back as number', async () => {
    await prisma.$executeRawUnsafe('CREATE TABLE "SpikeInt" ("id" INTEGER PRIMARY KEY, "n" INTEGER NOT NULL)');
    const big = 2n ** 53n + 1n;
    await prisma.$executeRaw`INSERT INTO "SpikeInt" ("id", "n") VALUES (1, ${big})`;
    const [row] = await prisma.$queryRaw<Array<{ n: unknown; exact: unknown; asBigint: unknown }>>`
      SELECT "n", CAST("n" AS TEXT) AS exact, CAST("n" AS BIGINT) AS asBigint FROM "SpikeInt"`;
    expect(row?.exact).toBe(big.toString());
    expect(typeof row?.n).toBe('number');
    expect(row?.asBigint).toBe(big);
  });
});

describe('DateTime: raw-bound Date vs Prisma-written runAt', () => {
  it('Prisma stores runAt in the same ISO-8601 representation raw SQL binds a Date as', async () => {
    const job = await makeJob('dt-format', T('2026-10-15T10:00:00.000Z'));
    const [row] = await prisma.$queryRaw<Array<{ stored: string; bound: string }>>`
      SELECT CAST("runAt" AS TEXT) AS stored, CAST(${T('2026-10-15T10:00:00.000Z')} AS TEXT) AS bound FROM "Job" WHERE "id" = ${job.id}`;
    expect(row?.stored).toBe('2026-10-15T10:00:00.000+00:00');
    expect(row?.bound).toBe(row?.stored);
  });

  it('comparisons at millisecond boundaries match JS Date comparisons', async () => {
    const instants = [
      '2025-12-31T23:59:59.999Z',
      '2026-01-01T00:00:00.000Z',
      '2026-10-15T09:59:59.999Z',
      '2026-10-15T10:00:00.000Z',
      '2026-10-15T10:00:00.001Z',
      '2027-03-01T05:30:00.000Z',
    ].map(T);
    for (const [i, at] of instants.entries()) await makeJob(`dt-cmp-${i}`, at);

    const probes = [
      ...instants,
      ...instants.map((d) => new Date(d.getTime() - 1)),
      ...instants.map((d) => new Date(d.getTime() + 1)),
      T('2000-01-01T00:00:00.000Z'),
      T('2100-01-01T00:00:00.000Z'),
    ];
    const prefix = 'dt-cmp-%';
    for (const probe of probes) {
      const [rawCount] = await prisma.$queryRaw<Array<{ n: unknown }>>`
        SELECT COUNT(*) AS n FROM "Job" WHERE "idempotencyKey" LIKE ${prefix} AND "runAt" <= ${probe}`;
      const typedCount = await prisma.job.count({ where: { idempotencyKey: { startsWith: 'dt-cmp-' }, runAt: { lte: probe } } });
      const expected = instants.filter((d) => d.getTime() <= probe.getTime()).length;
      expect({ probe: probe.toISOString(), raw: Number(rawCount?.n), typed: typedCount }).toEqual({
        probe: probe.toISOString(),
        raw: expected,
        typed: expected,
      });
    }
  });

  it('the raw claim honors runAt and writes dates the typed client reads back exactly', async () => {
    await prisma.job.updateMany({ where: { status: 'QUEUED' }, data: { status: 'CANCELLED' } });
    const runAt = T('2026-10-15T12:00:00.000Z');
    const job = await makeJob('dt-claim', runAt);

    const early = T('2026-10-15T11:59:59.999Z');
    await expect(claimNextJob(prisma, { now: early, leaseUntil: T('2026-10-15T12:01:00.000Z'), claimToken: 'tok-early' })).resolves.toBeNull();

    const now = T('2026-10-15T12:00:00.000Z');
    const leaseUntil = T('2026-10-15T12:01:00.000Z');
    const claimed = await claimNextJob(prisma, { now, leaseUntil, claimToken: 'tok-1' });
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(job.id);
    expect(claimed!.runAt).toEqual(runAt);
    expect(claimed!.leaseUntil).toEqual(leaseUntil);
    expect(claimed!.startedAt).toEqual(now);
    expect(claimed!.claimToken).toBe('tok-1');
    expect(claimed!.attempts).toBe(1);

    const typed = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(typed.status).toBe('RUNNING');
    expect(typed.leaseUntil).toEqual(leaseUntil);
    expect(typed.startedAt).toEqual(now);
    expect(typed.updatedAt).toEqual(now);
    expect(typed.claimToken).toBe('tok-1');

    await expect(claimNextJob(prisma, { now, leaseUntil, claimToken: 'tok-2' })).resolves.toBeNull();
  });

  it('the raw claim skips a serialKey that already has a RUNNING job', async () => {
    await prisma.job.updateMany({ where: { status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'CANCELLED' } });
    const at = T('2026-10-16T00:00:00.000Z');
    const a = await prisma.job.create({
      data: { type: 'spike.noop', payload: {}, runAt: at, idempotencyKey: 'serial-a', correlationId: 'a', serialKey: 'conv-1' },
    });
    const b = await prisma.job.create({
      data: { type: 'spike.noop', payload: {}, runAt: new Date(at.getTime() + 1), idempotencyKey: 'serial-b', correlationId: 'b', serialKey: 'conv-1' },
    });
    const now = T('2026-10-16T00:01:00.000Z');
    const lease = T('2026-10-16T00:02:00.000Z');
    expect((await claimNextJob(prisma, { now, leaseUntil: lease, claimToken: 's1' }))?.id).toBe(a.id);
    await expect(claimNextJob(prisma, { now, leaseUntil: lease, claimToken: 's2' })).resolves.toBeNull();
    await prisma.job.update({ where: { id: a.id }, data: { status: 'SUCCEEDED' } });
    expect((await claimNextJob(prisma, { now, leaseUntil: lease, claimToken: 's3' }))?.id).toBe(b.id);
  });
});

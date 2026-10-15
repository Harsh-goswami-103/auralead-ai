/**
 * T03: withTx retries a transaction that hits SQLITE_BUSY and raises DbBusyError after the last
 * attempt. Contention comes from a second, independent connection (node:sqlite) holding
 * `BEGIN IMMEDIATE`; the Prisma adapter keeps one connection per client, so a second Prisma
 * client in-process would only queue on the adapter mutex (T02 note).
 *
 * The Prisma connection's busy_timeout is lowered from 5000 ms to 150 ms for this file so the
 * busy path takes milliseconds; the retry logic is the same.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { DbBusyError, isBusyError, withTx } from '@/server/db/tx';
import { createTestDb, type TestDb } from '../../support/db';
import { createTenantGraph, type TenantGraph } from './fixtures';

let testDb: TestDb;
let db: PrismaClient;
let a: TenantGraph;
const holders: DatabaseSync[] = [];

function openHolder(): DatabaseSync {
  const conn = new DatabaseSync(testDb.file);
  conn.exec('PRAGMA busy_timeout = 0');
  holders.push(conn);
  return conn;
}

function release(conn: DatabaseSync): void {
  if (conn.isTransaction) conn.exec('ROLLBACK');
}

beforeAll(async () => {
  testDb = await createTestDb({ label: 'with-tx-retry' });
  db = testDb.client();
  a = await createTenantGraph(db, 'alpha');
  await db.$queryRawUnsafe('PRAGMA busy_timeout = 150');
});

afterEach(() => {
  for (const conn of holders.splice(0)) {
    release(conn);
    conn.close();
  }
});

afterAll(async () => {
  await testDb?.destroy();
});

const noBackoff = { backoffMs: () => 0 };

function serviceData(code: string) {
  return { workspaceId: a.workspaceId, code, name: code, description: code, unitLabel: 'unit' };
}

describe('withTx busy retry', () => {
  it('retries after SQLITE_BUSY from a connection holding BEGIN IMMEDIATE, then succeeds', async () => {
    const holder = openHolder();
    holder.exec('BEGIN IMMEDIATE');
    const retries: number[] = [];
    let calls = 0;

    const created = await withTx(
      db,
      async (tx) => {
        calls += 1;
        return tx.service.create({ data: serviceData('RETRY_OK') });
      },
      {
        ...noBackoff,
        onRetry: ({ attempt, error }) => {
          expect(isBusyError(error)).toBe(true);
          retries.push(attempt);
          release(holder); // the other writer finishes while we back off
        },
      },
    );

    expect(retries).toEqual([1]);
    // The busy error hit the up-front write lock, so the callback only ran on the successful attempt.
    expect(calls).toBe(1);
    expect(created.code).toBe('RETRY_OK');
    expect(await db.service.count({ where: { code: 'RETRY_OK' } })).toBe(1);
  });

  it('raises DbBusyError after 3 busy attempts and writes nothing', async () => {
    const holder = openHolder();
    holder.exec('BEGIN IMMEDIATE');
    const retries: number[] = [];
    let calls = 0;

    const error = await withTx(
      db,
      async (tx) => {
        calls += 1;
        return tx.service.create({ data: serviceData('RETRY_FAIL') });
      },
      { ...noBackoff, onRetry: ({ attempt }) => void retries.push(attempt) },
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(DbBusyError);
    expect((error as DbBusyError).attempts).toBe(3);
    expect(isBusyError((error as DbBusyError).cause)).toBe(true);
    expect(retries).toEqual([1, 2]);
    expect(calls).toBe(0);
    release(holder);
    expect(await db.service.count({ where: { code: 'RETRY_FAIL' } })).toBe(0);
  });

  it('re-runs the whole callback when a write inside it hits SQLITE_BUSY (immediate: false)', async () => {
    const holder = openHolder();
    holder.exec('BEGIN IMMEDIATE');
    let calls = 0;
    const created = await withTx(
      db,
      async (tx) => {
        calls += 1;
        await tx.lead.count();
        return tx.service.create({ data: serviceData('RETRY_MID') });
      },
      { ...noBackoff, immediate: false, onRetry: () => release(holder) },
    );
    expect(calls).toBe(2);
    expect(created.code).toBe('RETRY_MID');
    expect(await db.service.count({ where: { code: 'RETRY_MID' } })).toBe(1);
  });

  it('does not retry non-busy errors and rolls back the attempt', async () => {
    let calls = 0;
    await expect(
      withTx(db, async (tx) => {
        calls += 1;
        await tx.service.create({ data: serviceData('ROLLED_BACK') });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
    expect(await db.service.count({ where: { code: 'ROLLED_BACK' } })).toBe(0);
  });

  it('takes the write lock when the transaction starts (BEGIN IMMEDIATE semantics)', async () => {
    const probe = openHolder();
    let probeResult = '';
    await withTx(db, async (tx) => {
      // Only a read so far, yet another writer must already be locked out.
      await tx.lead.count();
      try {
        probe.exec('BEGIN IMMEDIATE');
        probeResult = 'acquired';
        probe.exec('ROLLBACK');
      } catch (e) {
        probeResult = String((e as Error).message);
      }
    });
    expect(probeResult).toMatch(/locked|busy/i);
  });

  it('read-only transactions can opt out of the early write lock', async () => {
    const probe = openHolder();
    let probeResult = '';
    await withTx(
      db,
      async (tx) => {
        await tx.lead.count();
        try {
          probe.exec('BEGIN IMMEDIATE');
          probeResult = 'acquired';
          probe.exec('ROLLBACK');
        } catch (e) {
          probeResult = String((e as Error).message);
        }
      },
      { immediate: false },
    );
    expect(probeResult).toBe('acquired');
  });
});

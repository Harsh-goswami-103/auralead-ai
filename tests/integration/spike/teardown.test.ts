// T02 spike: teardown kills child process trees and the DB directory is deletable afterwards.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../support/db';
import { isPidAlive, spawnTsx, terminate, terminateAll, waitForPidExit } from '../../support/spawn';

const HOLDER = path.resolve(import.meta.dirname, 'fixtures', 'hold-db.ts');

let db: TestDb | undefined;

afterAll(async () => {
  await terminateAll();
  if (db && existsSync(db.dir)) await db.destroy();
});

describe('test teardown on Windows', () => {
  it('kills a DB-holding child and its grandchild, then deletes the DB directory', async () => {
    db = await createTestDb({ label: 'teardown' });
    const holder = spawnTsx(HOLDER, { env: { DATABASE_URL: db.url } });
    const ready = await holder.waitForLine((l) => l.startsWith('READY '), 30_000);
    const { pid, grandchildPid } = JSON.parse(ready.slice('READY '.length)) as { pid: number; grandchildPid: number };

    expect(pid).toBe(holder.pid);
    expect(isPidAlive(pid)).toBe(true);
    expect(isPidAlive(grandchildPid)).toBe(true);
    expect(existsSync(`${db.file}-wal`)).toBe(true);

    await terminate(holder);

    expect(await waitForPidExit(pid, 10_000)).toBe(true);
    expect(await waitForPidExit(grandchildPid, 10_000)).toBe(true);

    await db.destroy();
    expect(existsSync(db.file)).toBe(false);
    expect(existsSync(db.dir)).toBe(false);
  });

  it('terminate is a no-op for a child that already exited', async () => {
    const child = spawnTsx(HOLDER, { env: { DATABASE_URL: '' } });
    const exit = await child.waitForExit(30_000);
    expect(exit.code).toBe(2);
    await expect(terminate(child)).resolves.toBeUndefined();
    expect(isPidAlive(child.pid)).toBe(false);
  });
});

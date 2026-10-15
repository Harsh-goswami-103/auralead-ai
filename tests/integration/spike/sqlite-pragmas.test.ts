// T02 spike: the PRAGMAs the app relies on are active on the connection Prisma actually uses.
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConnectionPragmas, SQLITE_PRAGMAS } from '@/server/db/client';
import { createTestDb, type TestDb } from '../../support/db';

let db: TestDb;

beforeAll(async () => {
  // A space in the directory proves the unencoded file: URL from src/lib/paths.ts works for both
  // prisma migrate deploy and the adapter (user profiles and data dirs can contain spaces).
  db = await createTestDb({ label: 'pragmas with space' });
});

afterAll(async () => {
  await db?.destroy();
});

describe('SQLite PRAGMAs on the Prisma adapter connection', () => {
  it('runs on a DB whose path contains a space', () => {
    expect(db.url.startsWith('file:')).toBe(true);
    expect(db.url).toContain('pragmas with space');
    expect(db.url).not.toContain('\\');
    expect(db.url).not.toContain('%20');
  });

  it('exports the required values', () => {
    expect(SQLITE_PRAGMAS).toEqual({ journalMode: 'wal', busyTimeoutMs: 5000, foreignKeys: 1 });
  });

  it('journal_mode = wal, busy_timeout = 5000, foreign_keys = 1 on the client connection', async () => {
    const prisma = db.client();
    await expect(readConnectionPragmas(prisma)).resolves.toEqual({ journalMode: 'wal', busyTimeoutMs: 5000, foreignKeys: 1 });
  });

  it('the same values hold inside an interactive transaction', async () => {
    const prisma = db.client();
    const inTx = await prisma.$transaction((tx) => readConnectionPragmas(tx));
    expect(inTx).toEqual({ journalMode: 'wal', busyTimeoutMs: 5000, foreignKeys: 1 });
  });

  it('foreign keys are enforced: a JobAttempt for a missing Job is rejected', async () => {
    const prisma = db.client();
    await expect(
      prisma.jobAttempt.create({
        data: { jobId: 'missing-job', attemptNo: 1, startedAt: new Date('2026-10-15T10:00:00.000Z'), correlationId: 'c1' },
      }),
    ).rejects.toThrow(/foreign key/i);
    expect(await prisma.jobAttempt.count()).toBe(0);
  });

  // node:sqlite is a separate SQLite build with no PRAGMA setup, so this proves WAL is in the file.
  it('WAL is persisted in the file: an independent connection also reports wal', async () => {
    const prisma = db.client();
    await prisma.systemSetting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    const raw = new DatabaseSync(db.file, { readOnly: true });
    try {
      expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    } finally {
      raw.close();
    }
  });
});

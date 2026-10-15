/**
 * Prisma client factory (ADR-02): Prisma 7 + `@prisma/adapter-better-sqlite3`, verified on Windows
 * by the T02 spike.
 *
 * The adapter opens one better-sqlite3 connection per `connect()`. `PragmaAdapterFactory` wraps
 * the stock factory so every connection Prisma opens (including the shadow DB used by migrate)
 * runs the PRAGMAs below before its first query; SQLite PRAGMAs are per connection except
 * journal_mode, which is persisted in the file.
 *
 * Facts verified by tests/integration/spike/**:
 * - DateTime values are stored as ISO-8601 text with a `+00:00` suffix (e.g.
 *   `2026-10-15T10:00:00.000+00:00`), and a `Date` bound in `$queryRaw` uses the same text, so raw
 *   comparisons against Prisma-written columns are exact. Raw SQL must always bind `Date`
 *   parameters and never rely on SQL defaults such as CURRENT_TIMESTAMP (different format).
 * - INTEGER values come back from raw queries as exact `bigint` (the adapter enables safe integers).
 * - Interactive transactions start with a deferred `BEGIN` and are serialized per client.
 */
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@/generated/prisma/client';

export const SQLITE_PRAGMAS = { journalMode: 'wal', busyTimeoutMs: 5000, foreignKeys: 1 } as const;

const PRAGMA_SCRIPT = [
  `PRAGMA busy_timeout = ${SQLITE_PRAGMAS.busyTimeoutMs};`,
  `PRAGMA foreign_keys = ON;`,
  `PRAGMA journal_mode = WAL;`,
].join('\n');

type DriverAdapter = Awaited<ReturnType<PrismaBetterSqlite3['connect']>>;

class PragmaAdapterFactory {
  readonly provider = 'sqlite' as const;
  readonly adapterName: string;
  readonly #inner: PrismaBetterSqlite3;

  constructor(inner: PrismaBetterSqlite3) {
    this.#inner = inner;
    this.adapterName = inner.adapterName;
  }

  async connect(): Promise<DriverAdapter> {
    return withPragmas(await this.#inner.connect());
  }

  async connectToShadowDb(): Promise<DriverAdapter> {
    return withPragmas(await this.#inner.connectToShadowDb());
  }
}

async function withPragmas(adapter: DriverAdapter): Promise<DriverAdapter> {
  try {
    await adapter.executeScript(PRAGMA_SCRIPT);
  } catch (error) {
    await adapter.dispose();
    throw error;
  }
  return adapter;
}

export type CreatePrismaClientOptions = {
  /** SQLite `file:` URL with an absolute path (see `src/lib/paths.ts`). Spaces are allowed. */
  url: string;
};

export function createPrismaClient(options: CreatePrismaClientOptions): PrismaClient {
  if (!options.url.startsWith('file:')) throw new Error('createPrismaClient: url must be a SQLite file: URL');
  const inner = new PrismaBetterSqlite3({ url: options.url, timeout: SQLITE_PRAGMAS.busyTimeoutMs });
  return new PrismaClient({ adapter: new PragmaAdapterFactory(inner) });
}

/** Anything that can run raw SQL: a client or an interactive-transaction client. */
export type RawQueryable = Pick<PrismaClient, '$queryRawUnsafe'>;

export type ConnectionPragmas = { journalMode: string; busyTimeoutMs: number; foreignKeys: number };

/** Reads the effective PRAGMAs on the connection `db` uses (health checks and the T02 spike). */
export async function readConnectionPragmas(db: RawQueryable): Promise<ConnectionPragmas> {
  const [journal] = await db.$queryRawUnsafe<Array<{ journal_mode: string }>>('PRAGMA journal_mode');
  const [busy] = await db.$queryRawUnsafe<Array<{ timeout: number | bigint }>>('PRAGMA busy_timeout');
  const [fk] = await db.$queryRawUnsafe<Array<{ foreign_keys: number | bigint }>>('PRAGMA foreign_keys');
  if (!journal || !busy || !fk) throw new Error('PRAGMA query returned no row');
  return {
    journalMode: String(journal.journal_mode).toLowerCase(),
    busyTimeoutMs: Number(busy.timeout),
    foreignKeys: Number(fk.foreign_keys),
  };
}

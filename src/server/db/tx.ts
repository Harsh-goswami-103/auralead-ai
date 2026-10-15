/**
 * Busy-retrying interactive transactions (plan §3, §4.3).
 *
 * SQLite allows one writer at a time across the web and worker processes. better-sqlite3 waits up
 * to `busy_timeout` (5000 ms, see client.ts) for the write lock and then fails with SQLITE_BUSY;
 * in WAL mode a deferred transaction that read first can also fail immediately with
 * SQLITE_BUSY_SNAPSHOT when it tries to write. `withTx` re-runs the whole callback on a busy
 * error (the failed attempt was rolled back by Prisma), up to `maxAttempts`, then throws
 * `DbBusyError`.
 *
 * The Prisma adapter starts transactions with a deferred `BEGIN` and offers no IMMEDIATE option,
 * so by default `withTx` makes its first statement a no-op write. That takes the write lock at
 * the start of the transaction (BEGIN IMMEDIATE semantics): contention surfaces before any work
 * is done, and a transaction that reads and then writes can no longer fail on a stale snapshot.
 * Pass `immediate: false` for read-only transactions.
 *
 * Rules for callers: keep the callback short and free of network I/O (no adapter calls inside a
 * transaction, plan §3); the callback may run more than once, so it must not have side effects
 * outside the database.
 */
import { setTimeout as sleep } from 'node:timers/promises';

/** The busy error codes SQLite reports (primary code 5), as better-sqlite3 names them. */
const SQLITE_BUSY_PRIMARY = 5;
const UNKNOWN_SQLITE_ERROR_PREFIX = 'UNKNOWN_SQLITE_ERROR_';

/** Takes the write lock without changing any row (verified to block a second BEGIN IMMEDIATE). */
const WRITE_LOCK_SQL = 'UPDATE "SystemSetting" SET "id" = "id" WHERE 0';

export const WITH_TX_DEFAULTS = {
  maxAttempts: 3,
  /** Prisma's interactive-transaction limits: waiting for the per-client connection, and total run time. */
  maxWaitMs: 10_000,
  timeoutMs: 15_000,
} as const;

/** Thrown when every attempt of a transaction failed with SQLITE_BUSY. Maps to HTTP 503. */
export class DbBusyError extends Error {
  readonly code = 'DB_BUSY';
  readonly status = 503;
  readonly attempts: number;

  constructor(attempts: number, cause: unknown) {
    super(`database busy: transaction failed after ${attempts} attempts`, { cause });
    this.name = 'DbBusyError';
    this.attempts = attempts;
  }
}

function isBusyCode(code: unknown): boolean {
  if (typeof code !== 'string') return false;
  if (code.startsWith('SQLITE_BUSY')) return true;
  if (code.startsWith(UNKNOWN_SQLITE_ERROR_PREFIX)) {
    const extended = Number(code.slice(UNKNOWN_SQLITE_ERROR_PREFIX.length));
    return Number.isInteger(extended) && (extended & 0xff) === SQLITE_BUSY_PRIMARY;
  }
  return false;
}

/**
 * True when `error` is SQLite reporting a locked database: a raw better-sqlite3 error, or a Prisma
 * error wrapping the driver adapter's error (`meta.driverAdapterError.cause.originalCode`).
 */
export function isBusyError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const e = current as { code?: unknown; meta?: unknown; cause?: unknown };
    if (isBusyCode(e.code)) return true;
    const meta = e.meta as { driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
    if (isBusyCode(meta?.driverAdapterError?.cause?.originalCode)) return true;
    current = e.cause;
  }
  return false;
}

/** Anything with Prisma's interactive `$transaction`: a PrismaClient or a scoped (extended) client. */
export type TxCapable<Tx> = {
  $transaction<R>(fn: (tx: Tx) => Promise<R>, options?: { maxWait?: number; timeout?: number }): Promise<R>;
};

export type WithTxOptions = {
  /** Total attempts including the first (default 3). */
  maxAttempts?: number;
  /** Delay before retry number `attempt` (1-based). Default: 25 ms * 2^(attempt-1) plus up to 25 ms jitter. */
  backoffMs?: (attempt: number) => number;
  /** Take the write lock first (default true). Use false for read-only transactions. */
  immediate?: boolean;
  maxWaitMs?: number;
  timeoutMs?: number;
  /** Called after a busy failure, before the backoff and the next attempt. */
  onRetry?: (info: { attempt: number; error: unknown }) => void | Promise<void>;
};

function defaultBackoffMs(attempt: number): number {
  return 25 * 2 ** (attempt - 1) + Math.floor(Math.random() * 25);
}

export async function withTx<Tx, R>(db: TxCapable<Tx>, fn: (tx: Tx) => Promise<R>, options: WithTxOptions = {}): Promise<R> {
  const maxAttempts = options.maxAttempts ?? WITH_TX_DEFAULTS.maxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError('withTx: maxAttempts must be a positive integer');
  const immediate = options.immediate ?? true;
  const backoffMs = options.backoffMs ?? defaultBackoffMs;
  const txOptions = { maxWait: options.maxWaitMs ?? WITH_TX_DEFAULTS.maxWaitMs, timeout: options.timeoutMs ?? WITH_TX_DEFAULTS.timeoutMs };

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        if (immediate) await (tx as unknown as RawExecutor).$executeRawUnsafe(WRITE_LOCK_SQL);
        return fn(tx);
      }, txOptions);
    } catch (error) {
      if (!isBusyError(error)) throw error;
      if (attempt >= maxAttempts) throw new DbBusyError(attempt, error);
      await options.onRetry?.({ attempt, error });
      const delay = backoffMs(attempt);
      if (delay > 0) await sleep(delay);
    }
  }
}

type RawExecutor = { $executeRawUnsafe(query: string): Promise<number> };

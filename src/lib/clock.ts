/**
 * Injected time (plan §3 import rules, 04-tests T1, A40). Server and worker code read time only
 * through a Clock (`ctx.clock`); `Date.now()` and argument-less `new Date()` are lint errors
 * there. This module is the one place that reads the wall clock.
 *
 * - SystemClock: production.
 * - FixedClock: unit tests.
 * - DbOffsetClock: DEMO + AURALEAD_TEST_CONTROL=1 + TEST_CONTROL_TOKEN only. It applies the
 *   `TestClock` row (offsetMs, frozenAt) so the web process and the worker share one shifted
 *   time for E2E window and expiry tests. The DB read is injected (`TestClockLoader`) because
 *   src/lib never imports the DB layer; callers refresh it once per request or worker loop.
 */
import { TestControlNotAllowedError } from './errors/classes';

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export const systemClock: Clock = new SystemClock();

function toValidDate(at: Date | string | number): Date {
  const d = new Date(at instanceof Date ? at.getTime() : at);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid date: ${String(at)}`);
  return d;
}

export class FixedClock implements Clock {
  private ms: number;

  constructor(at: Date | string | number) {
    this.ms = toValidDate(at).getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  set(at: Date | string | number): void {
    this.ms = toValidDate(at).getTime();
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms)) throw new RangeError('advance() needs a finite number of milliseconds');
    this.ms += ms;
  }
}

/** The persisted `TestClock` row (offsetMs is a Prisma BigInt). */
export type TestClockState = { offsetMs: bigint | number; frozenAt: Date | null };
export type TestClockLoader = () => Promise<TestClockState>;

/** The subset of AppConfig that decides whether test control may exist. */
export type TestControlGuard = {
  mode: 'demo' | 'live';
  testControl: { enabled: boolean; token: string | null };
};

export function isTestClockAllowed(guard: TestControlGuard): boolean {
  return guard.mode === 'demo' && guard.testControl.enabled && typeof guard.testControl.token === 'string' && guard.testControl.token.length > 0;
}

function assertTestClockAllowed(guard: TestControlGuard): void {
  if (!isTestClockAllowed(guard)) {
    throw new TestControlNotAllowedError({
      message: 'DbOffsetClock requires demo mode, AURALEAD_TEST_CONTROL=1 and TEST_CONTROL_TOKEN',
    });
  }
}

function toOffsetMs(offset: bigint | number): number {
  const n = typeof offset === 'bigint' ? Number(offset) : offset;
  if (!Number.isSafeInteger(n) || (typeof offset === 'bigint' && BigInt(n) !== offset)) {
    throw new RangeError('TestClock offsetMs must be a safe integer');
  }
  return n;
}

export class DbOffsetClock implements Clock {
  private offsetMs = 0;
  private frozenAtMs: number | null = null;
  private readonly loader: TestClockLoader | null;

  constructor(guard: TestControlGuard, state: TestClockState, private readonly base: Clock = systemClock, loader?: TestClockLoader) {
    assertTestClockAllowed(guard);
    this.loader = loader ?? null;
    this.apply(state);
  }

  /** Guard first, then read the row, so a refused clock never touches the DB. */
  static async load(guard: TestControlGuard, loader: TestClockLoader, base: Clock = systemClock): Promise<DbOffsetClock> {
    assertTestClockAllowed(guard);
    return new DbOffsetClock(guard, await loader(), base, loader);
  }

  apply(state: TestClockState): void {
    const offset = toOffsetMs(state.offsetMs);
    const frozen = state.frozenAt === null ? null : toValidDate(state.frozenAt).getTime();
    this.offsetMs = offset;
    this.frozenAtMs = frozen;
  }

  async refresh(): Promise<void> {
    if (this.loader === null) throw new Error('DbOffsetClock.refresh() needs a loader; construct it with DbOffsetClock.load()');
    this.apply(await this.loader());
  }

  now(): Date {
    if (this.frozenAtMs !== null) return new Date(this.frozenAtMs);
    return new Date(this.base.now().getTime() + this.offsetMs);
  }
}

/**
 * The clock a process should use: a DbOffsetClock when test control is allowed, otherwise the
 * system clock (the loader is never called).
 */
export async function createClock(guard: TestControlGuard, loader: TestClockLoader): Promise<Clock> {
  if (!isTestClockAllowed(guard)) return systemClock;
  return DbOffsetClock.load(guard, loader);
}

import { describe, expect, it } from 'vitest';
import { DbOffsetClock, FixedClock, SystemClock, createClock, isTestClockAllowed, type TestClockState } from '@/lib/clock';
import { TestControlNotAllowedError } from '@/lib/errors';

const DEMO_WITH_CONTROL = { mode: 'demo' as const, testControl: { enabled: true, token: 'x'.repeat(40) } };

describe('SystemClock', () => {
  it('returns the current wall time as a fresh Date', () => {
    const clock = new SystemClock();
    const before = Date.now();
    const a = clock.now();
    const after = Date.now();
    expect(a.getTime()).toBeGreaterThanOrEqual(before);
    expect(a.getTime()).toBeLessThanOrEqual(after);
    expect(clock.now()).not.toBe(a);
  });
});

describe('FixedClock', () => {
  it('returns the fixed instant and copies so callers cannot mutate it', () => {
    const clock = new FixedClock('2026-10-15T10:00:00.000Z');
    const a = clock.now();
    a.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-10-15T10:00:00.000Z');
  });

  it('advances and sets explicitly', () => {
    const clock = new FixedClock(new Date('2026-10-15T10:00:00.000Z'));
    clock.advance(24 * 60 * 60 * 1000);
    expect(clock.now().toISOString()).toBe('2026-10-16T10:00:00.000Z');
    clock.set('2027-01-01T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('rejects invalid dates', () => {
    expect(() => new FixedClock('not a date')).toThrow(RangeError);
    expect(() => new FixedClock('2026-10-15T10:00:00Z').advance(Number.NaN)).toThrow(RangeError);
  });
});

describe('DbOffsetClock construction guard (A40)', () => {
  const state: TestClockState = { offsetMs: 0n, frozenAt: null };

  it.each([
    ['LIVE mode', { mode: 'live' as const, testControl: { enabled: true, token: 'x'.repeat(40) } }],
    ['DEMO without the test-control flag', { mode: 'demo' as const, testControl: { enabled: false, token: 'x'.repeat(40) } }],
    ['DEMO with the flag but no token', { mode: 'demo' as const, testControl: { enabled: true, token: null } }],
    ['DEMO with the flag and an empty token', { mode: 'demo' as const, testControl: { enabled: true, token: '' } }],
  ])('refuses %s', async (_label, guard) => {
    expect(isTestClockAllowed(guard)).toBe(false);
    expect(() => new DbOffsetClock(guard, state)).toThrow(TestControlNotAllowedError);
    let loads = 0;
    await expect(
      DbOffsetClock.load(guard, async () => {
        loads += 1;
        return state;
      }),
    ).rejects.toBeInstanceOf(TestControlNotAllowedError);
    expect(loads).toBe(0);
  });

  it('is allowed in DEMO with flag and token', () => {
    expect(isTestClockAllowed(DEMO_WITH_CONTROL)).toBe(true);
    expect(() => new DbOffsetClock(DEMO_WITH_CONTROL, state)).not.toThrow();
  });
});

describe('DbOffsetClock behavior', () => {
  const base = new FixedClock('2026-10-15T10:00:00.000Z');

  it('adds the stored offset (bigint or number) to the base clock', () => {
    const clock = new DbOffsetClock(DEMO_WITH_CONTROL, { offsetMs: 3_600_000n, frozenAt: null }, base);
    expect(clock.now().toISOString()).toBe('2026-10-15T11:00:00.000Z');
    clock.apply({ offsetMs: -60_000, frozenAt: null });
    expect(clock.now().toISOString()).toBe('2026-10-15T09:59:00.000Z');
  });

  it('returns frozenAt while frozen, regardless of the base clock', () => {
    const moving = new FixedClock('2026-10-15T10:00:00.000Z');
    const clock = new DbOffsetClock(DEMO_WITH_CONTROL, { offsetMs: 999n, frozenAt: new Date('2026-12-01T00:00:00.000Z') }, moving);
    moving.advance(5000);
    expect(clock.now().toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it('refresh() re-reads the persisted state so web and worker agree', async () => {
    let stored: TestClockState = { offsetMs: 0n, frozenAt: null };
    const clock = await DbOffsetClock.load(DEMO_WITH_CONTROL, async () => stored, base);
    expect(clock.now().toISOString()).toBe('2026-10-15T10:00:00.000Z');
    stored = { offsetMs: 86_400_000n, frozenAt: null };
    expect(clock.now().toISOString()).toBe('2026-10-15T10:00:00.000Z');
    await clock.refresh();
    expect(clock.now().toISOString()).toBe('2026-10-16T10:00:00.000Z');
  });

  it('rejects offsets outside the safe integer range', () => {
    expect(() => new DbOffsetClock(DEMO_WITH_CONTROL, { offsetMs: 2n ** 60n, frozenAt: null }, base)).toThrow(RangeError);
  });
});

describe('createClock', () => {
  it('gives a SystemClock when test control is not allowed, without calling the loader', async () => {
    let loads = 0;
    const clock = await createClock({ mode: 'live', testControl: { enabled: false, token: null } }, async () => {
      loads += 1;
      return { offsetMs: 0n, frozenAt: null };
    });
    expect(clock).toBeInstanceOf(SystemClock);
    expect(loads).toBe(0);
  });

  it('gives a loaded DbOffsetClock in DEMO with test control', async () => {
    const clock = await createClock(DEMO_WITH_CONTROL, async () => ({ offsetMs: 0n, frozenAt: new Date('2030-01-01T00:00:00Z') }));
    expect(clock).toBeInstanceOf(DbOffsetClock);
    expect(clock.now().toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });
});

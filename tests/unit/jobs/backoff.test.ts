// Plan §4.3: backoff is min(base * 2^n, cap) plus jitter; max attempts per job kind.
import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  DEFAULT_BACKOFF,
  MAX_ATTEMPTS_BY_KIND,
  maxAttemptsFor,
  retryDelayMs,
  type BackoffPolicy,
} from '@/server/jobs/backoff';

const NO_JITTER = () => 0;
const MAX_JITTER = () => 0.999_999;

describe('backoffDelayMs', () => {
  const policy: BackoffPolicy = { baseMs: 1_000, capMs: 60_000, jitterRatio: 0.2 };

  it('doubles from the base for each failed attempt until the cap', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelayMs(n, policy, NO_JITTER));
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  });

  it('never decreases as attempts grow, with or without jitter', () => {
    for (const random of [NO_JITTER, MAX_JITTER]) {
      let previous = 0;
      for (let n = 1; n <= 40; n++) {
        const d = backoffDelayMs(n, policy, random);
        expect(d).toBeGreaterThanOrEqual(previous);
        previous = d;
      }
    }
  });

  it('adds jitter bounded by jitterRatio of the exponential delay', () => {
    expect(backoffDelayMs(3, policy, () => 0.5)).toBe(4_000 + 400);
    expect(backoffDelayMs(3, policy, MAX_JITTER)).toBeLessThan(4_000 + 800);
    expect(backoffDelayMs(20, policy, MAX_JITTER)).toBeLessThan(60_000 + 12_000);
    const samples = new Set(Array.from({ length: 50 }, (_, i) => backoffDelayMs(2, policy, () => i / 50)));
    expect(samples.size).toBeGreaterThan(1);
  });

  it('does not overflow for very large attempt numbers', () => {
    expect(backoffDelayMs(10_000, policy, NO_JITTER)).toBe(60_000);
  });

  it('rejects invalid input', () => {
    expect(() => backoffDelayMs(0, policy)).toThrow(RangeError);
    expect(() => backoffDelayMs(1.5, policy)).toThrow(RangeError);
    expect(() => backoffDelayMs(1, { baseMs: -1, capMs: 10, jitterRatio: 0 })).toThrow(RangeError);
    expect(() => backoffDelayMs(1, { baseMs: 10, capMs: 5, jitterRatio: 0 })).toThrow(RangeError);
    expect(() => backoffDelayMs(1, { baseMs: 10, capMs: 50, jitterRatio: 2 })).toThrow(RangeError);
  });

  it('has a sane default policy', () => {
    expect(DEFAULT_BACKOFF.baseMs).toBeGreaterThan(0);
    expect(DEFAULT_BACKOFF.capMs).toBeGreaterThanOrEqual(DEFAULT_BACKOFF.baseMs);
    expect(backoffDelayMs(1, DEFAULT_BACKOFF, NO_JITTER)).toBe(DEFAULT_BACKOFF.baseMs);
  });
});

describe('retryDelayMs', () => {
  const policy: BackoffPolicy = { baseMs: 1_000, capMs: 60_000, jitterRatio: 0 };

  it('honors a provider Retry-After that is longer than the backoff', () => {
    expect(retryDelayMs(1, policy, { retryAfterMs: 30_000 })).toBe(30_000);
  });

  it('keeps the backoff when Retry-After is shorter', () => {
    expect(retryDelayMs(3, policy, { retryAfterMs: 500 })).toBe(4_000);
    expect(retryDelayMs(3, policy)).toBe(4_000);
  });
});

describe('max attempts per kind', () => {
  it('matches plan §4.3: send 5, ai 3, fetch 8, pdf 3, default 5', () => {
    expect(MAX_ATTEMPTS_BY_KIND).toEqual({ send: 5, ai: 3, fetch: 8, pdf: 3, default: 5 });
    expect(maxAttemptsFor('ai')).toBe(3);
    expect(maxAttemptsFor()).toBe(5);
  });
});

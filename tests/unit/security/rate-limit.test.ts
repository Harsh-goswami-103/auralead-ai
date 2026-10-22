import { describe, expect, it } from 'vitest';
import { clientIp, createRateLimiters, RATE_LIMIT_POLICIES, RateLimiter } from '@/server/security/rate-limit';

/** Minimal FixedClock: time moves only when the test advances it. */
class FixedClock {
  private ms: number;
  constructor(iso: string) {
    this.ms = Date.parse(iso);
  }
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

const T0 = '2026-10-15T00:00:00.000Z';

describe('RateLimiter token bucket (C6, ADR-12)', () => {
  it('allows `limit` requests, then trips with a Retry-After', () => {
    const clock = new FixedClock(T0);
    const rl = new RateLimiter({ limit: 5, windowMs: 60_000 }, clock);
    for (let i = 0; i < 5; i++) {
      const d = rl.take('ip:1.2.3.4');
      expect(d.allowed).toBe(true);
      expect(d.remaining).toBe(4 - i);
      expect(d.limit).toBe(5);
    }
    const denied = rl.take('ip:1.2.3.4');
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    // One token refills every 60 s / 5 = 12 s.
    expect(denied.retryAfterMs).toBe(12_000);
    expect(denied.retryAfterSeconds).toBe(12);
  });

  it('refills continuously as the injected clock advances', () => {
    const clock = new FixedClock(T0);
    const rl = new RateLimiter({ limit: 5, windowMs: 60_000 }, clock);
    for (let i = 0; i < 5; i++) rl.take('k');
    expect(rl.take('k').allowed).toBe(false);

    clock.advance(11_999);
    const stillDenied = rl.take('k');
    expect(stillDenied.allowed).toBe(false);
    expect(stillDenied.retryAfterMs).toBe(1);

    clock.advance(1);
    expect(rl.take('k').allowed).toBe(true);
    expect(rl.take('k').allowed).toBe(false);

    // A full window restores the whole bucket, never more than the limit.
    clock.advance(10 * 60_000);
    let allowed = 0;
    for (let i = 0; i < 10; i++) if (rl.take('k').allowed) allowed++;
    expect(allowed).toBe(5);
  });

  it('denied requests do not consume tokens', () => {
    const clock = new FixedClock(T0);
    const rl = new RateLimiter({ limit: 2, windowMs: 1_000 }, clock);
    rl.take('k');
    rl.take('k');
    for (let i = 0; i < 50; i++) expect(rl.take('k').allowed).toBe(false);
    clock.advance(500);
    expect(rl.take('k').allowed).toBe(true);
  });

  it('keeps keys independent', () => {
    const clock = new FixedClock(T0);
    const rl = new RateLimiter({ limit: 1, windowMs: 60_000 }, clock);
    expect(rl.take('email:a@x.in').allowed).toBe(true);
    expect(rl.take('email:a@x.in').allowed).toBe(false);
    expect(rl.take('email:b@x.in').allowed).toBe(true);
  });

  it('ignores a clock that moves backwards (no negative refill, no bonus tokens)', () => {
    const clock = new FixedClock(T0);
    const rl = new RateLimiter({ limit: 1, windowMs: 60_000 }, clock);
    rl.take('k');
    clock.advance(-30_000);
    expect(rl.take('k').allowed).toBe(false);
    clock.advance(30_000 + 60_000);
    expect(rl.take('k').allowed).toBe(true);
  });

  it('forgets fully refilled buckets when sweeping, so memory stays bounded', () => {
    const clock = new FixedClock(T0);
    const rl = new RateLimiter({ limit: 3, windowMs: 1_000 }, clock, { sweepThreshold: 10 });
    for (let i = 0; i < 10; i++) rl.take(`ip:${i}`);
    expect(rl.size()).toBe(10);
    clock.advance(1_000);
    rl.take('ip:new'); // exceeds the threshold, triggers a sweep of full buckets
    expect(rl.size()).toBe(1);
    // A forgotten key starts again with a full bucket, which is what it had anyway.
    expect(rl.take('ip:0').remaining).toBe(2);
  });

  it('rejects invalid policies', () => {
    const clock = new FixedClock(T0);
    expect(() => new RateLimiter({ limit: 0, windowMs: 1000 }, clock)).toThrow();
    expect(() => new RateLimiter({ limit: 1, windowMs: 0 }, clock)).toThrow();
  });
});

describe('plan §9 policies', () => {
  it('match the documented limits', () => {
    expect(RATE_LIMIT_POLICIES).toEqual({
      loginIp: { limit: 5, windowMs: 60_000 },
      loginEmail: { limit: 5, windowMs: 60_000 },
      inviteReset: { limit: 10, windowMs: 3_600_000 },
      publicQuote: { limit: 30, windowMs: 60_000 },
      extension: { limit: 60, windowMs: 60_000 },
      appsScript: { limit: 120, windowMs: 60_000 },
      metaWebhook: { limit: 600, windowMs: 60_000 },
      aiDraft: { limit: 30, windowMs: 60_000 },
      // Lead-gen suite (lead-gen plan §4 B3; keys are composed by the slices' routes).
      finderRun: { limit: 10, windowMs: 3_600_000 },
      leadImport: { limit: 10, windowMs: 60_000 },
      templateSubmit: { limit: 20, windowMs: 3_600_000 },
      handoff: { limit: 30, windowMs: 60_000 },
    });
  });

  it('lead-gen: a workspace starts at most 10 paid finder runs at once, then one more every 6 minutes', () => {
    const clock = new FixedClock(T0);
    const limiters = createRateLimiters(clock);
    for (let i = 0; i < 10; i++) expect(limiters.finderRun.take('workspace:w1').allowed).toBe(true);
    const denied = limiters.finderRun.take('workspace:w1');
    expect(denied).toMatchObject({ allowed: false, retryAfterSeconds: 360 });
    expect(limiters.finderRun.take('workspace:w2').allowed).toBe(true);
    clock.advance(360_000);
    expect(limiters.finderRun.take('workspace:w1').allowed).toBe(true);
    expect(limiters.leadImport.take('workspace:w1').allowed).toBe(true);
    expect(limiters.templateSubmit.take('workspace:w1').allowed).toBe(true);
    expect(limiters.handoff.take('user:u1').allowed).toBe(true);
  });

  it('createRateLimiters builds one limiter per policy on the given clock', () => {
    const clock = new FixedClock(T0);
    const limiters = createRateLimiters(clock);
    for (let i = 0; i < 30; i++) expect(limiters.publicQuote.take('ip:9.9.9.9').allowed).toBe(true);
    expect(limiters.publicQuote.take('ip:9.9.9.9').allowed).toBe(false);
    expect(limiters.aiDraft.take('ip:9.9.9.9').allowed).toBe(true);
    clock.advance(2_000);
    expect(limiters.publicQuote.take('ip:9.9.9.9').allowed).toBe(true);
  });
});

describe('clientIp', () => {
  it('uses the socket address when no proxy hops are trusted (X-Forwarded-For ignored)', () => {
    const h = new Headers({ 'x-forwarded-for': '6.6.6.6' });
    expect(clientIp(h, '10.0.0.5', 0)).toBe('10.0.0.5');
    expect(clientIp(h, null, 0)).toBe('unknown');
  });

  it('takes the Nth entry from the right with TRUSTED_PROXY_HOPS = N', () => {
    const h = new Headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 10.0.0.2' });
    expect(clientIp(h, '10.0.0.1', 1)).toBe('10.0.0.2');
    expect(clientIp(h, '10.0.0.1', 2)).toBe('203.0.113.7');
    // More hops than entries: the leftmost entry is the furthest the trusted chain reaches.
    expect(clientIp(h, '10.0.0.1', 5)).toBe('6.6.6.6');
    expect(clientIp(new Headers(), '10.0.0.1', 1)).toBe('10.0.0.1');
  });

  it('normalizes IPv4-mapped IPv6 and rejects garbage', () => {
    expect(clientIp(new Headers(), '::ffff:192.168.1.9', 0)).toBe('192.168.1.9');
    expect(clientIp(new Headers({ 'x-forwarded-for': 'not-an-ip' }), '10.0.0.1', 1)).toBe('unknown');
  });
});

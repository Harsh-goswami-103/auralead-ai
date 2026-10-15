import { describe, expect, it } from 'vitest';
import { CORRELATION_HEADER, isValidCorrelationId, newCorrelationId, resolveCorrelationId } from '@/lib/correlation';
import { idempotencyKey, newClaimToken, randomBase64Url, timeBucketKey } from '@/lib/ids';

describe('ids', () => {
  it('randomBase64Url encodes the requested number of random bytes', () => {
    const a = randomBase64Url(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomBase64Url(32)).not.toBe(a);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(() => randomBase64Url(0)).toThrow(RangeError);
  });

  it('claim tokens are unique and opaque', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => newClaimToken()));
    expect(tokens.size).toBe(1000);
    for (const t of tokens) expect(t).toMatch(/^ct_[A-Za-z0-9_-]{22}$/);
  });

  it('idempotencyKey joins parts and escapes the separator so keys cannot collide', () => {
    expect(idempotencyKey('dispatch', 'msg_1', 2)).toBe('dispatch:msg_1:2');
    expect(idempotencyKey('a:b', 'c')).not.toBe(idempotencyKey('a', 'b:c'));
    expect(() => idempotencyKey()).toThrow(RangeError);
    expect(() => idempotencyKey('x', '')).toThrow(RangeError);
  });

  it('timeBucketKey uses UTC buckets (plan §4.3: quote-expiry:2026-10-15T10)', () => {
    const at = new Date('2026-10-15T10:59:59.999Z');
    expect(timeBucketKey('quote-expiry', at, 'hour')).toBe('quote-expiry:2026-10-15T10');
    expect(timeBucketKey('purge', at, 'day')).toBe('purge:2026-10-15');
    expect(timeBucketKey('quality', new Date('2026-10-15T10:07:00Z'), 'minute')).toBe('quality:2026-10-15T10:07');
    expect(() => timeBucketKey('x', new Date('nope'), 'hour')).toThrow(RangeError);
  });
});

describe('correlation', () => {
  it('uses the x-request-id header name', () => {
    expect(CORRELATION_HEADER).toBe('x-request-id');
  });

  it('generates well-formed ids', () => {
    const id = newCorrelationId();
    expect(id).toMatch(/^req_[A-Za-z0-9_-]{22}$/);
    expect(isValidCorrelationId(id)).toBe(true);
  });

  it('accepts a sane incoming id and replaces hostile or missing ones', () => {
    expect(resolveCorrelationId('abc-123_DEF.456:789')).toBe('abc-123_DEF.456:789');
    for (const bad of [null, undefined, '', 'short', 'has space in it', 'x'.repeat(129), 'line\nbreak-injected', '<script>alert(1)</script>']) {
      const id = resolveCorrelationId(bad);
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^req_/);
    }
  });
});

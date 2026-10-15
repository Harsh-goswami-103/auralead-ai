import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hmacSha256, safeEqual, verifyHmacHex, verifyHubSignature256 } from '@/server/security/hmac';

const SECRET = 'meta-app-secret';
const body = Buffer.from('{"object":"page","entry":[{"name":"\\u0930"}]}', 'utf8');
const goodHex = createHmac('sha256', SECRET).update(body).digest('hex');

describe('hmac primitives', () => {
  it('hmacSha256 matches node crypto for strings and buffers', () => {
    expect(hmacSha256(SECRET, body).toString('hex')).toBe(goodHex);
    expect(hmacSha256(Buffer.from(SECRET), body.toString('utf8')).toString('hex')).toBe(goodHex);
  });

  it('safeEqual compares strings of any length without throwing', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('é', 'é')).toBe(false);
  });

  it('verifyHmacHex accepts the right digest in either case and rejects anything else', () => {
    expect(verifyHmacHex(SECRET, body, goodHex)).toBe(true);
    expect(verifyHmacHex(SECRET, body, goodHex.toUpperCase())).toBe(true);
    expect(verifyHmacHex('other', body, goodHex)).toBe(false);
    expect(verifyHmacHex(SECRET, body, goodHex.slice(0, -2))).toBe(false);
    expect(verifyHmacHex(SECRET, body, 'zz'.repeat(32))).toBe(false);
    expect(verifyHmacHex(SECRET, body, '')).toBe(false);
  });
});

describe('verifyHubSignature256 (X-Hub-Signature-256 over raw bytes)', () => {
  it('accepts the exact raw body', () => {
    expect(verifyHubSignature256(body, `sha256=${goodHex}`, SECRET)).toBe(true);
  });

  it('rejects a flipped byte', () => {
    const flipped = Buffer.from(body);
    flipped[5] = flipped[5]! ^ 0x01;
    expect(verifyHubSignature256(flipped, `sha256=${goodHex}`, SECRET)).toBe(false);
  });

  it('rejects re-serialized JSON', () => {
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString('utf8'))), 'utf8');
    expect(reserialized.equals(body)).toBe(false);
    expect(verifyHubSignature256(reserialized, `sha256=${goodHex}`, SECRET)).toBe(false);
  });

  it('rejects missing or malformed headers', () => {
    for (const h of [null, '', goodHex, `sha1=${goodHex}`, 'sha256=', `sha256=${goodHex}x`]) {
      expect(verifyHubSignature256(body, h, SECRET)).toBe(false);
    }
  });

  it('refuses to verify with an empty secret', () => {
    const emptyHex = createHmac('sha256', '').update(body).digest('hex');
    expect(verifyHubSignature256(body, `sha256=${emptyHex}`, '')).toBe(false);
  });
});

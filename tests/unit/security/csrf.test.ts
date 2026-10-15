import { describe, expect, it } from 'vitest';
import {
  checkCsrf,
  checkOrigin,
  CSRF_HEADER,
  csrfTokenFor,
  formNonce,
  verifyFormNonce,
} from '@/server/security/csrf';

const APP_ORIGIN = 'http://localhost:3000';
const SECRET = 's'.repeat(48);
const SESSION_ID = 'sess_123';
const token = csrfTokenFor(SECRET, SESSION_ID);

function headers(init: Record<string, string>) {
  return new Headers(init);
}

function check(method: string, init: Record<string, string>, sessionId = SESSION_ID) {
  return checkCsrf({ method, headers: headers(init), appOrigin: APP_ORIGIN, sessionSecret: SECRET, sessionId });
}

describe('CSRF token', () => {
  it('is a deterministic base64url HMAC of the session id, different per session and per secret', () => {
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrfTokenFor(SECRET, SESSION_ID)).toBe(token);
    expect(csrfTokenFor(SECRET, 'sess_other')).not.toBe(token);
    expect(csrfTokenFor('t'.repeat(48), SESSION_ID)).not.toBe(token);
  });
});

describe('checkCsrf (A32)', () => {
  it('passes a same-origin POST with a valid token', () => {
    expect(check('POST', { origin: APP_ORIGIN, [CSRF_HEADER]: token })).toEqual({ ok: true });
  });

  it('accepts Referer from the app origin when Origin is absent', () => {
    expect(check('PATCH', { referer: `${APP_ORIGIN}/dashboard/user/leads?x=1`, [CSRF_HEADER]: token })).toEqual({ ok: true });
  });

  it('rejects an Origin mismatch even with a valid token', () => {
    expect(check('POST', { origin: 'https://evil.example', [CSRF_HEADER]: token })).toEqual({ ok: false, reason: 'ORIGIN_MISMATCH' });
    expect(check('POST', { origin: 'http://localhost:3001', [CSRF_HEADER]: token })).toEqual({ ok: false, reason: 'ORIGIN_MISMATCH' });
    expect(check('POST', { origin: 'null', [CSRF_HEADER]: token })).toEqual({ ok: false, reason: 'ORIGIN_MISMATCH' });
    expect(check('DELETE', { referer: 'https://evil.example/page', [CSRF_HEADER]: token })).toEqual({ ok: false, reason: 'ORIGIN_MISMATCH' });
  });

  it('does not fall back to a matching Referer when Origin is present and wrong', () => {
    expect(check('POST', { origin: 'https://evil.example', referer: `${APP_ORIGIN}/x`, [CSRF_HEADER]: token })).toEqual({
      ok: false,
      reason: 'ORIGIN_MISMATCH',
    });
  });

  it('rejects when neither Origin nor Referer is present', () => {
    expect(check('POST', { [CSRF_HEADER]: token })).toEqual({ ok: false, reason: 'ORIGIN_MISSING' });
  });

  it('rejects a missing token', () => {
    expect(check('POST', { origin: APP_ORIGIN })).toEqual({ ok: false, reason: 'TOKEN_MISSING' });
    expect(check('POST', { origin: APP_ORIGIN, [CSRF_HEADER]: '' })).toEqual({ ok: false, reason: 'TOKEN_MISSING' });
  });

  it('rejects a token minted for another session or tampered', () => {
    expect(check('POST', { origin: APP_ORIGIN, [CSRF_HEADER]: csrfTokenFor(SECRET, 'sess_other') })).toEqual({
      ok: false,
      reason: 'TOKEN_INVALID',
    });
    const tampered = token.slice(0, 10) + (token[10] === 'A' ? 'B' : 'A') + token.slice(11);
    expect(check('POST', { origin: APP_ORIGIN, [CSRF_HEADER]: tampered })).toEqual({
      ok: false,
      reason: 'TOKEN_INVALID',
    });
    expect(check('POST', { origin: APP_ORIGIN, [CSRF_HEADER]: 'short' })).toEqual({ ok: false, reason: 'TOKEN_INVALID' });
  });

  it('skips safe methods (GET never mutates)', () => {
    expect(check('GET', {})).toEqual({ ok: true });
    expect(check('HEAD', {})).toEqual({ ok: true });
    expect(check('OPTIONS', {})).toEqual({ ok: true });
  });

  it('normalizes the configured APP_ORIGIN (trailing slash, case of host)', () => {
    const r = checkCsrf({
      method: 'POST',
      headers: headers({ origin: 'http://LOCALHOST:3000', [CSRF_HEADER]: token }),
      appOrigin: 'http://localhost:3000/',
      sessionSecret: SECRET,
      sessionId: SESSION_ID,
    });
    expect(r).toEqual({ ok: true });
  });
});

describe('checkOrigin', () => {
  it('returns ok only for the app origin', () => {
    expect(checkOrigin(headers({ origin: APP_ORIGIN }), APP_ORIGIN)).toEqual({ ok: true });
    expect(checkOrigin(headers({ origin: 'chrome-extension://abc' }), APP_ORIGIN)).toEqual({ ok: false, reason: 'ORIGIN_MISMATCH' });
    expect(checkOrigin(headers({ referer: 'not a url' }), APP_ORIGIN)).toEqual({ ok: false, reason: 'ORIGIN_MISMATCH' });
  });
});

describe('public accept formNonce (C5)', () => {
  const key = 'n'.repeat(48);
  const tokenHash = 'a'.repeat(64);

  it('verifies the nonce for the same token hash and version only', () => {
    const nonce = formNonce(key, tokenHash, 'ver_1');
    expect(verifyFormNonce(key, tokenHash, 'ver_1', nonce)).toBe(true);
    expect(verifyFormNonce(key, tokenHash, 'ver_2', nonce)).toBe(false);
    expect(verifyFormNonce(key, 'b'.repeat(64), 'ver_1', nonce)).toBe(false);
    expect(verifyFormNonce('m'.repeat(48), tokenHash, 'ver_1', nonce)).toBe(false);
    expect(verifyFormNonce(key, tokenHash, 'ver_1', '')).toBe(false);
  });
});

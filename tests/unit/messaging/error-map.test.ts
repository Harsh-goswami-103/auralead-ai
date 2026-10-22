/**
 * Provider error maps (E7, ADR-41, C16, plan §6.3). Every assertion reads its expectations from the
 * map itself (code -> entry), never from string literals of the classification, so a dated map
 * change is a reviewed edit in one place.
 */
import { describe, expect, it } from 'vitest';
import { classifyEmailFailure, EMAIL_AMBIGUOUS_ERRORS, EMAIL_ERROR_MAP, EMAIL_ERROR_MAP_CHECKED_ON } from '@/server/adapters/email/error-map';
import { classifyWhatsAppFailure, WHATSAPP_ERROR_MAP, WHATSAPP_ERROR_MAP_CHECKED_ON, WA_CODES } from '@/server/adapters/whatsapp/error-map';

const CLASSES = ['PRE_SEND', 'RETRYABLE', 'PERMANENT'] as const;

describe('WhatsApp error map', () => {
  it('carries a check date and declares a failure class and reason for every entry', () => {
    expect(WHATSAPP_ERROR_MAP_CHECKED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const entries = Object.entries(WHATSAPP_ERROR_MAP);
    expect(entries.length).toBeGreaterThanOrEqual(8);
    for (const [code, entry] of entries) {
      expect(CLASSES, code).toContain(entry.failureClass);
      expect(entry.reasonCode, code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(typeof entry.suppress, code).toBe('boolean');
      expect(entry.verified, code).toBe(false);
    }
  });

  it('131049 is a PERMANENT frequency cap: no automatic retry, manual retry only after 24 h, no suppression', () => {
    const entry = WHATSAPP_ERROR_MAP[WA_CODES.FREQUENCY_CAP]!;
    const out = classifyWhatsAppFailure({ phase: 'response', httpStatus: 400, providerCode: WA_CODES.FREQUENCY_CAP, message: 'x' });
    expect(out).toMatchObject({ status: 'failed', failureClass: entry.failureClass, reasonCode: entry.reasonCode, suppress: false });
    expect(entry.failureClass).toBe('PERMANENT');
    expect(entry.reasonCode).toBe('RECIPIENT_FREQUENCY_CAP');
    expect(entry.manualRetryAfterMs).toBe(24 * 60 * 60 * 1000);
  });

  it('131026 is PERMANENT UNDELIVERABLE and never suppresses', () => {
    const entry = WHATSAPP_ERROR_MAP[WA_CODES.UNDELIVERABLE]!;
    expect(entry).toMatchObject({ failureClass: 'PERMANENT', reasonCode: 'UNDELIVERABLE', suppress: false });
    expect(classifyWhatsAppFailure({ phase: 'response', httpStatus: 400, providerCode: WA_CODES.UNDELIVERABLE, message: 'x' })).toMatchObject({
      status: 'failed',
      failureClass: 'PERMANENT',
      suppress: false,
    });
  });

  it('131047 maps to WINDOW_CLOSED (never resent as free-form)', () => {
    const entry = WHATSAPP_ERROR_MAP[WA_CODES.WINDOW_CLOSED]!;
    expect(entry).toMatchObject({ failureClass: 'PERMANENT', reasonCode: 'WINDOW_CLOSED' });
  });

  it('131050 (marketing stopped) is PERMANENT and suppresses through the suppression service', () => {
    expect(WHATSAPP_ERROR_MAP[WA_CODES.MARKETING_STOPPED]).toMatchObject({ failureClass: 'PERMANENT', suppress: true });
  });

  it('a mapped provider code wins over the HTTP status', () => {
    const entry = WHATSAPP_ERROR_MAP[WA_CODES.RATE_LIMITED]!;
    expect(entry.failureClass).toBe('RETRYABLE');
    expect(classifyWhatsAppFailure({ phase: 'response', httpStatus: 400, providerCode: WA_CODES.RATE_LIMITED, message: 'x', retryAfterMs: 7_000 })).toMatchObject({
      status: 'failed',
      failureClass: 'RETRYABLE',
      reasonCode: entry.reasonCode,
      retryAfterMs: 7_000,
    });
  });

  it('HTTP 429 without a mapped code is RETRYABLE and keeps Retry-After', () => {
    expect(classifyWhatsAppFailure({ phase: 'response', httpStatus: 429, message: 'slow down', retryAfterMs: 30_000 })).toMatchObject({
      status: 'failed',
      failureClass: 'RETRYABLE',
      reasonCode: 'RATE_LIMITED',
      retryAfterMs: 30_000,
    });
  });

  it('5xx is RETRYABLE only with no-write evidence, otherwise AMBIGUOUS', () => {
    expect(classifyWhatsAppFailure({ phase: 'response', httpStatus: 503, noWriteEvidence: true, message: 'x' })).toMatchObject({ status: 'failed', failureClass: 'RETRYABLE' });
    expect(classifyWhatsAppFailure({ phase: 'response', httpStatus: 500, message: 'x' })).toMatchObject({ status: 'ambiguous' });
    expect(classifyWhatsAppFailure({ phase: 'response', httpStatus: 502, noWriteEvidence: false, message: 'x' })).toMatchObject({ status: 'ambiguous' });
  });

  it('an unmapped 4xx is PERMANENT; failures before the write are PRE_SEND; a timeout after the write is AMBIGUOUS', () => {
    expect(classifyWhatsAppFailure({ phase: 'response', httpStatus: 400, providerCode: '999999', message: 'x' })).toMatchObject({ status: 'failed', failureClass: 'PERMANENT' });
    expect(classifyWhatsAppFailure({ phase: 'before-write', message: 'ECONNREFUSED' })).toMatchObject({ status: 'failed', failureClass: 'PRE_SEND' });
    expect(classifyWhatsAppFailure({ phase: 'after-write', message: 'timeout' })).toMatchObject({ status: 'ambiguous' });
  });

  it('stores redacted, bounded error text', () => {
    const out = classifyWhatsAppFailure({ phase: 'response', httpStatus: 400, message: `bad recipient +919811012345 ${'x'.repeat(900)}` });
    expect(out.error).not.toContain('9811012345');
    expect(out.error.length).toBeLessThanOrEqual(500);
  });
});

describe('Email error map', () => {
  it('carries a check date and a failure class for every entry', () => {
    expect(EMAIL_ERROR_MAP_CHECKED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const [code, entry] of Object.entries(EMAIL_ERROR_MAP)) {
      expect(CLASSES, code).toContain(entry.failureClass);
      expect(entry.reasonCode, code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });

  it('SMTP 4xx is RETRYABLE and SMTP 5xx PERMANENT', () => {
    expect(classifyEmailFailure({ transport: 'smtp', phase: 'response', smtpCode: 451, message: 'try later' })).toMatchObject({ status: 'failed', failureClass: 'RETRYABLE' });
    expect(classifyEmailFailure({ transport: 'smtp', phase: 'response', smtpCode: 550, message: 'no such user' })).toMatchObject({ status: 'failed', failureClass: 'PERMANENT' });
  });

  it('HTTP 429 RETRYABLE, 5xx needs no-write evidence, mapped provider names win', () => {
    expect(classifyEmailFailure({ transport: 'http', phase: 'response', httpStatus: 429, message: 'x' })).toMatchObject({ status: 'failed', failureClass: 'RETRYABLE' });
    expect(classifyEmailFailure({ transport: 'http', phase: 'response', httpStatus: 500, message: 'x' })).toMatchObject({ status: 'ambiguous' });
    expect(classifyEmailFailure({ transport: 'http', phase: 'response', httpStatus: 500, noWriteEvidence: true, message: 'x' })).toMatchObject({ status: 'failed', failureClass: 'RETRYABLE' });
    const [name, entry] = Object.entries(EMAIL_ERROR_MAP)[0]!;
    expect(classifyEmailFailure({ transport: 'http', phase: 'response', httpStatus: 400, providerCode: name, message: 'x' })).toMatchObject({
      status: 'failed',
      failureClass: entry.failureClass,
      reasonCode: entry.reasonCode,
    });
  });

  it('a timeout after the write is AMBIGUOUS', () => {
    expect(classifyEmailFailure({ transport: 'smtp', phase: 'after-write', message: 'socket closed' })).toMatchObject({ status: 'ambiguous' });
  });

  it('T33: an idempotent request still in progress is AMBIGUOUS, never a failure; every ambiguous name is outside the failure map', () => {
    for (const [name, reason] of Object.entries(EMAIL_AMBIGUOUS_ERRORS)) {
      expect(EMAIL_ERROR_MAP[name], name).toBeUndefined();
      expect(classifyEmailFailure({ transport: 'http', phase: 'response', httpStatus: 409, providerCode: name, message: 'x' })).toEqual({ status: 'ambiguous', reasonCode: reason, error: 'x' });
    }
    expect(EMAIL_AMBIGUOUS_ERRORS.concurrent_idempotent_requests).toBe('IDEMPOTENT_REQUEST_IN_PROGRESS');
  });

  it('T33: a reused key, the monthly quota and auth names are PERMANENT; the daily quota and rate limit RETRYABLE with a workspace throttle', () => {
    expect(EMAIL_ERROR_MAP.invalid_idempotent_request).toMatchObject({ failureClass: 'PERMANENT', reasonCode: 'IDEMPOTENCY_KEY_REUSED' });
    expect(EMAIL_ERROR_MAP.monthly_quota_exceeded).toMatchObject({ failureClass: 'PERMANENT' });
    expect(EMAIL_ERROR_MAP.daily_quota_exceeded).toMatchObject({ failureClass: 'RETRYABLE', throttleScope: 'workspace' });
    expect(EMAIL_ERROR_MAP.rate_limit_exceeded).toMatchObject({ failureClass: 'RETRYABLE', throttleScope: 'workspace' });
    for (const name of ['missing_api_key', 'invalid_api_key']) expect(EMAIL_ERROR_MAP[name]).toMatchObject({ failureClass: 'PERMANENT', reasonCode: 'PROVIDER_AUTH' });
    for (const e of Object.values(EMAIL_ERROR_MAP)) expect(e.verified).toBe(false);
  });
});

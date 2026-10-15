import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as errors from '@/lib/errors';
import { AppError, errorResponse, errorToHttp } from '@/lib/errors';

type Ctor = new (opts?: errors.AppErrorOptions) => AppError;

/** Every concrete AppError subclass with its HTTP status and default code (plan §9, 02-errors §2.1). */
const EXPECTED: Record<string, { status: number; code: string; retryable: boolean }> = {
  ValidationError: { status: 400, code: 'VALIDATION_FAILED', retryable: false },
  PayloadTooLargeError: { status: 413, code: 'PAYLOAD_TOO_LARGE', retryable: false },
  TemplateVariableInvalidError: { status: 422, code: 'TEMPLATE_VARIABLE_INVALID', retryable: false },
  AuthError: { status: 401, code: 'UNAUTHENTICATED', retryable: false },
  SignatureInvalidError: { status: 401, code: 'SIGNATURE_INVALID', retryable: false },
  ReplayDetectedError: { status: 409, code: 'REPLAY_DETECTED', retryable: false },
  IngestionTokenRevokedError: { status: 401, code: 'TOKEN_REVOKED', retryable: false },
  NotFoundError: { status: 404, code: 'NOT_FOUND', retryable: false },
  TenantScopeError: { status: 404, code: 'NOT_FOUND', retryable: false },
  PermissionDeniedError: { status: 403, code: 'FORBIDDEN', retryable: false },
  CsrfError: { status: 403, code: 'CSRF_FAILED', retryable: false },
  RateLimitedError: { status: 429, code: 'RATE_LIMITED', retryable: true },
  ConflictError: { status: 409, code: 'CONFLICT', retryable: false },
  IdempotencyConflictError: { status: 409, code: 'IDEMPOTENCY_CONFLICT', retryable: false },
  QuoteVersionConflictError: { status: 409, code: 'QUOTE_VERSION_CONFLICT', retryable: false },
  InvalidTransitionError: { status: 409, code: 'INVALID_TRANSITION', retryable: false },
  ApprovalStaleError: { status: 409, code: 'APPROVAL_STALE', retryable: false },
  DbBusyError: { status: 503, code: 'DB_BUSY', retryable: true },
  DomainRuleError: { status: 422, code: 'DOMAIN_RULE_VIOLATED', retryable: false },
  PricingMissingError: { status: 422, code: 'PRICING_MISSING', retryable: false },
  DiscountLimitExceededError: { status: 422, code: 'DISCOUNT_OVER_LIMIT', retryable: false },
  DiscountInvalidError: { status: 422, code: 'DISCOUNT_INVALID', retryable: false },
  AmountInvalidError: { status: 422, code: 'AMOUNT_INVALID', retryable: false },
  ServiceNotApprovedError: { status: 422, code: 'SERVICE_NOT_APPROVED', retryable: false },
  SuppressedRecipientError: { status: 422, code: 'SUPPRESSED', retryable: false },
  ConsentMissingError: { status: 422, code: 'CONSENT_MISSING', retryable: false },
  WindowClosedError: { status: 422, code: 'WINDOW_CLOSED', retryable: false },
  TemplateNotApprovedError: { status: 422, code: 'TEMPLATE_NOT_APPROVED', retryable: false },
  HumanTakeoverActiveError: { status: 422, code: 'HUMAN_TAKEOVER', retryable: false },
  OutboundPausedError: { status: 422, code: 'OUTBOUND_PAUSED', retryable: false },
  ShareLinkGoneError: { status: 410, code: 'SHARE_LINK_GONE', retryable: false },
  IntegrationError: { status: 409, code: 'INTEGRATION_ERROR', retryable: false },
  IntegrationNotConfiguredError: { status: 409, code: 'INTEGRATION_NOT_CONFIGURED', retryable: false },
  CredentialDecryptError: { status: 500, code: 'CREDENTIAL_DECRYPT_FAILED', retryable: false },
  ModeMismatchError: { status: 409, code: 'MODE_MISMATCH', retryable: false },
  OutboundBlockedInDemoError: { status: 500, code: 'OUTBOUND_BLOCKED_IN_DEMO', retryable: false },
  ProviderError: { status: 502, code: 'PROVIDER_ERROR', retryable: false },
  ProviderAuthError: { status: 502, code: 'PROVIDER_AUTH', retryable: false },
  ProviderPermissionError: { status: 502, code: 'PROVIDER_PERMISSION', retryable: false },
  ProviderRateLimitedError: { status: 503, code: 'PROVIDER_RATE_LIMITED', retryable: true },
  ProviderUnavailableError: { status: 503, code: 'PROVIDER_UNAVAILABLE', retryable: true },
  ProviderRejectedError: { status: 502, code: 'PROVIDER_REJECTED', retryable: false },
  ProviderTimeoutSafeError: { status: 504, code: 'PROVIDER_TIMEOUT', retryable: true },
  ProviderTimeoutAmbiguousError: { status: 504, code: 'PROVIDER_TIMEOUT_AMBIGUOUS', retryable: false },
  AiError: { status: 502, code: 'AI_ERROR', retryable: false },
  AiMalformedOutputError: { status: 502, code: 'AI_MALFORMED_OUTPUT', retryable: true },
  AiEmptyOutputError: { status: 502, code: 'AI_EMPTY_OUTPUT', retryable: true },
  AiTruncatedOutputError: { status: 502, code: 'AI_TRUNCATED_OUTPUT', retryable: true },
  AiRefusalError: { status: 502, code: 'AI_REFUSAL', retryable: false },
  AiPolicyViolationError: { status: 422, code: 'AI_POLICY_VIOLATION', retryable: false },
  EnrichmentError: { status: 502, code: 'ENRICHMENT_FAILED', retryable: false },
  EnrichmentBlockedDestinationError: { status: 422, code: 'ENRICHMENT_BLOCKED_DESTINATION', retryable: false },
  EnrichmentTooLargeError: { status: 502, code: 'ENRICHMENT_TOO_LARGE', retryable: false },
  EnrichmentTimeoutError: { status: 504, code: 'ENRICHMENT_TIMEOUT', retryable: true },
  EnrichmentFetchError: { status: 502, code: 'ENRICHMENT_FETCH_FAILED', retryable: true },
  PdfRenderError: { status: 500, code: 'PDF_RENDER_FAILED', retryable: true },
  JobError: { status: 500, code: 'JOB_ERROR', retryable: false },
  LeaseLostError: { status: 409, code: 'LEASE_LOST', retryable: false },
  JobCancelledError: { status: 409, code: 'JOB_CANCELLED', retryable: false },
  MaxAttemptsExceededError: { status: 500, code: 'MAX_ATTEMPTS_EXCEEDED', retryable: false },
  TestControlNotAllowedError: { status: 500, code: 'TEST_CONTROL_NOT_ALLOWED', retryable: false },
  InternalError: { status: 500, code: 'INTERNAL', retryable: false },
};

function exportedErrorClasses(): Array<[string, Ctor]> {
  return Object.entries(errors as Record<string, unknown>).filter(
    (entry): entry is [string, Ctor] =>
      typeof entry[1] === 'function' && entry[1] !== AppError && (entry[1] as Ctor).prototype instanceof AppError,
  );
}

const REF = 'req_test_correlation_0001';

describe('AppError hierarchy', () => {
  it('the expectation table covers exactly the exported subclasses', () => {
    const names = exportedErrorClasses().map(([n]) => n).sort();
    expect(names).toEqual(Object.keys(EXPECTED).sort());
  });

  it('AppError itself is abstract (not constructible through the public API)', () => {
    expect(() => new (AppError as unknown as Ctor)()).toThrow(TypeError);
  });

  it.each(exportedErrorClasses())('%s maps to its status, code and retryability', (name, Cls) => {
    const expected = EXPECTED[name]!;
    const err = new Cls();
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe(name);
    expect(err.status).toBe(expected.status);
    expect(err.code).toBe(expected.code);
    expect(err.retryable).toBe(expected.retryable);
    expect(err.userMessage.length).toBeGreaterThan(0);

    const http = errorToHttp(err, REF);
    expect(http.status).toBe(expected.status);
    expect(http.body.code).toBe(expected.code);
    expect(http.body.reference).toBe(REF);
    expect(http.body.message).toBe(err.userMessage);
    expect(http.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(http.headers['cache-control']).toBe('no-store');
  });

  it('keeps subclass relationships used by catch sites', () => {
    expect(new errors.TenantScopeError()).toBeInstanceOf(errors.NotFoundError);
    expect(new errors.DbBusyError()).toBeInstanceOf(errors.ConflictError);
    expect(new errors.DiscountLimitExceededError()).toBeInstanceOf(errors.DomainRuleError);
    expect(new errors.ProviderTimeoutAmbiguousError()).toBeInstanceOf(errors.ProviderError);
    expect(new errors.LeaseLostError()).toBeInstanceOf(errors.JobError);
    expect(new errors.SignatureInvalidError()).toBeInstanceOf(errors.AuthError);
  });

  it('tenant-scope and plain not-found responses are indistinguishable (no enumeration)', () => {
    const a = errorToHttp(new errors.TenantScopeError({ message: 'lead ws_b/abc belongs to another workspace' }), REF);
    const b = errorToHttp(new errors.NotFoundError(), REF);
    expect(a).toEqual(b);
  });

  it('allows overriding code and userMessage while keeping the status', () => {
    const err = new errors.IdempotencyConflictError({ code: 'BATCH_CONTENT_MISMATCH', userMessage: 'This batch id was already used with different content.' });
    const http = errorToHttp(err, REF);
    expect(http.status).toBe(409);
    expect(http.body).toEqual({ code: 'BATCH_CONTENT_MISMATCH', message: 'This batch id was already used with different content.', reference: REF });
  });
});

describe('errorToHttp body safety', () => {
  it('never puts the stack, internal message or cause into the body', () => {
    const cause = new Error('SQLITE_BUSY: database is locked at C:\\Users\\Asus\\secret\\app.db');
    const err = new errors.ValidationError({ message: 'internal: field token=abc123 failed', cause });
    const http = errorToHttp(err, REF);
    const json = JSON.stringify(http.body);
    expect(json).not.toContain('stack');
    expect(json).not.toMatch(/\n\s+at /);
    expect(json).not.toContain('internal: field');
    expect(json).not.toContain('SQLITE_BUSY');
    expect(json).not.toContain('abc123');
    expect(err.stack).toBeTruthy();
    expect(err.cause).toBe(cause);
  });

  it('maps unknown throwables to a generic 500 with the correlation id', () => {
    for (const thrown of [new Error('boom /etc/passwd sk-ant-api03-SECRETSECRETSECRET'), 'a string', 42, null, undefined, { weird: true }]) {
      const http = errorToHttp(thrown, REF);
      expect(http.status).toBe(500);
      expect(http.body).toEqual({ code: 'INTERNAL', message: new errors.InternalError().userMessage, reference: REF });
    }
  });

  it('prefers the correlation id stored on the error', () => {
    const err = new errors.ConflictError({ correlationId: 'req_from_error_000001' });
    expect(errorToHttp(err, REF).body.reference).toBe('req_from_error_000001');
  });

  it('includes redacted safeDetails for client errors only', () => {
    const client = errorToHttp(
      new errors.DiscountLimitExceededError({ safeDetails: { limitBps: 1500, requestedBps: 1501, contact: 'owner@example.com' } }),
      REF,
    );
    expect(client.body.details).toEqual({ limitBps: 1500, requestedBps: 1501, contact: '[REDACTED]' });
    const server = errorToHttp(new errors.PdfRenderError({ safeDetails: { quoteVersionId: 'qv1' } }), REF);
    expect(server.body.details).toBeUndefined();
  });

  it('sets Retry-After for rate limiting and busy errors', () => {
    expect(errorToHttp(new errors.RateLimitedError({ retryAfterSeconds: 30 }), REF).headers['retry-after']).toBe('30');
    expect(errorToHttp(new errors.DbBusyError({ retryAfterSeconds: 1 }), REF).headers['retry-after']).toBe('1');
    expect(errorToHttp(new errors.RateLimitedError(), REF).headers['retry-after']).toBeUndefined();
  });

  it('maps a ZodError to 400 with paths and messages but no input values', () => {
    const parsed = z.object({ email: z.email(), qty: z.number().int().min(1) }).safeParse({ email: 'not-an-email-secret', qty: 0 });
    expect(parsed.success).toBe(false);
    const http = errorToHttp(parsed.error, REF);
    expect(http.status).toBe(400);
    expect(http.body.code).toBe('VALIDATION_FAILED');
    const details = http.body.details as { issues: Array<{ path: string; message: string }> };
    expect(details.issues.map((i) => i.path).sort()).toEqual(['email', 'qty']);
    expect(JSON.stringify(http.body)).not.toContain('not-an-email-secret');
  });

  it('errorResponse builds a Web Response with the same status and JSON body', async () => {
    const res = errorResponse(new errors.PermissionDeniedError(), REF);
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({ code: 'FORBIDDEN', message: new errors.PermissionDeniedError().userMessage, reference: REF });
  });
});

describe('provider error fields', () => {
  it('carries provider, providerCode and httpStatus without exposing them to users', () => {
    const err = new errors.ProviderRejectedError({ provider: 'whatsapp', providerCode: '131026', httpStatus: 400 });
    expect(err.provider).toBe('whatsapp');
    expect(err.providerCode).toBe('131026');
    expect(err.httpStatus).toBe(400);
    expect(JSON.stringify(errorToHttp(err, REF).body)).not.toContain('131026');
  });
});

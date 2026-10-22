/**
 * Email error map (E7, ADR-41, plan §6.3, §13). Resend error names (HTTP API) and SMTP reply
 * classes, with the date of the documentation check. UNVERIFIED until a live check.
 *
 * 2026-10-16 (T19): the first Resend names. 2026-10-20 (T33, ADR-100): the full name list of
 * Resend's error reference as it appeared in search snippets (resend.com could not be read
 * first-hand from the build environment), the idempotency answers and the monthly quota.
 *
 * SMTP: a 4xx reply is a transient rejection (RETRYABLE), a 5xx reply a permanent one (PERMANENT).
 * HTTP: an "in progress" idempotency answer is AMBIGUOUS (another request with the same key may
 * still send); then mapped error names win; then the shared HTTP rules (429 RETRYABLE, 5xx
 * RETRYABLE only with no-write evidence else AMBIGUOUS, other 4xx PERMANENT). Bounces and
 * complaints that arrive later by webhook are the suppression path, not dispatch failures.
 */
import { boundedError, classifyHttpFailure, type ErrorMapEntry, type ProviderFailureInput } from '../whatsapp/error-map';
import type { AmbiguousOutcome, FailedOutcome } from './port';

export const EMAIL_ERROR_MAP_CHECKED_ON = '2026-10-20';

const entry = (failureClass: ErrorMapEntry['failureClass'], reasonCode: string, note: string, throttle: ErrorMapEntry['throttleScope'] = null): ErrorMapEntry => ({
  failureClass,
  reasonCode,
  suppress: false,
  manualRetryAfterMs: null,
  throttleScope: throttle,
  verified: false,
  note,
});

/** Keyed by the provider's error `name` (Resend `{ statusCode, name, message }`). */
export const EMAIL_ERROR_MAP: Readonly<Record<string, ErrorMapEntry>> = {
  validation_error: entry('PERMANENT', 'EMAIL_VALIDATION_FAILED', 'The request was rejected as invalid (bad address, missing field, unverified domain at 403).'),
  missing_required_field: entry('PERMANENT', 'EMAIL_VALIDATION_FAILED', 'A required field (from, to, subject) is missing.'),
  invalid_parameter: entry('PERMANENT', 'EMAIL_VALIDATION_FAILED', 'A parameter has an invalid value.'),
  invalid_attachment: entry('PERMANENT', 'EMAIL_ATTACHMENT_INVALID', 'The attachment was refused (content or filename).'),
  invalid_from_address: entry('PERMANENT', 'EMAIL_FROM_INVALID', 'The sender address is malformed or its domain is not verified.'),
  invalid_access: entry('PERMANENT', 'PROVIDER_PERMISSION', 'The API key may not perform this action.'),
  invalid_region: entry('PERMANENT', 'EMAIL_REGION_INVALID', 'The sending region is not available to this account.'),
  missing_api_key: entry('PERMANENT', 'PROVIDER_AUTH', 'No API key; reconnect the integration.'),
  invalid_api_key: entry('PERMANENT', 'PROVIDER_AUTH', 'API key rejected; reconnect the integration.'),
  restricted_api_key: entry('PERMANENT', 'PROVIDER_PERMISSION', 'The API key may not send email.'),
  not_found: entry('PERMANENT', 'PROVIDER_REJECTED', 'The endpoint or resource does not exist.'),
  method_not_allowed: entry('PERMANENT', 'PROVIDER_REJECTED', 'The method is not allowed on this endpoint.'),
  invalid_idempotency_key: entry('PERMANENT', 'IDEMPOTENCY_KEY_INVALID', 'The Idempotency-Key must be 1 to 256 characters.'),
  invalid_idempotent_request: entry('PERMANENT', 'IDEMPOTENCY_KEY_REUSED', 'The key was used in the last 24 hours with a different body; this app never reuses a key across attempts.'),
  rate_limit_exceeded: entry('RETRYABLE', 'RATE_LIMITED', 'Too many requests; retry with backoff.', 'workspace'),
  daily_quota_exceeded: entry('RETRYABLE', 'PROVIDER_QUOTA', 'Daily sending quota reached; retry later.', 'workspace'),
  monthly_quota_exceeded: entry('PERMANENT', 'PROVIDER_QUOTA_MONTHLY', 'Monthly sending quota reached; retries cannot succeed before the plan resets or is upgraded.'),
  security_error: entry('PERMANENT', 'PROVIDER_REJECTED', 'The provider refused the request for a security reason.'),
};

/**
 * Names whose answer does not settle the send: another request with the same Idempotency-Key is
 * still in progress at the provider and may deliver the email. Never a failure, never retried.
 */
export const EMAIL_AMBIGUOUS_ERRORS: Readonly<Record<string, string>> = {
  concurrent_idempotent_requests: 'IDEMPOTENT_REQUEST_IN_PROGRESS',
};

export type EmailFailureInput = ProviderFailureInput & { transport: 'http' | 'smtp'; smtpCode?: number };

function smtpFailed(failureClass: FailedOutcome['failureClass'], reasonCode: string, input: EmailFailureInput): FailedOutcome {
  return { status: 'failed', failureClass, reasonCode, error: boundedError(input.message), suppress: false, manualRetryAfterMs: null, throttleScope: null };
}

export function classifyEmailFailure(input: EmailFailureInput): FailedOutcome | AmbiguousOutcome {
  if (input.transport === 'smtp' && input.phase === 'response') {
    const code = input.smtpCode ?? 0;
    if (code >= 400 && code < 500) return smtpFailed('RETRYABLE', 'SMTP_TRANSIENT', input);
    if (code >= 500 && code < 600) return smtpFailed('PERMANENT', 'SMTP_REJECTED', input);
    return { status: 'ambiguous', reasonCode: 'SMTP_UNEXPECTED_REPLY', error: boundedError(input.message) };
  }
  if (input.phase === 'response' && input.providerCode !== undefined) {
    const ambiguous = EMAIL_AMBIGUOUS_ERRORS[input.providerCode];
    if (ambiguous) return { status: 'ambiguous', reasonCode: ambiguous, error: boundedError(input.message) };
  }
  const mapped = input.providerCode !== undefined ? EMAIL_ERROR_MAP[input.providerCode] : undefined;
  return classifyHttpFailure(input, mapped);
}

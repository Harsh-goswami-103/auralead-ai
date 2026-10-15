/**
 * Email error map (E7, ADR-41, plan §6.3, §13). Resend error names (HTTP API) and SMTP reply
 * classes, with the date of the documentation check. UNVERIFIED until a live check (T33).
 *
 * SMTP: a 4xx reply is a transient rejection (RETRYABLE), a 5xx reply a permanent one (PERMANENT).
 * HTTP: mapped error names win, then the shared HTTP rules (429 RETRYABLE, 5xx RETRYABLE only with
 * no-write evidence else AMBIGUOUS, other 4xx PERMANENT). Bounces and complaints that arrive later
 * by webhook are T20's suppression path, not dispatch failures.
 */
import { boundedError, classifyHttpFailure, type ErrorMapEntry, type ProviderFailureInput } from '../whatsapp/error-map';
import type { AmbiguousOutcome, FailedOutcome } from './port';

export const EMAIL_ERROR_MAP_CHECKED_ON = '2026-10-16';

const entry = (failureClass: ErrorMapEntry['failureClass'], reasonCode: string, note: string, throttle: ErrorMapEntry['throttleScope'] = null): ErrorMapEntry => ({
  failureClass,
  reasonCode,
  suppress: false,
  manualRetryAfterMs: null,
  throttleScope: throttle,
  verified: false,
  note,
});

/** Keyed by the provider's error `name` (Resend). */
export const EMAIL_ERROR_MAP: Readonly<Record<string, ErrorMapEntry>> = {
  validation_error: entry('PERMANENT', 'EMAIL_VALIDATION_FAILED', 'The request was rejected as invalid (bad address, missing field).'),
  invalid_from_address: entry('PERMANENT', 'EMAIL_FROM_INVALID', 'The sender domain is not verified.'),
  missing_api_key: entry('PERMANENT', 'PROVIDER_AUTH', 'No API key; reconnect the integration.'),
  invalid_api_key: entry('PERMANENT', 'PROVIDER_AUTH', 'API key rejected; reconnect the integration.'),
  restricted_api_key: entry('PERMANENT', 'PROVIDER_PERMISSION', 'The API key may not send email.'),
  rate_limit_exceeded: entry('RETRYABLE', 'RATE_LIMITED', 'Too many requests; retry with backoff.', 'workspace'),
  daily_quota_exceeded: entry('RETRYABLE', 'PROVIDER_QUOTA', 'Daily sending quota reached; retry later.', 'workspace'),
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
  const mapped = input.providerCode !== undefined ? EMAIL_ERROR_MAP[input.providerCode] : undefined;
  return classifyHttpFailure(input, mapped);
}

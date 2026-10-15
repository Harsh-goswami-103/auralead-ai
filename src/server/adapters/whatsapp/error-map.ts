/**
 * WhatsApp Cloud API error map (E7, ADR-41, C16, plan §6.3, §13). One dated table: every provider
 * code the dispatch path understands, with its failure class and the reason code stored on the
 * DispatchAttempt. Checked against Meta's published error-code reference on the date below, but
 * the semantics are UNVERIFIED until a live check (plan §12.3): every entry says `verified: false`.
 *
 * Classification order: a mapped provider code wins; then the HTTP status (429 RETRYABLE; 5xx
 * RETRYABLE only with no-write evidence, else AMBIGUOUS; any other 4xx PERMANENT). A failure
 * before the request was written is PRE_SEND; a timeout or reset after the write is AMBIGUOUS
 * (no blind resend).
 */
import { redactText } from '@/lib/redact';
import type { AmbiguousOutcome, FailedOutcome, FailureClass } from './port';

export const WHATSAPP_ERROR_MAP_CHECKED_ON = '2026-10-16';

export type ErrorMapEntry = {
  failureClass: FailureClass;
  reasonCode: string;
  /** The provider reports an opt-out: write a suppression (only through messaging/suppression.ts). */
  suppress: boolean;
  /** A person may retry only after this long; null when retry is the job runtime's business. */
  manualRetryAfterMs: number | null;
  throttleScope: 'workspace' | 'pair' | null;
  verified: false;
  note: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const WA_CODES = {
  FREQUENCY_CAP: '131049',
  UNDELIVERABLE: '131026',
  WINDOW_CLOSED: '131047',
  MARKETING_STOPPED: '131050',
  RATE_LIMITED: '130429',
  PAIR_RATE_LIMITED: '131056',
  TEMPLATE_PARAMS: '132000',
  TEMPLATE_MISSING: '132001',
  TEMPLATE_PAUSED: '132015',
  UNSUPPORTED_TYPE: '131051',
  ACCESS_TOKEN: '190',
  INVALID_PARAMETER: '100',
} as const;

const permanent = (reasonCode: string, note: string, extra: Partial<ErrorMapEntry> = {}): ErrorMapEntry => ({
  failureClass: 'PERMANENT',
  reasonCode,
  suppress: false,
  manualRetryAfterMs: null,
  throttleScope: null,
  verified: false,
  note,
  ...extra,
});

export const WHATSAPP_ERROR_MAP: Readonly<Record<string, ErrorMapEntry>> = {
  [WA_CODES.FREQUENCY_CAP]: permanent('RECIPIENT_FREQUENCY_CAP', 'Marketing frequency cap for this user; back to review, manual retry after 24 h (C16).', {
    manualRetryAfterMs: DAY_MS,
  }),
  [WA_CODES.UNDELIVERABLE]: permanent('UNDELIVERABLE', 'Message undeliverable; no retry and no suppression.'),
  [WA_CODES.WINDOW_CLOSED]: permanent('WINDOW_CLOSED', 'Re-engagement message outside the 24 h window; review or template, never free-form.'),
  [WA_CODES.MARKETING_STOPPED]: permanent('MARKETING_STOPPED', 'The user stopped marketing messages from this business; suppress.', { suppress: true }),
  [WA_CODES.TEMPLATE_PARAMS]: permanent('TEMPLATE_PARAMS_MISMATCH', 'Template parameter count or format does not match.'),
  [WA_CODES.TEMPLATE_MISSING]: permanent('TEMPLATE_NOT_FOUND', 'Template name or language does not exist.'),
  [WA_CODES.TEMPLATE_PAUSED]: permanent('TEMPLATE_PAUSED', 'Template paused for low quality.'),
  [WA_CODES.UNSUPPORTED_TYPE]: permanent('UNSUPPORTED_MESSAGE_TYPE', 'Message type not supported.'),
  [WA_CODES.ACCESS_TOKEN]: permanent('PROVIDER_AUTH', 'Access token invalid or expired; reconnect the integration.'),
  [WA_CODES.INVALID_PARAMETER]: permanent('INVALID_PARAMETER', 'Invalid request parameter.'),
  [WA_CODES.RATE_LIMITED]: {
    failureClass: 'RETRYABLE',
    reasonCode: 'RATE_LIMITED',
    suppress: false,
    manualRetryAfterMs: null,
    throttleScope: 'workspace',
    verified: false,
    note: 'Cloud API throughput limit reached; retry with backoff and defer later sends.',
  },
  [WA_CODES.PAIR_RATE_LIMITED]: {
    failureClass: 'RETRYABLE',
    reasonCode: 'PAIR_RATE_LIMITED',
    suppress: false,
    manualRetryAfterMs: null,
    throttleScope: 'pair',
    verified: false,
    note: 'Too many messages to the same user in a short time; retry later for this pair only.',
  },
};

export type ProviderFailureInput = {
  /** before-write: DNS, connect refused, TLS before the request; after-write: timeout or reset after it; response: an HTTP answer. */
  phase: 'before-write' | 'after-write' | 'response';
  httpStatus?: number;
  providerCode?: string;
  /** The error map or response proves the provider did not act on the request (5xx only). */
  noWriteEvidence?: boolean;
  retryAfterMs?: number;
  message: string;
};

const MAX_ERROR = 500;

export function boundedError(message: string): string {
  return redactText(message).slice(0, MAX_ERROR);
}

function failed(failureClass: FailureClass, reasonCode: string, input: ProviderFailureInput, extra: Partial<FailedOutcome> = {}): FailedOutcome {
  return {
    status: 'failed',
    failureClass,
    reasonCode,
    error: boundedError(input.message),
    suppress: false,
    manualRetryAfterMs: null,
    throttleScope: null,
    ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
    ...extra,
  };
}

/** The HTTP-status rules shared by every HTTP provider (WhatsApp, Resend). */
export function classifyHttpFailure(input: ProviderFailureInput, entry: ErrorMapEntry | undefined): FailedOutcome | AmbiguousOutcome {
  if (input.phase === 'before-write') return failed('PRE_SEND', 'CONNECT_FAILED', input);
  if (input.phase === 'after-write') return { status: 'ambiguous', reasonCode: 'TIMEOUT_AFTER_WRITE', error: boundedError(input.message) };
  if (entry) {
    return failed(entry.failureClass, entry.reasonCode, input, {
      suppress: entry.suppress,
      manualRetryAfterMs: entry.manualRetryAfterMs,
      throttleScope: entry.throttleScope,
    });
  }
  const status = input.httpStatus ?? 0;
  if (status === 429) return failed('RETRYABLE', 'RATE_LIMITED', input, { throttleScope: 'workspace' });
  if (status >= 500) {
    if (input.noWriteEvidence === true) return failed('RETRYABLE', 'PROVIDER_UNAVAILABLE', input);
    return { status: 'ambiguous', reasonCode: 'PROVIDER_5XX_UNCONFIRMED', error: boundedError(input.message) };
  }
  if (status >= 400) return failed('PERMANENT', 'PROVIDER_REJECTED', input);
  // A non-error status without a message id is not a confirmed send.
  return { status: 'ambiguous', reasonCode: 'NO_MESSAGE_ID', error: boundedError(input.message) };
}

export function classifyWhatsAppFailure(input: ProviderFailureInput): FailedOutcome | AmbiguousOutcome {
  const entry = input.providerCode !== undefined ? WHATSAPP_ERROR_MAP[input.providerCode] : undefined;
  return classifyHttpFailure(input, entry);
}

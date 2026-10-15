/**
 * Correlation ids (plan §4.1): taken from `x-request-id` when it is well formed, otherwise
 * generated. Stored on Job, JobAttempt and AuditEvent and returned to users as `reference`.
 * Incoming values are restricted to a safe charset so they cannot inject log lines or markup.
 */
import { randomBase64Url } from './ids';

export const CORRELATION_HEADER = 'x-request-id';

const VALID = /^[A-Za-z0-9._:-]{8,128}$/;

export function newCorrelationId(): string {
  return `req_${randomBase64Url(16)}`;
}

export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && VALID.test(value);
}

/** The incoming id if it is safe, else a fresh one. */
export function resolveCorrelationId(incoming: string | null | undefined): string {
  return isValidCorrelationId(incoming) ? incoming : newCorrelationId();
}

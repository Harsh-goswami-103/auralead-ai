/**
 * The single mapping from thrown values to HTTP (plan §9 Logging, R41). Users see
 * `{ code, message, reference }` and, for client errors only, redacted `details`. The stack,
 * the internal message and the cause never reach the body. Framework-free: `withRoute()`
 * (T06) uses `errorResponse`, other callers can use the plain `errorToHttp` shape.
 */
import { ZodError } from 'zod';
import { redact } from '../redact';
import { AppError } from './app-error';
import { InternalError, ValidationError } from './classes';

export type ErrorBody = {
  code: string;
  message: string;
  reference: string;
  details?: unknown;
};

export type HttpError = {
  status: number;
  headers: Record<string, string>;
  body: ErrorBody;
};

function fromZod(err: ZodError): ValidationError {
  const issues = err.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    code: issue.code,
    message: issue.message,
  }));
  return new ValidationError({ safeDetails: { issues }, cause: err });
}

/** Normalizes any thrown value to an AppError. Unknown values become InternalError. */
export function toAppError(thrown: unknown): AppError {
  if (thrown instanceof AppError) return thrown;
  if (thrown instanceof ZodError) return fromZod(thrown);
  return new InternalError({ cause: thrown });
}

export function errorToHttp(thrown: unknown, correlationId: string): HttpError {
  const err = toAppError(thrown);
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  };
  if (err.retryAfterSeconds !== undefined) headers['retry-after'] = String(err.retryAfterSeconds);

  const body: ErrorBody = { code: err.code, message: err.userMessage, reference: err.correlationId ?? correlationId };
  if (err.status < 500 && err.safeDetails !== undefined) body.details = redact(err.safeDetails);
  return { status: err.status, headers, body };
}

export function errorResponse(thrown: unknown, correlationId: string): Response {
  const { status, headers, body } = errorToHttp(thrown, correlationId);
  return new Response(JSON.stringify(body), { status, headers });
}

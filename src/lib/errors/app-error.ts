/**
 * Typed application errors (plan §9 Logging, 02-errors §2.0-2.1). Services throw AppError
 * subclasses; routes turn them into HTTP responses only through `errorToHttp` (./http.ts).
 *
 * - `message` is the internal, log-facing text (still redacted before logging).
 * - `userMessage` is the only text a user ever sees.
 * - `safeDetails` holds structured, non-secret context (ids, limits, field names).
 * Each subclass declares its HTTP status, default code, retryability and user message as
 * static fields; instances read them through `new.target`, so a subclass is one short block.
 */
export type SafeDetails = Readonly<Record<string, unknown>>;

export type AppErrorOptions = {
  /** Internal message for logs. Defaults to the user message. */
  message?: string;
  /** Overrides the class default code (for example BATCH_CONTENT_MISMATCH on a 409). */
  code?: string;
  userMessage?: string;
  safeDetails?: SafeDetails;
  correlationId?: string;
  cause?: unknown;
  /** Seconds a client should wait before retrying (sets Retry-After). */
  retryAfterSeconds?: number;
};

type AppErrorStatics = {
  readonly status: number;
  readonly defaultCode: string;
  readonly defaultRetryable: boolean;
  readonly defaultUserMessage: string;
};

export abstract class AppError extends Error {
  static readonly status: number = 500;
  static readonly defaultCode: string = 'INTERNAL';
  static readonly defaultRetryable: boolean = false;
  static readonly defaultUserMessage: string = 'Something went wrong. Quote the reference if you contact support.';

  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly safeDetails: SafeDetails | undefined;
  readonly correlationId: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(opts: AppErrorOptions = {}) {
    const statics = new.target as unknown as AppErrorStatics;
    if ((new.target as unknown) === AppError) throw new TypeError('AppError is abstract; throw a subclass');
    const userMessage = opts.userMessage ?? statics.defaultUserMessage;
    super(opts.message ?? userMessage, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    this.status = statics.status;
    this.code = opts.code ?? statics.defaultCode;
    this.retryable = statics.defaultRetryable;
    this.userMessage = userMessage;
    this.safeDetails = opts.safeDetails;
    this.correlationId = opts.correlationId;
    if (opts.retryAfterSeconds !== undefined && (!Number.isInteger(opts.retryAfterSeconds) || opts.retryAfterSeconds < 0)) {
      throw new RangeError('retryAfterSeconds must be a non-negative integer');
    }
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

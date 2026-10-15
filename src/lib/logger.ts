/**
 * Structured logging (plan §2.1 pino, §9 Logging, R41). JSON lines, no transports. Every
 * merged object and every message string goes through `redact()`, so secrets and PII are
 * removed at any depth (pino's own `redact` paths only cover fixed paths). Errors are logged as
 * `{ name, message }` without stacks. Pretty output is a dev pipe (`| pino-pretty`) only.
 */
import pino, { type DestinationStream, type Logger } from 'pino';
import { redact, redactText } from './redact';

export type { Logger } from 'pino';
export type LogLevelName = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export type CreateLoggerOptions = {
  level?: LogLevelName;
  /** Defaults to stdout. Tests pass an in-memory stream. */
  destination?: DestinationStream;
  /** Fields bound to every line (e.g. `{ service: 'worker' }`). */
  base?: Record<string, unknown>;
};

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const options: pino.LoggerOptions = {
    level: opts.level ?? 'info',
    base: opts.base ? (redact(opts.base) as Record<string, unknown>) : null,
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    // Replace pino's default err serializer (which adds `type` and `stack`): errors are already
    // flattened to `{ name, message }` by `redact` in formatters.log, which runs first.
    serializers: { err: (value: unknown) => redact(value) },
    formatters: {
      level: (label) => ({ level: label }),
      bindings: (bindings) => redact(bindings) as Record<string, unknown>,
      log: (obj) => redact(obj) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const cleaned = args.map((a) => (typeof a === 'string' ? redactText(a) : a)) as Parameters<typeof method>;
        method.apply(this, cleaned);
      },
    },
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
}

/** A child logger that stamps `correlationId` on every line. */
export function withCorrelation(logger: Logger, correlationId: string): Logger {
  return logger.child({ correlationId });
}

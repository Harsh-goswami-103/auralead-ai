/**
 * Retry timing and attempt limits (plan §4.3): delay = min(base * 2^(n-1), cap) plus jitter, where
 * n is the 1-based number of the attempt that just failed. Jitter is a random fraction (up to
 * `jitterRatio`) of the exponential delay, so the delay never shrinks as n grows. A provider
 * Retry-After longer than the backoff wins.
 */

export type BackoffPolicy = {
  baseMs: number;
  capMs: number;
  /** 0..1: extra random delay as a fraction of the exponential delay. */
  jitterRatio: number;
};

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 5_000, capMs: 15 * 60_000, jitterRatio: 0.2 };

export type JobKind = 'send' | 'ai' | 'fetch' | 'pdf' | 'default';

export const MAX_ATTEMPTS_BY_KIND: Readonly<Record<JobKind, number>> = { send: 5, ai: 3, fetch: 8, pdf: 3, default: 5 };

export function maxAttemptsFor(kind: JobKind = 'default'): number {
  return MAX_ATTEMPTS_BY_KIND[kind];
}

function assertPolicy(policy: BackoffPolicy): void {
  const { baseMs, capMs, jitterRatio } = policy;
  if (!Number.isFinite(baseMs) || baseMs < 0) throw new RangeError('backoff baseMs must be a non-negative number');
  if (!Number.isFinite(capMs) || capMs < baseMs) throw new RangeError('backoff capMs must be >= baseMs');
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) throw new RangeError('backoff jitterRatio must be within 0..1');
}

export function backoffDelayMs(failedAttempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  if (!Number.isInteger(failedAttempt) || failedAttempt < 1) throw new RangeError('failedAttempt must be a positive integer');
  assertPolicy(policy);
  // 2^(n-1) overflows to Infinity for large n; Math.min with the cap keeps it finite.
  const exponential = Math.min(policy.baseMs * 2 ** Math.min(failedAttempt - 1, 1_000), policy.capMs);
  const r = Math.min(Math.max(random(), 0), 0.999_999_999);
  return Math.floor(exponential + exponential * policy.jitterRatio * r);
}

export function retryDelayMs(
  failedAttempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  options: { retryAfterMs?: number; random?: () => number } = {},
): number {
  const backoff = backoffDelayMs(failedAttempt, policy, options.random);
  const retryAfter = options.retryAfterMs !== undefined && Number.isFinite(options.retryAfterMs) ? Math.max(0, Math.ceil(options.retryAfterMs)) : 0;
  return Math.max(backoff, retryAfter);
}

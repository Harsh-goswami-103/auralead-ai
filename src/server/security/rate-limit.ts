/**
 * In-process token-bucket rate limiting (C6, ADR-12). Single instance only: a multi-instance
 * deployment needs a shared store (plan §5.8). Time comes from the injected clock, never Date.now().
 */
import ipaddr from 'ipaddr.js';

/** Structural subset of the app Clock (src/lib/clock.ts). */
export type NowSource = { now(): Date };

export type RateLimitPolicy = { limit: number; windowMs: number };

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  /** Whole tokens left after this request. */
  remaining: number;
  /** 0 when allowed; otherwise time until enough tokens are available. */
  retryAfterMs: number;
  /** For the Retry-After header (rounded up, at least 1 when denied). */
  retryAfterSeconds: number;
};

/** Plan §9 limits. Keys are composed by callers, e.g. `ip:<addr>`, `email:<addr>`, `key:<id>`. */
export const RATE_LIMIT_POLICIES = {
  loginIp: { limit: 5, windowMs: 60_000 },
  loginEmail: { limit: 5, windowMs: 60_000 },
  inviteReset: { limit: 10, windowMs: 3_600_000 },
  publicQuote: { limit: 30, windowMs: 60_000 },
  extension: { limit: 60, windowMs: 60_000 },
  appsScript: { limit: 120, windowMs: 60_000 },
  metaWebhook: { limit: 600, windowMs: 60_000 },
  aiDraft: { limit: 30, windowMs: 60_000 },
  // Lead-gen suite (docs/handoff/lead-gen-suite-plan.md §4 B3):
  /** Lead Finder run starts per workspace: each run makes paid Places calls (ADR-118). */
  finderRun: { limit: 10, windowMs: 3_600_000 },
  /** Spreadsheet uploads and import confirmations (bodies up to about 7 MB, ADR-120). */
  leadImport: { limit: 10, windowMs: 60_000 },
  /** Template submissions per workspace, far below Meta's own per-account creation limit (ADR-123). */
  templateSubmit: { limit: 20, windowMs: 3_600_000 },
  /** Lead handoffs per person (ADR-124; a second handoff of a lead is 409 anyway). */
  handoff: { limit: 30, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;

/**
 * Credit is kept in integer units of `ms * limit`: one token costs exactly `windowMs` units and
 * one elapsed millisecond earns `limit` units. The arithmetic stays exact (no float drift at the
 * refill boundary) for every policy, even when windowMs is not a multiple of limit.
 */
type Bucket = { credit: number; updatedMs: number };

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly sweepThreshold: number;

  constructor(
    readonly policy: RateLimitPolicy,
    private readonly clock: NowSource,
    options: { sweepThreshold?: number } = {},
  ) {
    if (!Number.isInteger(policy.limit) || policy.limit < 1) throw new Error('Rate limit must be a positive integer');
    if (!Number.isInteger(policy.windowMs) || policy.windowMs <= 0) throw new Error('Rate limit window must be a positive integer (ms)');
    this.capacity = policy.limit * policy.windowMs;
    if (!Number.isSafeInteger(this.capacity)) throw new Error('Rate limit policy is too large');
    this.sweepThreshold = options.sweepThreshold ?? 10_000;
  }

  private refill(bucket: Bucket, nowMs: number): void {
    // A clock that moves backwards grants nothing; the bucket waits until time passes it again.
    const elapsed = nowMs - bucket.updatedMs;
    if (elapsed <= 0) return;
    bucket.credit = Math.min(this.capacity, bucket.credit + elapsed * this.policy.limit);
    bucket.updatedMs = nowMs;
  }

  take(key: string, cost = 1): RateLimitDecision {
    if (!Number.isInteger(cost) || cost < 1 || cost > this.policy.limit) {
      throw new Error('Rate limit cost must be an integer between 1 and the limit');
    }
    const nowMs = this.clock.now().getTime();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { credit: this.capacity, updatedMs: nowMs };
      this.buckets.set(key, bucket);
    } else {
      this.refill(bucket, nowMs);
    }

    const price = cost * this.policy.windowMs;
    let decision: RateLimitDecision;
    if (bucket.credit >= price) {
      bucket.credit -= price;
      decision = {
        allowed: true,
        limit: this.policy.limit,
        remaining: Math.floor(bucket.credit / this.policy.windowMs),
        retryAfterMs: 0,
        retryAfterSeconds: 0,
      };
    } else {
      const retryAfterMs = Math.ceil((price - bucket.credit) / this.policy.limit);
      decision = {
        allowed: false,
        limit: this.policy.limit,
        remaining: Math.floor(bucket.credit / this.policy.windowMs),
        retryAfterMs,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    if (this.buckets.size > this.sweepThreshold) this.sweep(nowMs);
    return decision;
  }

  /** Drops buckets that have refilled completely; forgetting them changes no future decision. */
  private sweep(nowMs: number): void {
    for (const [key, bucket] of this.buckets) {
      this.refill(bucket, nowMs);
      if (bucket.credit >= this.capacity) this.buckets.delete(key);
    }
  }

  size(): number {
    return this.buckets.size;
  }
}

export type RateLimiters = { [K in RateLimitPolicyName]: RateLimiter };

/** One limiter per §9 policy. The web process holds one instance built on the system clock. */
export function createRateLimiters(clock: NowSource): RateLimiters {
  const out = {} as RateLimiters;
  for (const name of Object.keys(RATE_LIMIT_POLICIES) as RateLimitPolicyName[]) {
    out[name] = new RateLimiter(RATE_LIMIT_POLICIES[name], clock);
  }
  return out;
}

function normalizeIp(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!ipaddr.isValid(trimmed)) return null;
  return ipaddr.process(trimmed).toString();
}

/**
 * Client IP for rate-limit keys. Without trusted proxies the socket address is used and
 * X-Forwarded-For is ignored. With TRUSTED_PROXY_HOPS = N, the Nth X-Forwarded-For entry from
 * the right is the client (each trusted proxy appends the address it received from); if the
 * header is shorter, the leftmost entry is used.
 */
export function clientIp(headers: Headers, socketAddress: string | null, trustedProxyHops: number): string {
  if (trustedProxyHops > 0) {
    const chain = (headers.get('x-forwarded-for') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (chain.length > 0) {
      const index = Math.max(0, chain.length - trustedProxyHops);
      return normalizeIp(chain[index]) ?? 'unknown';
    }
  }
  return normalizeIp(socketAddress) ?? 'unknown';
}

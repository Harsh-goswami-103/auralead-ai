/**
 * The one wrapper for route handlers (ADR-26, plan §4 diagram, §9). Order:
 *   mode gates (demoOnly, testControl: 404) -> raw body with size cap -> auth (session cookie ->
 *   ctx, or a public ctx) -> role / re-auth -> rate limit -> CSRF (cookie mutations: Origin +
 *   signed token; cookie-less mutations: Origin) -> browser identity check -> Zod -> capability
 *   -> handler -> typed result -> HTTP.
 * Every response carries `x-request-id` and `Cache-Control: no-store`. Errors are rendered by
 * `errorResponse` only, so users see `{ code, message, reference }` and never a stack.
 *
 * Browser-supplied `workspaceId`, `userId` or `role` (top-level body keys or query params) are
 * never used: a value that differs from the resolved context is a 404 (A6), and the Zod schema
 * strips the keys before the handler sees the body.
 */
import { z } from 'zod';
import { isTestClockAllowed } from '@/lib/clock';
import { CORRELATION_HEADER, resolveCorrelationId } from '@/lib/correlation';
import type { Capability, GlobalRole } from '@/lib/domain/enums';
import { CsrfError, errorResponse, NotFoundError, RateLimitedError, toAppError, ValidationError } from '@/lib/errors';
import { getRequestContext, publicContext, type AppCtx } from '@/server/auth/context';
import { requireCapability, requireRecentReauth, requireRole } from '@/server/auth/guards';
import { normalizeServerError } from '@/server/auth/http-errors';
import type { LoadedSession } from '@/server/auth/session';
import { getRuntime, requestClock, type Runtime } from '@/server/boot';
import { checkCsrf, checkOrigin } from '@/server/security/csrf';
import { safeEqual } from '@/server/security/hmac';
import { clientIp, type RateLimitPolicyName } from '@/server/security/rate-limit';
import { readRawBody } from '@/server/security/raw-body';

export const TEST_CONTROL_HEADER = 'x-test-control-token';
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const IDENTITY_KEYS = ['workspaceId', 'userId', 'role'] as const;

export type RateRule = {
  policy: RateLimitPolicyName;
  /** Bucket key for this request, or null to skip this rule. `body` is the parsed JSON, unvalidated. */
  key: (input: { ip: string; body: unknown; ctx: AppCtx }) => string | null;
};

export type RouteOptions<S extends z.ZodType | undefined> = {
  auth: 'session' | 'none';
  body?: S;
  maxBodyBytes?: number;
  /** Cookie mutations need Origin + X-CSRF-Token (default true for auth 'session'). */
  csrf?: boolean;
  /** Cookie-less mutations (login, persona switch) need Origin = APP_ORIGIN (default true). */
  origin?: boolean;
  rateLimit?: RateRule[];
  roles?: GlobalRole[];
  capability?: Capability;
  /** Name of the `[ws]` route segment whose slug selects the workspace. */
  workspaceParam?: string;
  /** Require a password re-entry within 15 minutes. */
  reauth?: boolean;
  /** 404 unless the process is in DEMO. */
  demoOnly?: boolean;
  /** 404 unless DEMO + AURALEAD_TEST_CONTROL=1 + the right x-test-control-token. */
  testControl?: boolean;
};

export type RouteArgs<B> = {
  req: Request;
  ctx: AppCtx;
  session: LoadedSession | null;
  body: B;
  params: Record<string, string | string[] | undefined>;
  runtime: Runtime;
  ip: string;
  correlationId: string;
  /** Adds a Set-Cookie header to the response. */
  setCookie: (cookie: string) => void;
};

type BodyOf<S> = S extends z.ZodType ? z.output<S> : undefined;
export type SegmentData = { params: Promise<Record<string, string | string[] | undefined>> };
export type RouteHandler = (req: Request, segment: SegmentData) => Promise<Response>;

function parseJson(raw: Buffer): unknown {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch (error) {
    throw new ValidationError({ code: 'INVALID_JSON', userMessage: 'The request body is not valid JSON.', cause: error });
  }
}

function assertNoForeignIdentity(ctx: AppCtx, url: URL, body: unknown): void {
  const resolved: Record<(typeof IDENTITY_KEYS)[number], string | null> = {
    workspaceId: ctx.workspaceId,
    userId: ctx.actor?.userId ?? null,
    role: ctx.actor?.role ?? null,
  };
  const bodyRecord = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  for (const key of IDENTITY_KEYS) {
    const values: unknown[] = [...url.searchParams.getAll(key)];
    if (key in bodyRecord) values.push(bodyRecord[key]);
    for (const value of values) {
      if (value !== resolved[key]) throw new NotFoundError({ message: `browser-supplied ${key} differs from the resolved context` });
    }
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data ?? { ok: true }), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function finalize(res: Response, correlationId: string, cookies: string[]): Response {
  const headers = new Headers(res.headers);
  headers.set(CORRELATION_HEADER, correlationId);
  headers.set('cache-control', 'no-store');
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function withRoute<S extends z.ZodType | undefined = undefined>(
  options: RouteOptions<S>,
  handler: (args: RouteArgs<BodyOf<S>>) => Promise<unknown>,
): RouteHandler {
  return async (req, segment) => {
    const correlationId = resolveCorrelationId(req.headers.get(CORRELATION_HEADER));
    const cookies: string[] = [];
    let runtime: Runtime | null = null;
    try {
      runtime = getRuntime();
      const { config } = runtime;
      if (options.demoOnly && config.mode !== 'demo') throw new NotFoundError();
      if (options.testControl) {
        const presented = req.headers.get(TEST_CONTROL_HEADER) ?? '';
        if (!isTestClockAllowed(config) || !safeEqual(presented, config.testControl.token ?? '')) throw new NotFoundError();
      }

      const method = req.method.toUpperCase();
      const unsafe = !SAFE_METHODS.has(method);
      const raw = unsafe ? await readRawBody(req, { maxBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES }) : Buffer.alloc(0);
      const params = (await segment.params) ?? {};
      const clock = await requestClock(runtime);
      const deps = { prisma: runtime.prisma, mode: config.mode, clock, config };

      let ctx: AppCtx;
      let session: LoadedSession | null = null;
      if (options.auth === 'session') {
        const slugParam = options.workspaceParam === undefined ? undefined : params[options.workspaceParam];
        if (options.workspaceParam !== undefined && typeof slugParam !== 'string') throw new NotFoundError();
        const resolved = await getRequestContext(req, deps, { correlationId, workspaceSlug: slugParam as string | undefined });
        ctx = resolved.ctx;
        session = resolved.session;
      } else {
        ctx = publicContext(deps, correlationId);
      }
      if (options.roles) requireRole(ctx, ...options.roles);
      if (options.reauth) {
        if (!session) throw new NotFoundError();
        requireRecentReauth(session.session, clock.now());
      }

      const ip = clientIp(req.headers, null, config.trustedProxyHops);
      const json = parseJson(raw);
      for (const rule of options.rateLimit ?? []) {
        const key = rule.key({ ip, body: json, ctx });
        if (key === null) continue;
        const decision = runtime.limiters[rule.policy].take(key);
        if (!decision.allowed) throw new RateLimitedError({ retryAfterSeconds: decision.retryAfterSeconds });
      }

      if (unsafe && session !== null && options.csrf !== false) {
        const check = checkCsrf({ method, headers: req.headers, appOrigin: config.appOrigin, sessionSecret: config.secrets.sessionSecret ?? '', sessionId: session.session.id });
        if (!check.ok) throw new CsrfError({ message: `CSRF check failed: ${check.reason}` });
      } else if (unsafe && session === null && options.origin !== false) {
        const check = checkOrigin(req.headers, config.appOrigin);
        if (!check.ok) throw new CsrfError({ message: `Origin check failed: ${check.reason}` });
      }

      if (options.auth === 'session') assertNoForeignIdentity(ctx, new URL(req.url), json);

      const body = (options.body ? options.body.parse(json) : undefined) as BodyOf<S>;
      if (options.capability) requireCapability(ctx, options.capability);

      const result = await handler({ req, ctx, session, body, params, runtime, ip, correlationId, setCookie: (c) => cookies.push(c) });
      return finalize(result instanceof Response ? result : jsonResponse(result), correlationId, cookies);
    } catch (thrown) {
      const error = toAppError(normalizeServerError(thrown));
      if (error.status >= 500) {
        const payload = { err: thrown, correlationId, code: error.code };
        if (runtime) runtime.logger.error(payload, 'route failed');
        else console.error('route failed before boot', { correlationId, name: (thrown as Error)?.name });
      }
      return finalize(errorResponse(error, correlationId), correlationId, []);
    }
  };
}

export { jsonResponse };

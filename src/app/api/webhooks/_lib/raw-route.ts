/**
 * The wrapper for provider webhooks and the one-click unsubscribe (T20): routes that authenticate
 * the raw bytes (a signature or a signed token) and must not be parsed as JSON before that
 * (plan §9 Webhooks: the body is read once, capped, and never through `req.json()`). It gives the
 * handler the raw body, the runtime, the request clock and the correlation id; cookies are never
 * read. Errors render through `errorResponse` only (`{ code, message, reference }`), and every
 * response carries `x-request-id` and `Cache-Control: no-store`, exactly as `withRoute` does.
 */
import { CORRELATION_HEADER, resolveCorrelationId } from '@/lib/correlation';
import { errorResponse, NotFoundError, toAppError } from '@/lib/errors';
import type { Clock } from '@/lib/clock';
import { normalizeServerError } from '@/server/auth/http-errors';
import { getRuntime, requestClock, type Runtime } from '@/server/boot';
import { readRawBody } from '@/server/security/raw-body';
import type { RouteHandler } from '../../_lib/with-route';

export type RawRouteArgs = {
  req: Request;
  raw: Buffer;
  params: Record<string, string | string[] | undefined>;
  runtime: Runtime;
  clock: Clock;
  correlationId: string;
};

function finalize(res: Response, correlationId: string): Response {
  const headers = new Headers(res.headers);
  headers.set(CORRELATION_HEADER, correlationId);
  headers.set('cache-control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function rawRoute(options: { maxBytes: number; demoOnly?: boolean }, handler: (args: RawRouteArgs) => Promise<Response>): RouteHandler {
  return async (req, segment) => {
    const correlationId = resolveCorrelationId(req.headers.get(CORRELATION_HEADER));
    let runtime: Runtime | null = null;
    try {
      runtime = getRuntime();
      if (options.demoOnly && runtime.config.mode !== 'demo') throw new NotFoundError();
      const method = req.method.toUpperCase();
      const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readRawBody(req, { maxBytes: options.maxBytes });
      const params = (await segment.params) ?? {};
      const clock = await requestClock(runtime);
      return finalize(await handler({ req, raw, params, runtime, clock, correlationId }), correlationId);
    } catch (thrown) {
      const error = toAppError(normalizeServerError(thrown));
      if (error.status >= 500) {
        if (runtime) runtime.logger.error({ err: thrown, correlationId, code: error.code }, 'webhook route failed');
        else console.error('webhook route failed before boot', { correlationId, name: (thrown as Error)?.name });
      }
      return finalize(errorResponse(error, correlationId), correlationId);
    }
  };
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

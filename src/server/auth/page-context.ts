/**
 * Context for React Server Component pages (plan §4: RSC pages read through services with ctx).
 * Reads the request headers through next/headers and runs the same session loader and context
 * builder as `withRoute`, so pages and route handlers can never disagree about who is signed in.
 * Returns null when there is no valid session (the page decides whether to redirect to /login).
 * Not importable from the worker: it depends on the Next request scope.
 */
import { headers } from 'next/headers';
import { CORRELATION_HEADER, resolveCorrelationId } from '@/lib/correlation';
import { AuthError } from '@/lib/errors';
import { getRuntime, requestClock } from '@/server/boot';
import { getRequestContext, type AppCtx } from './context';
import { csrfTokenForSession } from './issue';
import type { LoadedSession } from './session';

export type PageContext = { ctx: AppCtx; session: LoadedSession; csrfToken: string };

export async function getPageContext(opts: { workspaceSlug?: string } = {}): Promise<PageContext | null> {
  const runtime = getRuntime();
  const incoming = await headers();
  const correlationId = resolveCorrelationId(incoming.get(CORRELATION_HEADER));
  const clock = await requestClock(runtime);
  const req = new Request(runtime.config.appOrigin, { headers: new Headers(incoming) });
  try {
    const { ctx, session } = await getRequestContext(
      req,
      { prisma: runtime.prisma, mode: runtime.config.mode, clock, config: runtime.config },
      { correlationId, workspaceSlug: opts.workspaceSlug },
    );
    return { ctx, session, csrfToken: csrfTokenForSession(runtime.config, session.session.id) };
  } catch (error) {
    if (error instanceof AuthError) return null;
    throw error;
  }
}

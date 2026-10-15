/**
 * Workspace selection for the lead console routes (T17). The console lives under the employee's
 * `[ws]` pages, so its calls name the workspace by slug; the slug is resolved by the same
 * `buildUserContext` as a `[ws]` segment (an OWNER/MEMBER membership, or an active employee
 * assignment), so a slug outside the caller's access is 404 and a missing capability is 403. The
 * request's correlation id is kept. Without a slug the session's active workspace applies.
 */
import { NotFoundError } from '@/lib/errors';
import { buildUserContext, type AppCtx } from '@/server/auth/context';
import type { LoadedSession } from '@/server/auth/session';
import type { Runtime } from '@/server/boot';

export async function consoleContext(args: { ctx: AppCtx; session: LoadedSession | null; runtime: Runtime }, workspaceSlug: string | undefined): Promise<AppCtx> {
  if (!args.session) throw new NotFoundError();
  const target =
    workspaceSlug === undefined
      ? args.ctx
      : await buildUserContext(args.session, { prisma: args.runtime.prisma, mode: args.ctx.mode, clock: args.ctx.clock }, { correlationId: args.ctx.correlationId, workspaceSlug });
  // No workspace selected (an employee without an active workspace and no slug): nothing of a tenant is visible.
  if (target.workspaceId === null) throw new NotFoundError();
  return target;
}

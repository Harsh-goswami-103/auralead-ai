/**
 * Authorization guards over a built context (plan §4.1, A6). Statuses follow the tenant rules:
 * a missing session is 401, anything that would reveal another tenant or panel is 404, and a
 * capability missing inside the actor's own workspace is 403.
 */
import { CAPABILITIES, type Capability, type GlobalRole } from '@/lib/domain/enums';
import type { Actor, Ctx } from '@/lib/domain/context';
import { AuthError, NotFoundError, PermissionDeniedError } from '@/lib/errors';
import { hasRecentReauth } from './session';

/** A workspace OWNER holds every capability inside their own workspace (§5.2). */
export const OWNER_CAPABILITIES: ReadonlySet<Capability> = new Set(CAPABILITIES);

/**
 * A workspace MEMBER works leads, drafts, quotes and sends, but does not manage integrations,
 * automation, scoring, pipeline, pricing overrides, exports or approvals.
 */
export const MEMBER_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'leads.read',
  'leads.write',
  'drafts.generate',
  'quotes.edit',
  'dispatch.send',
]);

type AnyCtx = Pick<Ctx, 'actor' | 'workspaceId' | 'capabilities'>;

export function requireActor(ctx: Pick<Ctx, 'actor'>): Actor {
  if (!ctx.actor) throw new AuthError();
  return ctx.actor;
}

/** A role outside the list gets 404: a panel the actor cannot use does not exist for them. */
export function requireRole(ctx: Pick<Ctx, 'actor'>, ...roles: GlobalRole[]): Actor {
  const actor = requireActor(ctx);
  if (!roles.includes(actor.role)) throw new NotFoundError();
  return actor;
}

export function requireWorkspace(ctx: Pick<Ctx, 'workspaceId'>): string {
  if (ctx.workspaceId === null) throw new NotFoundError();
  return ctx.workspaceId;
}

export function hasCapability(ctx: Pick<Ctx, 'capabilities'>, capability: Capability): boolean {
  return ctx.capabilities.has(capability);
}

export function requireCapability(ctx: AnyCtx, capability: Capability): void {
  requireWorkspace(ctx);
  if (!hasCapability(ctx, capability)) {
    throw new PermissionDeniedError({ safeDetails: { capability } });
  }
}

/** Global outbound pause and elevated drilldown need a password re-entry within 15 minutes. */
export function requireRecentReauth(session: { reauthAt: Date | null }, now: Date): void {
  if (!hasRecentReauth(session, now)) {
    throw new AuthError({ code: 'REAUTH_REQUIRED', userMessage: 'Enter your password again to continue.' });
  }
}

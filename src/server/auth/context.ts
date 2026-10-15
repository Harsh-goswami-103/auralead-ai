/**
 * Context builders (plan §4.1). A context is only ever built here, from server-side facts: the
 * session row, the Membership or EmployeeAssignment tables, the Job row, or the routed
 * Integration. Browser-supplied workspace ids, roles or user ids never reach these functions.
 *
 * - USER: the session's active workspace if the user is a member, else their first membership.
 *   OWNER holds every capability, MEMBER the member set (guards.ts).
 * - EMPLOYEE: a `[ws]` slug (or the session's active workspace) checked against an active
 *   EmployeeAssignment; capabilities and discount cap come from the assignment.
 * - SUPER_ADMIN: no workspace. Tenant data only through `adminContext`, which commits an
 *   AuditEvent (reason, crossWorkspace) before it returns the elevated context.
 * Anything that does not resolve is a 404 (A6), so a probe cannot tell "exists" from "not yours".
 *
 * `ctx.db` is the tenant-scoped client (scoped.ts). The base client behind each context is kept
 * in a module-private WeakMap so `adminContext` can write its audit row without widening Ctx.
 */
import type { Membership, PrismaClient, Workspace, WorkspaceSettings } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import type { Actor, Ctx } from '@/lib/domain/context';
import { isCapability, type Capability } from '@/lib/domain/enums';
import { AuthError, NotFoundError, ValidationError } from '@/lib/errors';
import { scopeDb, type ScopedDb } from '@/server/db/scoped';
import { recordAudit } from '@/server/services/audit/record';
import { MEMBER_CAPABILITIES, OWNER_CAPABILITIES } from './guards';
import { dbMode, loadSession, readSessionToken, type LoadedSession } from './session';

export type AppCtx = Ctx<ScopedDb>;

export type ContextDeps = { prisma: PrismaClient; mode: 'demo' | 'live'; clock: Clock };

const NO_CAPABILITIES: ReadonlySet<Capability> = new Set();
const baseClients = new WeakMap<object, PrismaClient>();

type CtxFields = Omit<AppCtx, 'db' | 'mode' | 'clock'>;

function make(fields: CtxFields, deps: ContextDeps): AppCtx {
  const ctx: AppCtx = { ...fields, mode: deps.mode, clock: deps.clock, db: scopeDb(deps.prisma, fields.workspaceId) };
  baseClients.set(ctx, deps.prisma);
  return ctx;
}

/** The unscoped client a context was built on (platform code only: admin audit, claim, reaper). */
export function baseClientOf(ctx: AppCtx): PrismaClient {
  const client = baseClients.get(ctx);
  if (!client) throw new Error('baseClientOf: context was not built by src/server/auth/context.ts');
  return client;
}

function depsOf(ctx: AppCtx): ContextDeps {
  return { prisma: baseClientOf(ctx), mode: ctx.mode, clock: ctx.clock };
}

type ResolvedWorkspace = { workspaceId: string; capabilities: ReadonlySet<Capability>; maxDiscountBps: number | null };

type WorkspaceWithSettings = Workspace & { settings: WorkspaceSettings | null };

function usable(ws: WorkspaceWithSettings | null | undefined, deps: ContextDeps): ws is WorkspaceWithSettings {
  return ws !== null && ws !== undefined && ws.mode === dbMode(deps.mode);
}

function fromMembership(m: Membership & { workspace: WorkspaceWithSettings }): ResolvedWorkspace {
  return {
    workspaceId: m.workspaceId,
    capabilities: m.role === 'OWNER' ? OWNER_CAPABILITIES : MEMBER_CAPABILITIES,
    maxDiscountBps: m.workspace.settings?.maxDiscountBps ?? null,
  };
}

async function resolveUserWorkspace(userId: string, activeWorkspaceId: string | null, slug: string | undefined, deps: ContextDeps): Promise<ResolvedWorkspace | null> {
  const include = { workspace: { include: { settings: true } } } as const;
  if (slug !== undefined) {
    const m = await deps.prisma.membership.findFirst({ where: { userId, workspace: { slug } }, include });
    if (!m || !usable(m.workspace, deps)) throw new NotFoundError();
    return fromMembership(m);
  }
  if (activeWorkspaceId !== null) {
    const m = await deps.prisma.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId: activeWorkspaceId } }, include });
    if (m && usable(m.workspace, deps)) return fromMembership(m);
  }
  const all = await deps.prisma.membership.findMany({ where: { userId }, include, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const first = all.find((m) => usable(m.workspace, deps));
  return first ? fromMembership(first) : null;
}

async function resolveEmployeeWorkspace(userId: string, activeWorkspaceId: string | null, slug: string | undefined, deps: ContextDeps): Promise<ResolvedWorkspace | null> {
  const include = { workspace: { include: { settings: true } } } as const;
  const where = slug !== undefined ? { employeeUserId: userId, active: true, workspace: { slug } } : activeWorkspaceId !== null ? { employeeUserId: userId, active: true, workspaceId: activeWorkspaceId } : null;
  if (where === null) return null;
  const a = await deps.prisma.employeeAssignment.findFirst({ where, include });
  if (!a || !usable(a.workspace, deps)) {
    if (slug !== undefined) throw new NotFoundError();
    return null;
  }
  const granted = Array.isArray(a.capabilities) ? a.capabilities.filter(isCapability) : [];
  const wsCap = a.workspace.settings?.maxDiscountBps ?? null;
  const caps = [a.maxDiscountBps, wsCap].filter((v): v is number => v !== null);
  return { workspaceId: a.workspaceId, capabilities: new Set(granted), maxDiscountBps: caps.length > 0 ? Math.min(...caps) : null };
}

export type UserContextOptions = { correlationId: string; workspaceSlug?: string; causationId?: string };

/** The context for an authenticated session (pages and `/api/app/*`). */
export async function buildUserContext(loaded: LoadedSession, deps: ContextDeps, opts: UserContextOptions): Promise<AppCtx> {
  const { user, session } = loaded;
  const actor: Actor = { userId: user.id, role: user.globalRole, isDemo: user.isDemo };
  let resolved: ResolvedWorkspace | null = null;
  if (user.globalRole === 'USER') resolved = await resolveUserWorkspace(user.id, session.activeWorkspaceId, opts.workspaceSlug, deps);
  else if (user.globalRole === 'EMPLOYEE') resolved = await resolveEmployeeWorkspace(user.id, session.activeWorkspaceId, opts.workspaceSlug, deps);
  else if (opts.workspaceSlug !== undefined) throw new NotFoundError();

  return make(
    {
      kind: 'user',
      correlationId: opts.correlationId,
      causationId: opts.causationId,
      actor,
      workspaceId: resolved?.workspaceId ?? null,
      capabilities: resolved?.capabilities ?? NO_CAPABILITIES,
      maxDiscountBps: resolved?.maxDiscountBps ?? null,
    },
    deps,
  );
}

export type RequestContextDeps = ContextDeps & { config: { authCookieInsecureDev: boolean } };

/**
 * Session cookie -> loaded session -> context. Throws a 401 AuthError when there is no valid
 * session. `workspaceSlug` comes from a `[ws]` route segment, never from a body or query.
 */
export async function getRequestContext(
  req: Request,
  deps: RequestContextDeps,
  opts: UserContextOptions,
): Promise<{ ctx: AppCtx; session: LoadedSession }> {
  const token = readSessionToken(req.headers, deps.config);
  if (token === null) throw new AuthError();
  const session = await loadSession(deps.prisma, token, { now: deps.clock.now(), mode: dbMode(deps.mode) });
  if (session === null) throw new AuthError();
  return { ctx: await buildUserContext(session, deps, opts), session };
}

/** The workspace a session may switch to: a membership (USER) or an active assignment (EMPLOYEE). */
export async function resolveSwitchableWorkspace(loaded: LoadedSession, slug: string, deps: ContextDeps): Promise<string> {
  const role = loaded.user.globalRole;
  const resolved =
    role === 'USER'
      ? await resolveUserWorkspace(loaded.user.id, null, slug, deps)
      : role === 'EMPLOYEE'
        ? await resolveEmployeeWorkspace(loaded.user.id, null, slug, deps)
        : null;
  if (!resolved) throw new NotFoundError();
  return resolved.workspaceId;
}

/** Worker jobs act with system authority inside the job's workspace (null for system jobs). */
export function getJobContext(job: { id: string; workspaceId: string | null; correlationId: string }, deps: ContextDeps): AppCtx {
  return make(
    {
      kind: 'job',
      correlationId: job.correlationId,
      causationId: job.id,
      actor: null,
      workspaceId: job.workspaceId,
      capabilities: OWNER_CAPABILITIES,
      maxDiscountBps: null,
    },
    deps,
  );
}

/** A verified webhook routed to an Integration: scoped to that workspace, no capabilities. */
export function getWebhookContext(integration: { workspaceId: string }, deps: ContextDeps, correlationId: string): AppCtx {
  return make(
    { kind: 'webhook', correlationId, actor: null, workspaceId: integration.workspaceId, capabilities: NO_CAPABILITIES, maxDiscountBps: null },
    deps,
  );
}

/** Unauthenticated public routes (share links, unsubscribe): no workspace until a token resolves one. */
export function publicContext(deps: ContextDeps, correlationId: string): AppCtx {
  return make({ kind: 'public', correlationId, actor: null, workspaceId: null, capabilities: NO_CAPABILITIES, maxDiscountBps: null }, deps);
}

/** Platform maintenance (boot tasks, schedulers) outside any workspace. */
export function systemContext(deps: ContextDeps, correlationId: string): AppCtx {
  return make({ kind: 'system', correlationId, actor: null, workspaceId: null, capabilities: OWNER_CAPABILITIES, maxDiscountBps: null }, deps);
}

const REASON_MIN = 3;
const REASON_MAX = 500;

/**
 * Super admin drilldown into one workspace. Writes and commits the AuditEvent (action
 * `admin.elevate`, crossWorkspace, reason) before returning, so no tenant data can be read
 * through the elevated context without a durable record. Route handlers that call this also
 * require a recent password re-entry (`withRoute({ reauth: true })`).
 */
export async function adminContext(ctx: AppCtx, targetWorkspaceId: string, reason: string): Promise<AppCtx> {
  if (ctx.kind !== 'user' || ctx.actor?.role !== 'SUPER_ADMIN') throw new NotFoundError();
  const trimmed = reason.trim();
  if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) {
    throw new ValidationError({
      code: 'REASON_REQUIRED',
      userMessage: 'Give a reason for opening this workspace.',
      safeDetails: { issues: [{ path: 'reason', code: 'invalid_length', message: `${REASON_MIN}-${REASON_MAX} characters` }] },
    });
  }
  const deps = depsOf(ctx);
  const workspace = await deps.prisma.workspace.findUnique({ where: { id: targetWorkspaceId }, include: { settings: true } });
  if (!usable(workspace, deps)) throw new NotFoundError();

  const audit = await recordAudit(deps.prisma, { ...ctx, workspaceId: workspace.id }, {
    action: 'admin.elevate',
    targetType: 'Workspace',
    targetId: workspace.id,
    crossWorkspace: true,
    reason: trimmed,
    summary: { fields: [] },
  });

  return make(
    {
      kind: 'user',
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      actor: ctx.actor,
      workspaceId: workspace.id,
      capabilities: OWNER_CAPABILITIES,
      maxDiscountBps: workspace.settings?.maxDiscountBps ?? null,
      elevated: { reason: trimmed, auditEventId: audit.id },
    },
    deps,
  );
}

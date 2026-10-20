/**
 * People management for the super admin (T29, R33, R46): who can sign in, with which role, into
 * which workspaces, and with which capabilities.
 *
 * Reads are platform identity data (users, memberships, assignments, invites), not tenant
 * records, so they need no drilldown; they are limited to this process's mode: LIVE never lists or
 * changes a demo user (404), and only workspaces of this mode appear.
 *
 * Writes (every one in one immediate transaction with its AuditEvent, `crossWorkspace` and the
 * typed reason; the routes add a fresh sign-in and CSRF):
 *  - invites: client users into a workspace (OWNER or MEMBER), employees and administrators as
 *    platform invites. Single use, stored hashed, shown once; a newer invite to the same address
 *    retires the pending one; an address that already has an account is refused (its access is
 *    changed directly instead); revocable while pending.
 *  - role and status (ACTIVE / DISABLED), membership (add, change, remove) and employee assignment
 *    (capabilities, discount cap, active): each revokes every session of that user, so their next
 *    request signs in again and gets a context built from the new privileges (plan §9).
 *  - password reset links (ADR-67) through `issuePasswordReset`.
 * Guards (422): no one changes their own role or status; the last active administrator is never
 * demoted or disabled (checked inside the transaction, so two administrators demoting each other
 * at once cannot both win); a workspace's last active owner is never removed or demoted; a role
 * change waits until the person holds no workspace access; in DEMO the role-switcher personas keep
 * their role and status.
 */
import type { GlobalRole, MembershipRole, Prisma, PrismaClient, UserStatus } from '@/generated/prisma/client';
import { isCapability, type Capability } from '@/lib/domain/enums';
import { ConflictError, DomainRuleError, NotFoundError } from '@/lib/errors';
import { redact } from '@/lib/redact';
import { baseClientOf, type AppCtx } from '@/server/auth/context';
import { DEMO_PERSONAS } from '@/server/auth/demo-personas';
import { requireRole } from '@/server/auth/guards';
import { createInvite, OPERATOR_INVITER } from '@/server/auth/invites';
import { normalizeEmail } from '@/server/auth/login';
import { issuePasswordReset } from '@/server/auth/password-reset';
import { dbMode, revokeUserSessions } from '@/server/auth/session';
import { withTx } from '@/server/db/tx';
import { recordAudit, type AuditCtx } from '@/server/services/audit/record';

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

export const PEOPLE_PAGE_SIZE = 50;
const PEOPLE_PAGE_MAX = 100;
const INVITE_LIST_LIMIT = 200;
const PERSON_ACTIVITY_LIMIT = 20;

const rule = (code: string, userMessage: string) => new DomainRuleError({ code, userMessage });

function adminOf(ctx: AppCtx): { prisma: PrismaClient; adminId: string } {
  const actor = requireRole(ctx, 'SUPER_ADMIN');
  return { prisma: baseClientOf(ctx), adminId: actor.userId };
}

/** The users this mode's administrator may see and change: LIVE never touches a demo user. */
export function userScope(ctx: Pick<AppCtx, 'mode'>): Prisma.UserWhereInput {
  return ctx.mode === 'live' ? { isDemo: false } : {};
}

const inModeWorkspace = (ctx: Pick<AppCtx, 'mode'>) => ({ workspace: { mode: dbMode(ctx.mode) } });

const TARGET_SELECT = { id: true, email: true, name: true, globalRole: true, status: true, isDemo: true } as const;
type Target = { id: string; email: string; name: string; globalRole: GlobalRole; status: UserStatus; isDemo: boolean };

async function loadTarget(db: Db, ctx: AppCtx, userId: string): Promise<Target> {
  const user = await db.user.findUnique({ where: { id: userId }, select: TARGET_SELECT });
  if (!user || (ctx.mode === 'live' && user.isDemo)) throw new NotFoundError();
  return user;
}

export type WorkspaceRef = { id: string; slug: string; name: string };

/** A workspace of this process's mode, or 404. */
export async function loadModeWorkspace(db: Db, ctx: Pick<AppCtx, 'mode'>, workspaceId: string): Promise<WorkspaceRef> {
  const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, slug: true, name: true, mode: true } });
  if (!ws || ws.mode !== dbMode(ctx.mode)) throw new NotFoundError();
  return { id: ws.id, slug: ws.slug, name: ws.name };
}

const PERSONA_EMAILS: ReadonlySet<string> = new Set(Object.values(DEMO_PERSONAS).map((p) => p.email));

function assertNotPersona(ctx: AppCtx, user: Target): void {
  if (ctx.mode === 'demo' && PERSONA_EMAILS.has(user.email)) {
    throw rule('DEMO_PERSONA_LOCKED', 'The DEMO role switcher signs in as this person, so their role and status stay as seeded. Reset the demo to restore other changes.');
  }
}

function assertNotSelf(adminId: string, user: Target): void {
  if (user.id === adminId) throw rule('SELF_CHANGE', 'You cannot change your own role or status. Ask another administrator.');
}

/** Inside the transaction: the target is not the last active administrator who can sign in to this mode. */
async function assertNotLastAdmin(tx: Tx, ctx: AppCtx, user: Target): Promise<void> {
  if (user.globalRole !== 'SUPER_ADMIN' || user.status !== 'ACTIVE') return;
  const others = await tx.user.count({ where: { globalRole: 'SUPER_ADMIN', status: 'ACTIVE', id: { not: user.id }, ...userScope(ctx) } });
  if (others === 0) throw rule('LAST_ADMIN', 'This is the last active administrator. Invite or promote another administrator first.');
}

/**
 * The audit context for a helper that writes its own row without taking a reason
 * (`issuePasswordReset`): `recordAudit` takes the row's reason and crossWorkspace flag from
 * `elevated`. No workspace is entered; the row stays platform-level (workspaceId null).
 */
function auditCtxWithReason(ctx: AppCtx, reason: string): AuditCtx {
  return { kind: ctx.kind, actor: ctx.actor, workspaceId: null, correlationId: ctx.correlationId, clock: ctx.clock, elevated: { reason, auditEventId: 'admin.people' } };
}

// ---- Reads -------------------------------------------------------------------------------------

export type PersonMembership = { workspace: WorkspaceRef; membershipRole: MembershipRole; since: Date };
export type PersonAssignmentSummary = { workspace: WorkspaceRef; active: boolean; capabilityCount: number; maxDiscountBps: number | null };

export type PersonRow = {
  id: string;
  email: string;
  name: string;
  globalRole: GlobalRole;
  status: UserStatus;
  isDemo: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
  memberships: PersonMembership[];
  assignments: PersonAssignmentSummary[];
};

export type PeopleFilter = { globalRole?: GlobalRole; status?: UserStatus; q?: string; before?: string; limit?: number };

const capabilitiesOf = (value: unknown): Capability[] => (Array.isArray(value) ? value.filter(isCapability) : []);

export async function listPeople(ctx: AppCtx, filter: PeopleFilter = {}): Promise<{ rows: PersonRow[]; nextCursor: string | null }> {
  const { prisma } = adminOf(ctx);
  const limit = Math.min(Math.max(filter.limit ?? PEOPLE_PAGE_SIZE, 1), PEOPLE_PAGE_MAX);
  const and: Prisma.UserWhereInput[] = [userScope(ctx)];
  if (filter.globalRole) and.push({ globalRole: filter.globalRole });
  if (filter.status) and.push({ status: filter.status });
  const q = filter.q?.trim();
  if (q) and.push({ OR: [{ email: { contains: q.toLowerCase() } }, { name: { contains: q } }] });
  if (filter.before) {
    const cursor = await prisma.user.findUnique({ where: { id: filter.before }, select: { id: true, createdAt: true } });
    if (cursor) and.push({ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] });
  }
  const users = await prisma.user.findMany({
    where: { AND: and },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      ...TARGET_SELECT,
      createdAt: true,
      lastLoginAt: true,
      memberships: { where: inModeWorkspace(ctx), orderBy: { createdAt: 'asc' }, select: { role: true, createdAt: true, workspace: { select: { id: true, slug: true, name: true } } } },
      employeeAssignments: {
        where: inModeWorkspace(ctx),
        orderBy: { createdAt: 'asc' },
        select: { active: true, capabilities: true, maxDiscountBps: true, workspace: { select: { id: true, slug: true, name: true } } },
      },
    },
  });
  const page = users.slice(0, limit);
  return {
    rows: page.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      globalRole: u.globalRole,
      status: u.status,
      isDemo: u.isDemo,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      memberships: u.memberships.map((m) => ({ workspace: m.workspace, membershipRole: m.role, since: m.createdAt })),
      assignments: u.employeeAssignments.map((a) => ({ workspace: a.workspace, active: a.active, capabilityCount: capabilitiesOf(a.capabilities).length, maxDiscountBps: a.maxDiscountBps })),
    })),
    nextCursor: users.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export type PersonAssignment = { workspace: WorkspaceRef; active: boolean; capabilities: Capability[]; maxDiscountBps: number | null; since: Date };
export type PersonActivity = { id: string; action: string; actorKind: string; result: string; createdAt: Date; reason: string | null; workspace: WorkspaceRef | null };

export type PersonDetail = Omit<PersonRow, 'assignments'> & {
  assignments: PersonAssignment[];
  activeSessions: number;
  lastSeenAt: Date | null;
  /** Unused, unexpired reset links (the links themselves cannot be read back). */
  openResetLinks: number;
  /** The last changes made to this person (redacted audit rows). */
  activity: PersonActivity[];
  /** Whether this person's role and status are fixed (DEMO role-switcher persona). */
  personaLocked: boolean;
  isSelf: boolean;
};

export async function getPerson(ctx: AppCtx, userId: string): Promise<PersonDetail> {
  const { prisma, adminId } = adminOf(ctx);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      ...TARGET_SELECT,
      createdAt: true,
      lastLoginAt: true,
      memberships: { where: inModeWorkspace(ctx), orderBy: { createdAt: 'asc' }, select: { role: true, createdAt: true, workspace: { select: { id: true, slug: true, name: true } } } },
      employeeAssignments: {
        where: inModeWorkspace(ctx),
        orderBy: { createdAt: 'asc' },
        select: { active: true, capabilities: true, maxDiscountBps: true, createdAt: true, workspace: { select: { id: true, slug: true, name: true } } },
      },
    },
  });
  if (!user || (ctx.mode === 'live' && user.isDemo)) throw new NotFoundError();
  const now = ctx.clock.now();
  const live = { userId: user.id, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now }, mode: dbMode(ctx.mode) };
  const [activeSessions, lastSession, openResetLinks, audits] = await Promise.all([
    prisma.session.count({ where: live }),
    prisma.session.findFirst({ where: { userId: user.id }, orderBy: { lastSeenAt: 'desc' }, select: { lastSeenAt: true } }),
    prisma.passwordReset.count({ where: { userId: user.id, usedAt: null, expiresAt: { gt: now } } }),
    prisma.auditEvent.findMany({ where: { targetType: 'User', targetId: user.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: PERSON_ACTIVITY_LIMIT }),
  ]);
  const workspaceIds = [...new Set(audits.map((a) => a.workspaceId).filter((v): v is string => v !== null))];
  const workspaces = workspaceIds.length ? await prisma.workspace.findMany({ where: { id: { in: workspaceIds } }, select: { id: true, slug: true, name: true } }) : [];
  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    globalRole: user.globalRole,
    status: user.status,
    isDemo: user.isDemo,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    memberships: user.memberships.map((m) => ({ workspace: m.workspace, membershipRole: m.role, since: m.createdAt })),
    assignments: user.employeeAssignments.map((a) => ({ workspace: a.workspace, active: a.active, capabilities: capabilitiesOf(a.capabilities), maxDiscountBps: a.maxDiscountBps, since: a.createdAt })),
    activeSessions,
    lastSeenAt: lastSession?.lastSeenAt ?? null,
    openResetLinks,
    activity: audits.map((a) => ({
      id: a.id,
      action: a.action,
      actorKind: a.actorKind,
      result: a.result,
      createdAt: a.createdAt,
      reason: a.reason === null ? null : String(redact(a.reason)),
      workspace: a.workspaceId ? (wsById.get(a.workspaceId) ?? null) : null,
    })),
    personaLocked: ctx.mode === 'demo' && PERSONA_EMAILS.has(user.email),
    isSelf: user.id === adminId,
  };
}

export type PendingInvite = {
  id: string;
  email: string;
  globalRole: GlobalRole;
  membershipRole: MembershipRole | null;
  workspace: WorkspaceRef | null;
  createdAt: Date;
  expiresAt: Date;
  createdBy: { id: string; name: string } | null;
  /** Issued from the server shell by `npm run admin:bootstrap` (ADR-68). */
  byOperator: boolean;
};

export async function listPendingInvites(ctx: AppCtx, filter: { workspaceId?: string }): Promise<PendingInvite[]> {
  const { prisma } = adminOf(ctx);
  const now = ctx.clock.now();
  const invites = await prisma.invite.findMany({
    where: {
      redeemedAt: null,
      expiresAt: { gt: now },
      ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
      OR: [{ workspaceId: null }, inModeWorkspace(ctx)],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: INVITE_LIST_LIMIT,
    include: { workspace: { select: { id: true, slug: true, name: true } } },
  });
  const creatorIds = [...new Set(invites.map((i) => i.createdBy).filter((id) => id !== OPERATOR_INVITER))];
  const creators = creatorIds.length ? await prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true } }) : [];
  const creatorById = new Map(creators.map((c) => [c.id, c]));
  return invites.map((i) => ({
    id: i.id,
    email: i.email,
    globalRole: i.globalRole,
    membershipRole: i.membershipRole,
    workspace: i.workspace,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    createdBy: creatorById.get(i.createdBy) ?? null,
    byOperator: i.createdBy === OPERATOR_INVITER,
  }));
}

// ---- Invites -----------------------------------------------------------------------------------

export type InviteInput = { email: string; globalRole: GlobalRole; workspaceId?: string | null; membershipRole?: MembershipRole | null; reason: string };
export type IssuedInvite = {
  invite: { id: string; email: string; globalRole: GlobalRole; membershipRole: MembershipRole | null; workspace: WorkspaceRef | null; expiresAt: Date };
  /** Shown once; only its hash is stored. */
  token: string;
  supersededInvites: number;
};

/**
 * Creates an invite inside the caller's transaction (also used by workspace creation): refuses an
 * address that already has an account, retires earlier pending invites to the same address, and
 * audits `invite.create` without the address or the token.
 */
export async function createInviteInTx(tx: Tx, ctx: AppCtx, input: InviteInput & { workspace: WorkspaceRef | null }): Promise<IssuedInvite> {
  const { adminId } = adminOf(ctx);
  const now = ctx.clock.now();
  const email = normalizeEmail(input.email);
  const existing = await tx.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw new ConflictError({ code: 'EMAIL_IN_USE', userMessage: 'This email already has an account. Change their access on their People page instead of inviting them.' });
  const superseded = await tx.invite.updateMany({ where: { email, redeemedAt: null, expiresAt: { gt: now } }, data: { expiresAt: now } });
  const membershipRole = input.workspace ? (input.membershipRole ?? null) : null;
  const { token, invite } = await createInvite(tx, { email, globalRole: input.globalRole, workspaceId: input.workspace?.id ?? null, membershipRole, createdBy: adminId, now });
  await recordAudit(tx, ctx, {
    action: 'invite.create',
    targetType: 'Invite',
    targetId: invite.id,
    workspaceId: input.workspace?.id ?? null,
    crossWorkspace: true,
    reason: input.reason,
    summary: { fields: ['invite'], globalRole: input.globalRole, membershipRole, supersededInvites: superseded.count },
  });
  return {
    invite: { id: invite.id, email: invite.email, globalRole: invite.globalRole, membershipRole: invite.membershipRole, workspace: input.workspace, expiresAt: invite.expiresAt },
    token,
    supersededInvites: superseded.count,
  };
}

export async function createAccessInvite(ctx: AppCtx, input: InviteInput): Promise<IssuedInvite> {
  const { prisma } = adminOf(ctx);
  const wantsWorkspace = Boolean(input.workspaceId) || Boolean(input.membershipRole);
  if (input.globalRole === 'USER' && (!input.workspaceId || !input.membershipRole)) {
    throw rule('INVITE_NEEDS_WORKSPACE', 'A client user is invited into a workspace: choose the workspace and their role there.');
  }
  if (input.globalRole !== 'USER' && wantsWorkspace) {
    throw rule('INVITE_INVALID', 'Employees and administrators are not workspace members. Invite them without a workspace, then assign employees from their People page.');
  }
  return withTx(prisma, async (tx) => {
    const workspace = input.workspaceId ? await loadModeWorkspace(tx, ctx, input.workspaceId) : null;
    return createInviteInTx(tx, ctx, { ...input, workspace });
  });
}

export async function revokeInvite(ctx: AppCtx, input: { inviteId: string; reason: string }): Promise<{ revoked: true }> {
  const { prisma } = adminOf(ctx);
  const now = ctx.clock.now();
  return withTx(prisma, async (tx) => {
    const invite = await tx.invite.findUnique({ where: { id: input.inviteId }, include: { workspace: { select: { mode: true } } } });
    if (!invite || invite.redeemedAt !== null || invite.expiresAt.getTime() <= now.getTime()) throw new NotFoundError();
    if (invite.workspace && invite.workspace.mode !== dbMode(ctx.mode)) throw new NotFoundError();
    const ended = await tx.invite.updateMany({ where: { id: invite.id, redeemedAt: null, expiresAt: { gt: now } }, data: { expiresAt: now } });
    if (ended.count !== 1) throw new NotFoundError();
    await recordAudit(tx, ctx, {
      action: 'invite.revoke',
      targetType: 'Invite',
      targetId: invite.id,
      workspaceId: invite.workspaceId,
      crossWorkspace: true,
      reason: input.reason,
      summary: { fields: ['invite'], globalRole: invite.globalRole, membershipRole: invite.membershipRole },
    });
    return { revoked: true as const };
  });
}

// ---- Role and status ---------------------------------------------------------------------------

export type PrivilegeResult<T> = { changed: boolean; revokedSessions: number } & T;

export async function changeUserRole(ctx: AppCtx, input: { userId: string; globalRole: GlobalRole; reason: string }): Promise<PrivilegeResult<{ globalRole: GlobalRole }>> {
  const { prisma, adminId } = adminOf(ctx);
  const now = ctx.clock.now();
  return withTx(prisma, async (tx) => {
    const user = await loadTarget(tx, ctx, input.userId);
    if (user.globalRole === input.globalRole) return { changed: false, revokedSessions: 0, globalRole: user.globalRole };
    assertNotSelf(adminId, user);
    assertNotPersona(ctx, user);
    await assertNotLastAdmin(tx, ctx, user);
    if (user.globalRole === 'USER' && (await tx.membership.count({ where: { userId: user.id } })) > 0) {
      throw rule('ROLE_HAS_ACCESS', 'Remove their workspace memberships first, then change the role.');
    }
    if (user.globalRole === 'EMPLOYEE' && (await tx.employeeAssignment.count({ where: { employeeUserId: user.id, active: true } })) > 0) {
      throw rule('ROLE_HAS_ACCESS', 'Deactivate their workspace assignments first, then change the role.');
    }
    await tx.user.update({ where: { id: user.id }, data: { globalRole: input.globalRole } });
    const revokedSessions = await revokeUserSessions(tx, user.id, now);
    await recordAudit(tx, ctx, {
      action: 'user.role_change',
      targetType: 'User',
      targetId: user.id,
      workspaceId: null,
      crossWorkspace: true,
      reason: input.reason,
      summary: { fields: ['globalRole'], from: user.globalRole, to: input.globalRole, revokedSessions },
    });
    return { changed: true, revokedSessions, globalRole: input.globalRole };
  });
}

export async function changeUserStatus(ctx: AppCtx, input: { userId: string; status: 'ACTIVE' | 'DISABLED'; reason: string }): Promise<PrivilegeResult<{ status: UserStatus }>> {
  const { prisma, adminId } = adminOf(ctx);
  const now = ctx.clock.now();
  return withTx(prisma, async (tx) => {
    const user = await loadTarget(tx, ctx, input.userId);
    if (user.status === input.status) return { changed: false, revokedSessions: 0, status: user.status };
    assertNotSelf(adminId, user);
    assertNotPersona(ctx, user);
    if (input.status !== 'ACTIVE') await assertNotLastAdmin(tx, ctx, user);
    await tx.user.update({ where: { id: user.id }, data: { status: input.status } });
    const revokedSessions = await revokeUserSessions(tx, user.id, now);
    await recordAudit(tx, ctx, {
      action: 'user.status_change',
      targetType: 'User',
      targetId: user.id,
      workspaceId: null,
      crossWorkspace: true,
      reason: input.reason,
      summary: { fields: ['status'], from: user.status, to: input.status, revokedSessions },
    });
    return { changed: true, revokedSessions, status: input.status };
  });
}

// ---- Memberships and assignments ---------------------------------------------------------------

/**
 * Inside the transaction: grants, changes or removes a client user's membership, refusing to leave
 * the workspace without an active owner. Revokes the user's sessions and audits on the workspace.
 */
export async function setMembershipInTx(
  tx: Tx,
  ctx: AppCtx,
  input: { user: Target; workspace: WorkspaceRef; membershipRole: MembershipRole | null; reason: string },
): Promise<PrivilegeResult<{ membershipRole: MembershipRole | null }>> {
  const now = ctx.clock.now();
  const { user, workspace } = input;
  if (user.globalRole !== 'USER') throw rule('NOT_A_CLIENT_USER', 'Only client users are workspace members. Employees get assignments instead.');
  const current = await tx.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } } });
  const from = current?.role ?? null;
  const to = input.membershipRole;
  if (from === to) return { changed: false, revokedSessions: 0, membershipRole: to };
  if (from === 'OWNER') {
    const owners = await tx.membership.count({
      where: { workspaceId: workspace.id, role: 'OWNER', userId: { not: user.id }, user: { status: 'ACTIVE', ...userScope(ctx) } },
    });
    if (owners === 0) throw rule('LAST_OWNER', "This is the workspace's last active owner. Make someone else an owner first.");
  }
  if (to === null) await tx.membership.delete({ where: { id: current!.id } });
  else if (current) await tx.membership.update({ where: { id: current.id }, data: { role: to } });
  else await tx.membership.create({ data: { userId: user.id, workspaceId: workspace.id, role: to, createdAt: now } });
  const revokedSessions = await revokeUserSessions(tx, user.id, now);
  await recordAudit(tx, ctx, {
    action: to === null ? 'membership.remove' : 'membership.set',
    targetType: 'User',
    targetId: user.id,
    workspaceId: workspace.id,
    crossWorkspace: true,
    reason: input.reason,
    summary: { fields: ['membership'], from, to, revokedSessions },
  });
  return { changed: true, revokedSessions, membershipRole: to };
}

export async function setMembership(
  ctx: AppCtx,
  input: { userId: string; workspaceId: string; membershipRole: MembershipRole | null; reason: string },
): Promise<PrivilegeResult<{ membershipRole: MembershipRole | null }>> {
  const { prisma } = adminOf(ctx);
  return withTx(prisma, async (tx) => {
    const user = await loadTarget(tx, ctx, input.userId);
    const workspace = await loadModeWorkspace(tx, ctx, input.workspaceId);
    return setMembershipInTx(tx, ctx, { user, workspace, membershipRole: input.membershipRole, reason: input.reason });
  });
}

/** Loads a client user by email for workspace creation: an active, visible USER, or null when the address is free. */
export async function findClientUserForOwnership(tx: Tx, ctx: AppCtx, email: string): Promise<Target | null> {
  const user = await tx.user.findUnique({ where: { email: normalizeEmail(email) }, select: TARGET_SELECT });
  if (!user) return null;
  const usable = user.globalRole === 'USER' && user.status === 'ACTIVE' && !(ctx.mode === 'live' && user.isDemo);
  if (!usable) throw new ConflictError({ code: 'EMAIL_IN_USE', userMessage: 'This email belongs to an account that cannot own a workspace (staff, disabled or unavailable in this mode). Use another address.' });
  return user;
}

export type AssignmentInput = { userId: string; workspaceId: string; capabilities: Capability[]; maxDiscountBps: number | null; active: boolean; reason: string };
export type AssignmentView = { capabilities: Capability[]; maxDiscountBps: number | null; active: boolean };

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

export async function setAssignment(ctx: AppCtx, input: AssignmentInput): Promise<PrivilegeResult<{ assignment: AssignmentView }>> {
  const { prisma, adminId } = adminOf(ctx);
  const now = ctx.clock.now();
  const capabilities = [...new Set(input.capabilities.filter(isCapability))].sort();
  if (input.active && capabilities.length === 0) throw rule('CAPABILITIES_REQUIRED', 'Grant at least one capability, or deactivate the assignment.');
  return withTx(prisma, async (tx) => {
    const user = await loadTarget(tx, ctx, input.userId);
    if (user.globalRole !== 'EMPLOYEE') throw rule('NOT_AN_EMPLOYEE', 'Only employees are assigned to workspaces. Client users get a membership instead.');
    const workspace = await loadModeWorkspace(tx, ctx, input.workspaceId);
    const current = await tx.employeeAssignment.findUnique({ where: { employeeUserId_workspaceId: { employeeUserId: user.id, workspaceId: workspace.id } } });
    const next: AssignmentView = { capabilities, maxDiscountBps: input.maxDiscountBps, active: input.active };
    const before = current ? { capabilities: capabilitiesOf(current.capabilities), maxDiscountBps: current.maxDiscountBps, active: current.active } : null;
    if (before && before.active === next.active && before.maxDiscountBps === next.maxDiscountBps && sameSet(before.capabilities, next.capabilities)) {
      return { changed: false, revokedSessions: 0, assignment: next };
    }
    const fields = before
      ? [
          ...(sameSet(before.capabilities, next.capabilities) ? [] : ['capabilities']),
          ...(before.maxDiscountBps === next.maxDiscountBps ? [] : ['maxDiscountBps']),
          ...(before.active === next.active ? [] : ['active']),
        ]
      : ['assignment'];
    if (current) {
      await tx.employeeAssignment.update({ where: { id: current.id }, data: { capabilities, maxDiscountBps: next.maxDiscountBps, active: next.active } });
    } else {
      await tx.employeeAssignment.create({
        data: { employeeUserId: user.id, workspaceId: workspace.id, capabilities, maxDiscountBps: next.maxDiscountBps, active: next.active, createdBy: adminId, createdAt: now },
      });
    }
    const revokedSessions = await revokeUserSessions(tx, user.id, now);
    await recordAudit(tx, ctx, {
      action: 'assignment.set',
      targetType: 'User',
      targetId: user.id,
      workspaceId: workspace.id,
      crossWorkspace: true,
      reason: input.reason,
      summary: { fields, capabilities, maxDiscountBps: next.maxDiscountBps, active: next.active, revokedSessions },
    });
    return { changed: true, revokedSessions, assignment: next };
  });
}

// ---- Password reset links ------------------------------------------------------------------------

/** A single-use, one-hour reset link for an active user of this mode (ADR-67). The token is returned once. */
export async function issueResetLink(ctx: AppCtx, input: { userId: string; reason: string }): Promise<{ token: string; expiresAt: Date; email: string }> {
  const { prisma, adminId } = adminOf(ctx);
  const user = await loadTarget(prisma, ctx, input.userId);
  if (user.status !== 'ACTIVE') throw new NotFoundError();
  const issued = await issuePasswordReset(prisma, auditCtxWithReason(ctx, input.reason), { userId: user.id, createdBy: adminId });
  return { ...issued, email: user.email };
}

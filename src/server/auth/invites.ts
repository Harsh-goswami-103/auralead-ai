/**
 * Invite onboarding (ADR-11, plan §9 Auth). An invite is a one-time token stored as sha256,
 * valid for 72 hours. Redemption creates the user (or activates an INVITED one), grants the
 * workspace membership the invite names, marks the invite redeemed with a conditional update
 * (so two concurrent redemptions cannot both win), and audits `invite.redeem`. An existing user
 * must prove their password; joining a workspace is a membership change, so their other sessions
 * are revoked. Unknown, expired and already-used tokens all give the same 404.
 */
import type { GlobalRole, Invite, MembershipRole, Prisma, PrismaClient } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { AuthError, NotFoundError, ValidationError } from '@/lib/errors';
import { withTx } from '@/server/db/tx';
import { generateToken, hashToken, isWellFormedToken } from '@/server/security/tokens';
import { recordAudit } from '@/server/services/audit/record';
import { normalizeEmail } from './login';
import { argon2Hasher, assertPasswordPolicy, type PasswordHasher } from './password';
import { revokeUserSessions, type SessionUser } from './session';

export const INVITE_TTL_MS = 72 * 3_600_000;

export type CreateInviteInput = {
  email: string;
  globalRole: GlobalRole;
  workspaceId?: string | null;
  membershipRole?: MembershipRole | null;
  createdBy: string;
  now: Date;
};

export async function createInvite(db: Pick<Prisma.TransactionClient, 'invite'>, input: CreateInviteInput): Promise<{ token: string; invite: Invite }> {
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new ValidationError({ code: 'EMAIL_INVALID', userMessage: 'Enter a valid email address.' });
  const workspaceId = input.workspaceId ?? null;
  const membershipRole = input.membershipRole ?? null;
  if ((workspaceId === null) !== (membershipRole === null)) {
    throw new ValidationError({ code: 'INVITE_INVALID', userMessage: 'A workspace invite needs both a workspace and a membership role.' });
  }
  if (workspaceId !== null && input.globalRole !== 'USER') {
    throw new ValidationError({ code: 'INVITE_INVALID', userMessage: 'Only client users join a workspace by membership; employees are assigned.' });
  }
  const { token, tokenHash } = generateToken();
  const invite = await db.invite.create({
    data: {
      email,
      tokenHash,
      globalRole: input.globalRole,
      workspaceId,
      membershipRole,
      createdBy: input.createdBy,
      createdAt: input.now,
      expiresAt: new Date(input.now.getTime() + INVITE_TTL_MS),
    },
  });
  return { token, invite };
}

export type RedeemInviteInput = { token: string; name: string; password: string };
export type RedeemInviteDeps = { mode: 'demo' | 'live'; clock: Clock; correlationId: string; hasher?: PasswordHasher };

const USER_SELECT = { id: true, email: true, name: true, globalRole: true, status: true, isDemo: true } as const;

export async function redeemInvite(db: PrismaClient, input: RedeemInviteInput, deps: RedeemInviteDeps): Promise<{ user: SessionUser; workspaceId: string | null }> {
  const hasher = deps.hasher ?? argon2Hasher;
  const now = deps.clock.now();
  if (!isWellFormedToken(input.token)) throw new NotFoundError();
  const invite = await db.invite.findUnique({ where: { tokenHash: hashToken(input.token) } });
  if (!invite || invite.redeemedAt !== null || invite.expiresAt.getTime() <= now.getTime()) throw new NotFoundError();

  const existing = await db.user.findUnique({ where: { email: invite.email } });
  const isDemo = deps.mode === 'demo';
  let newHash: string | null = null;
  if (existing?.passwordHash) {
    const ok = await hasher.verify(existing.passwordHash, input.password);
    const eligible = existing.status !== 'DISABLED' && !(deps.mode === 'live' && existing.isDemo);
    if (!ok || !eligible) throw new AuthError({ code: 'INVALID_CREDENTIALS', userMessage: 'Email or password is incorrect.' });
  } else {
    assertPasswordPolicy(input.password);
    newHash = await hasher.hash(input.password);
  }
  const name = input.name.trim().slice(0, 120);
  if (name.length === 0) throw new ValidationError({ code: 'NAME_REQUIRED', userMessage: 'Enter your name.' });

  return withTx(db, async (tx) => {
    const claimed = await tx.invite.updateMany({
      where: { id: invite.id, redeemedAt: null, expiresAt: { gt: now } },
      data: { redeemedAt: now },
    });
    if (claimed.count !== 1) throw new NotFoundError();

    let user: SessionUser;
    if (!existing) {
      user = await tx.user.create({
        data: { email: invite.email, name, globalRole: invite.globalRole, status: 'ACTIVE', passwordHash: newHash, isDemo, createdAt: now },
        select: USER_SELECT,
      });
    } else if (newHash !== null) {
      user = await tx.user.update({ where: { id: existing.id }, data: { name, passwordHash: newHash, status: 'ACTIVE' }, select: USER_SELECT });
    } else {
      user = await tx.user.findUniqueOrThrow({ where: { id: existing.id }, select: USER_SELECT });
    }

    if (invite.workspaceId !== null && invite.membershipRole !== null) {
      const already = await tx.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: invite.workspaceId } } });
      if (!already) {
        await tx.membership.create({ data: { userId: user.id, workspaceId: invite.workspaceId, role: invite.membershipRole, createdAt: now } });
      }
    }
    if (existing) await revokeUserSessions(tx, user.id, now);

    await recordAudit(
      tx,
      { kind: 'user', actor: { userId: user.id, role: user.globalRole, isDemo: user.isDemo }, workspaceId: invite.workspaceId, correlationId: deps.correlationId, clock: deps.clock },
      { action: 'invite.redeem', targetType: 'Invite', targetId: invite.id, summary: { fields: existing ? ['membership'] : ['user', 'membership'] } },
    );
    return { user, workspaceId: invite.workspaceId };
  });
}

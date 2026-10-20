/**
 * Password reset (ADR-67, plan §9 Auth). There is no self-service "forgot password" mail: the
 * platform has no email transport of its own (providers are per-workspace integrations), so a
 * super admin issues a single-use link from the People page, or the operator issues one for a
 * lost administrator account with `npm run admin:bootstrap -- --recover`.
 *
 * A token is 32 random bytes; only sha256(token) is stored. It is valid for one hour, a newer token
 * of the same user supersedes every earlier unused one, and it redeems exactly once (a conditional
 * update, so two concurrent redemptions cannot both win). Redeeming sets the password, clears the
 * lockout, revokes every session of the user and signs nobody in: the person logs in with the new
 * password. Unknown, expired, used, superseded and ineligible (disabled, demo-in-LIVE) tokens are
 * all the same 404, so the endpoint reveals nothing about accounts.
 */
import type { PasswordReset, Prisma, PrismaClient } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { NotFoundError } from '@/lib/errors';
import { withTx } from '@/server/db/tx';
import { generateToken, hashToken, isWellFormedToken } from '@/server/security/tokens';
import { recordAudit, type AuditCtx } from '@/server/services/audit/record';
import { argon2Hasher, assertPasswordPolicy, type PasswordHasher } from './password';
import { revokeUserSessions } from './session';

export const PASSWORD_RESET_TTL_MS = 60 * 60_000;

export type CreatePasswordResetInput = { userId: string; createdBy: string; now: Date };

/** Creates the token row; every earlier unused token of the user stops working. */
export async function createPasswordReset(
  db: Pick<Prisma.TransactionClient, 'passwordReset'>,
  input: CreatePasswordResetInput,
): Promise<{ token: string; reset: PasswordReset }> {
  await db.passwordReset.updateMany({ where: { userId: input.userId, usedAt: null, expiresAt: { gt: input.now } }, data: { expiresAt: input.now } });
  const { token, tokenHash } = generateToken();
  const reset = await db.passwordReset.create({
    data: {
      userId: input.userId,
      tokenHash,
      createdBy: input.createdBy,
      createdAt: input.now,
      expiresAt: new Date(input.now.getTime() + PASSWORD_RESET_TTL_MS),
    },
  });
  return { token, reset };
}

/**
 * Issues a reset link for an existing user and audits `password.reset_issue` in the same
 * transaction. The caller has already authorized the actor (super admin with a recent re-auth, or
 * the operator CLI). The link is returned once; it cannot be read back.
 */
export async function issuePasswordReset(
  db: PrismaClient,
  ctx: AuditCtx,
  input: { userId: string; createdBy: string },
): Promise<{ token: string; expiresAt: Date }> {
  const now = ctx.clock.now();
  return withTx(db, async (tx) => {
    const user = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true, status: true } });
    if (!user || user.status === 'DISABLED') throw new NotFoundError();
    const { token, reset } = await createPasswordReset(tx, { userId: user.id, createdBy: input.createdBy, now });
    await recordAudit(tx, ctx, { action: 'password.reset_issue', targetType: 'User', targetId: user.id, summary: { fields: ['passwordReset'] } });
    return { token, expiresAt: reset.expiresAt };
  });
}

export type RedeemPasswordResetInput = { token: string; password: string };
export type RedeemPasswordResetDeps = { mode: 'demo' | 'live'; clock: Clock; correlationId: string; hasher?: PasswordHasher };

export async function redeemPasswordReset(db: PrismaClient, input: RedeemPasswordResetInput, deps: RedeemPasswordResetDeps): Promise<{ userId: string }> {
  const hasher = deps.hasher ?? argon2Hasher;
  const now = deps.clock.now();
  if (!isWellFormedToken(input.token)) throw new NotFoundError();
  const row = await db.passwordReset.findUnique({ where: { tokenHash: hashToken(input.token) }, include: { user: { select: { id: true, globalRole: true, status: true, isDemo: true } } } });
  if (!row || row.usedAt !== null || row.expiresAt.getTime() <= now.getTime()) throw new NotFoundError();
  const { user } = row;
  if (user.status !== 'ACTIVE' || (deps.mode === 'live' && user.isDemo)) throw new NotFoundError();

  // After the token checks, so an unknown token never reveals whether a password was acceptable.
  assertPasswordPolicy(input.password);
  const passwordHash = await hasher.hash(input.password);

  return withTx(db, async (tx) => {
    const claimed = await tx.passwordReset.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (claimed.count !== 1) throw new NotFoundError();
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
    await revokeUserSessions(tx, user.id, now);
    await recordAudit(
      tx,
      { kind: 'user', actor: { userId: user.id, role: user.globalRole, isDemo: user.isDemo }, workspaceId: null, correlationId: deps.correlationId, clock: deps.clock },
      { action: 'password.reset', targetType: 'User', targetId: user.id, summary: { fields: ['password', 'sessions'] } },
    );
    return { userId: user.id };
  });
}

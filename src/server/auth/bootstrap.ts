/**
 * First-administrator bootstrap (ADR-68). Operators with shell access run
 * `npm run admin:bootstrap -- --email <address>` on a fresh LIVE database. While no active real
 * (non-demo) SUPER_ADMIN exists it issues a single-use platform invite, so the person chooses their
 * own password in the browser and the CLI never handles one. Once an administrator exists it
 * refuses; `recover` then issues a one-hour password reset link for that existing administrator
 * (break-glass for a lost password). Both paths are audited without the token.
 */
import type { PrismaClient } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { withTx } from '@/server/db/tx';
import { recordAudit, type AuditCtx } from '@/server/services/audit/record';
import { createInvite, INVITE_TTL_MS, OPERATOR_INVITER } from './invites';
import { normalizeEmail } from './login';
import { issuePasswordReset } from './password-reset';

export type AdminBootstrapCode = 'DEMO_MODE' | 'EMAIL_INVALID' | 'ADMIN_EXISTS' | 'EMAIL_IN_USE' | 'NOT_AN_ADMIN';

/** Operator-facing (CLI) error: the message is meant to be printed as is and never contains a secret. */
export class AdminBootstrapError extends Error {
  readonly code: AdminBootstrapCode;
  constructor(code: AdminBootstrapCode, message: string) {
    super(message);
    this.name = 'AdminBootstrapError';
    this.code = code;
  }
}

export type BootstrapInput = { email: string; recover: boolean };
export type BootstrapDeps = { mode: 'demo' | 'live'; clock: Clock; correlationId: string };
export type BootstrapResult = { kind: 'invite' | 'reset'; email: string; token: string; expiresAt: Date };

const OPERATOR = OPERATOR_INVITER;

export async function bootstrapAdmin(db: PrismaClient, input: BootstrapInput, deps: BootstrapDeps): Promise<BootstrapResult> {
  if (deps.mode !== 'live') {
    throw new AdminBootstrapError('DEMO_MODE', 'DEMO mode uses seeded identities. Run this against a LIVE installation.');
  }
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AdminBootstrapError('EMAIL_INVALID', 'Enter a valid email address.');
  const now = deps.clock.now();
  const ctx: AuditCtx = { kind: 'system', actor: null, workspaceId: null, correlationId: deps.correlationId, clock: deps.clock };

  const activeAdmins = await db.user.count({ where: { globalRole: 'SUPER_ADMIN', status: 'ACTIVE', isDemo: false } });
  const existing = await db.user.findUnique({ where: { email }, select: { id: true, globalRole: true, status: true, isDemo: true } });

  if (input.recover) {
    if (!existing || existing.globalRole !== 'SUPER_ADMIN' || existing.status !== 'ACTIVE' || existing.isDemo) {
      throw new AdminBootstrapError('NOT_AN_ADMIN', 'No active administrator has that email address.');
    }
    const issued = await issuePasswordReset(db, ctx, { userId: existing.id, createdBy: OPERATOR });
    return { kind: 'reset', email, token: issued.token, expiresAt: issued.expiresAt };
  }

  if (activeAdmins > 0) {
    throw new AdminBootstrapError(
      'ADMIN_EXISTS',
      'An administrator already exists. Invite more people from the Admin panel (People), or run again with --recover --email <their address> to issue a password reset link.',
    );
  }
  if (existing) throw new AdminBootstrapError('EMAIL_IN_USE', 'That email already belongs to another account. Use a different address.');

  return withTx(db, async (tx) => {
    // Only one first-administrator link is ever live: a new run retires every earlier operator link.
    await tx.invite.updateMany({ where: { createdBy: OPERATOR, globalRole: 'SUPER_ADMIN', redeemedAt: null, expiresAt: { gt: now } }, data: { expiresAt: now } });
    const { token, invite } = await createInvite(tx, { email, globalRole: 'SUPER_ADMIN', createdBy: OPERATOR, now });
    await recordAudit(tx, ctx, { action: 'admin.bootstrap', targetType: 'Invite', targetId: invite.id, summary: { fields: ['invite'] } });
    return { kind: 'invite' as const, email, token, expiresAt: new Date(now.getTime() + INVITE_TTL_MS) };
  });
}

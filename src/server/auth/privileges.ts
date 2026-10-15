/**
 * Privilege changes revoke sessions (plan §9 Auth): changing a user's global role or status
 * revokes every session of that user in the same transaction, so the next request has to sign
 * in again and gets a context built from the new privileges. Membership and employee-assignment
 * writers call `revokeUserSessions` (session.ts) in their own transaction for the same reason.
 */
import type { GlobalRole, PrismaClient, UserStatus } from '@/generated/prisma/client';
import { withTx } from '@/server/db/tx';
import { revokeUserSessions } from './session';

export type PrivilegeChange = { userId: string; globalRole?: GlobalRole; status?: UserStatus };

export async function changeUserPrivileges(db: PrismaClient, change: PrivilegeChange, now: Date): Promise<{ revokedSessions: number }> {
  return withTx(db, async (tx) => {
    const data: { globalRole?: GlobalRole; status?: UserStatus } = {};
    if (change.globalRole !== undefined) data.globalRole = change.globalRole;
    if (change.status !== undefined) data.status = change.status;
    await tx.user.update({ where: { id: change.userId }, data });
    const revokedSessions = await revokeUserSessions(tx, change.userId, now);
    return { revokedSessions };
  });
}

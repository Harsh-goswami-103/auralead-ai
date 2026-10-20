/**
 * POST /api/admin/workspaces { name, slug, planLabel, timezone?, ownerEmail, reason } (T29, R33):
 * creates a workspace in this process's mode with the production defaults and its first owner's
 * access in one audited transaction. The owner gets a single-use invite shown once in this
 * response as a link the administrator sends themselves; an address that already belongs to an
 * active client user becomes the owner directly. Super admin only, fresh sign-in within 15
 * minutes, rate limited with the invites (10/h per administrator).
 */
import { WorkspaceCreateBody } from '@/lib/schemas/admin-people';
import { requireFreshAuthentication } from '@/server/services/admin/fresh-auth';
import { createWorkspace } from '@/server/services/admin/workspaces';
import { withRoute } from '../../_lib/with-route';
import { INVITE_RATE, oneTimeLink } from '../people/_lib/links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['SUPER_ADMIN'], body: WorkspaceCreateBody, rateLimit: [INVITE_RATE] }, async ({ ctx, session, body, runtime }) => {
  requireFreshAuthentication(session!.session, ctx.clock.now());
  const { workspace, owner } = await createWorkspace(ctx, body);
  return {
    workspace,
    owner:
      owner.kind === 'invite'
        ? { kind: owner.kind, email: owner.email, inviteId: owner.inviteId, link: oneTimeLink(runtime.config.appOrigin, 'invite', owner.token), expiresAt: owner.expiresAt }
        : { kind: owner.kind, email: owner.email, userId: owner.userId, revokedSessions: owner.revokedSessions },
  };
});

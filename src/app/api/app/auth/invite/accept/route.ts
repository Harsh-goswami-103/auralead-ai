/**
 * POST /api/app/auth/invite/accept { token, name, password }: redeems a one-time invite and
 * signs the user in. Unknown, expired and used tokens are one 404 (invites.ts). Rate limited per
 * IP (inviteReset, 10/h) and Origin-checked, since it sets a session cookie.
 */
import { z } from 'zod';
import { homeForRole } from '@/server/auth/demo-personas';
import { redeemInvite } from '@/server/auth/invites';
import { issueSession } from '@/server/auth/issue';
import { dbMode } from '@/server/auth/session';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  token: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(1024),
});

export const POST = withRoute(
  { auth: 'none', body: Body, rateLimit: [{ policy: 'inviteReset', key: ({ ip }) => `invite:${ip}` }] },
  async ({ req, body, ctx, runtime, correlationId, setCookie }) => {
    const { user, workspaceId } = await redeemInvite(runtime.prisma, body, { mode: runtime.config.mode, clock: ctx.clock, correlationId });
    const issued = await issueSession(runtime.prisma, runtime.config, req, {
      user,
      mode: dbMode(runtime.config.mode),
      activeWorkspaceId: workspaceId,
      now: ctx.clock.now(),
    });
    setCookie(issued.cookie);
    return { redirectTo: homeForRole(user.globalRole), csrfToken: issued.csrfToken };
  },
);

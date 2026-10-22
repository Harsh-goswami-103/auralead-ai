/**
 * POST /api/app/auth/reset { token, password }: redeems a one-time password reset link (ADR-67).
 * Unknown, expired, used and superseded tokens are one 404 (password-reset.ts). Rate limited per
 * IP (inviteReset, 10/h) and Origin-checked. It sets no cookie: the person signs in with the new
 * password, so a leaked link alone never yields a session.
 */
import { z } from 'zod';
import { redeemPasswordReset } from '@/server/auth/password-reset';
import { withRoute } from '../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  token: z.string().min(1).max(128),
  password: z.string().min(1).max(1024),
});

export const POST = withRoute(
  { auth: 'none', body: Body, rateLimit: [{ policy: 'inviteReset', key: ({ ip }) => `reset:${ip}` }] },
  async ({ body, ctx, runtime, correlationId }) => {
    await redeemPasswordReset(runtime.prisma, body, { mode: runtime.config.mode, clock: ctx.clock, correlationId });
    return { redirectTo: '/login' };
  },
);

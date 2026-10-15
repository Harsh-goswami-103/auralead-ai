/**
 * POST /api/app/auth/login: email + password (ADR-11). Rate limited per IP and per email
 * (in-process, C6) before the password check; lockout is persisted on User. Every failure is the
 * same 401. Success rotates the session (the presented one is revoked) and returns the panel to
 * open plus the CSRF token for the new session.
 */
import { z } from 'zod';
import { homeForRole } from '@/server/auth/demo-personas';
import { issueSession } from '@/server/auth/issue';
import { authenticate, normalizeEmail } from '@/server/auth/login';
import { dbMode } from '@/server/auth/session';
import { withRoute } from '../../../_lib/with-route';
import { invalidCredentials } from '../_errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(1024),
});

function emailKey(body: unknown): string | null {
  const email = body !== null && typeof body === 'object' ? (body as { email?: unknown }).email : undefined;
  return typeof email === 'string' && email.length > 0 ? `email:${normalizeEmail(email)}` : null;
}

export const POST = withRoute(
  {
    auth: 'none',
    body: Body,
    rateLimit: [
      { policy: 'loginIp', key: ({ ip }) => `ip:${ip}` },
      { policy: 'loginEmail', key: ({ body }) => emailKey(body) },
    ],
  },
  async ({ req, body, ctx, runtime, setCookie }) => {
    const now = ctx.clock.now();
    const mode = dbMode(runtime.config.mode);
    const result = await authenticate(runtime.prisma, body, { now, mode });
    if (!result.ok) throw invalidCredentials();
    const issued = await issueSession(runtime.prisma, runtime.config, req, { user: result.user, mode, activeWorkspaceId: null, now });
    setCookie(issued.cookie);
    return { redirectTo: homeForRole(result.user.globalRole), csrfToken: issued.csrfToken };
  },
);

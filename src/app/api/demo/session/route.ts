/**
 * POST /api/demo/session { persona }: the DEMO role switcher (T2, ADR-04). 404 in LIVE before
 * anything else runs. Accepts only a fixed persona key, maps it server-side to a seeded `isDemo`
 * user, and issues an ordinary DEMO-mode DB session (rotating any presented one).
 */
import { z } from 'zod';
import { NotFoundError } from '@/lib/errors';
import { DEMO_PERSONA_KEYS, DEMO_PERSONAS } from '@/server/auth/demo-personas';
import { issueSession } from '@/server/auth/issue';
import { withRoute } from '../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ persona: z.enum(DEMO_PERSONA_KEYS) }).strict();

export const POST = withRoute({ auth: 'none', demoOnly: true, body: Body }, async ({ req, body, ctx, runtime, setCookie }) => {
  const persona = DEMO_PERSONAS[body.persona];
  const user = await runtime.prisma.user.findUnique({ where: { email: persona.email } });
  if (!user || !user.isDemo || user.status !== 'ACTIVE' || user.globalRole !== persona.globalRole) {
    throw new NotFoundError({ message: `demo persona ${body.persona} is not seeded; run the demo seed` });
  }
  const issued = await issueSession(runtime.prisma, runtime.config, req, { user, mode: 'DEMO', activeWorkspaceId: null, now: ctx.clock.now() });
  setCookie(issued.cookie);
  return { redirectTo: persona.home, csrfToken: issued.csrfToken };
});

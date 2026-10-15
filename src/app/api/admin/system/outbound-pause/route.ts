/**
 * POST /api/admin/system/outbound-pause { paused, reason } (T24, R40, O1): the global outbound
 * kill switch. Super admin only, with a fresh authentication (password re-entry or sign-in within
 * 15 minutes, plan §9). Pausing defers every send at preflight; sends already past P2 complete.
 * Resuming also removes an `outbound.lock` written by `db:restore`. Audited crossWorkspace.
 */
import { OutboundPauseBody } from '@/lib/schemas/admin';
import { requireFreshAuthentication } from '@/server/services/admin/fresh-auth';
import { setOutboundPause } from '@/server/services/admin/outbound-pause';
import { withRoute } from '../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['SUPER_ADMIN'], body: OutboundPauseBody }, async ({ ctx, session, body, runtime }) => {
  requireFreshAuthentication(session!.session, ctx.clock.now());
  return setOutboundPause(ctx, body, { lockFile: runtime.config.paths.outboundLockFile, envPaused: runtime.config.outboundPaused });
});

/**
 * GET /api/admin/system/queue-health (T24, R33): worker liveness ("Worker not running" after 30 s
 * without a heartbeat), AMBIGUOUS attempts, due and retry-waiting jobs, the oldest due job's age,
 * counts per status and the outbound pause state. Super admin only; platform metadata, no tenant
 * records.
 */
import { loadQueueHealth } from '@/server/services/jobs-admin/queue-health';
import { withRoute } from '../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute({ auth: 'session', roles: ['SUPER_ADMIN'] }, async ({ ctx, runtime }) =>
  loadQueueHealth(ctx, { lockFile: runtime.config.paths.outboundLockFile, envPaused: runtime.config.outboundPaused }),
);

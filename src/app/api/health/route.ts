/**
 * GET /api/health: liveness for the E2E harness, `npm run verify` and operators. 200 with the
 * mode once the process has booted (config valid) and the database answers a query; 503 when the
 * database does not. Reveals nothing else (no versions, paths or worker details).
 */
import { withRoute } from '../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute({ auth: 'none' }, async ({ runtime: rt }) => {
  try {
    await rt.prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    rt.logger.error({ err: error }, 'health check: database unavailable');
    return new Response(JSON.stringify({ status: 'unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '5' },
    });
  }
  return { status: 'ok', mode: rt.config.mode };
});

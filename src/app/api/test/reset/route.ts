/**
 * POST /api/test/reset (A40, 04-tests T5): wipes the DEMO database and reseeds the deterministic
 * fixtures, so E2E specs start from a known state. Exists only in DEMO with
 * AURALEAD_TEST_CONTROL=1 and the right x-test-control-token; otherwise a plain 404. The seed
 * refuses a LIVE process and a database holding LIVE data (assertDemoSeedTarget). The anchor is
 * SEED_NOW, or the request clock (test clock included) floored to the hour.
 */
import { seedAnchor, resetAndSeedDemo } from '../../../../../prisma/seed/seed';
import { withRoute } from '../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'none', testControl: true, origin: false }, async ({ ctx, runtime: rt }) => {
  const summary = await resetAndSeedDemo(rt.prisma, { config: rt.config, now: seedAnchor(rt.config, ctx.clock) });
  return { reset: true, ...summary };
});

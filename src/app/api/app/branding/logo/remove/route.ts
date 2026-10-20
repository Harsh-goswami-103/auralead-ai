/**
 * POST /api/app/branding/logo/remove (T27): clears the workspace logo and deletes its stored file
 * after the change commits. Owner only (`pricing.override`). Idempotent: with no logo it changes
 * nothing and writes no audit row.
 */
import { removeLogo, serializeBranding } from '@/server/services/pricing/branding';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER'], capability: 'pricing.override' }, async ({ ctx, runtime: rt }) => ({
  branding: serializeBranding(await removeLogo(ctx, { storageDir: rt.config.paths.storageDir })),
}));

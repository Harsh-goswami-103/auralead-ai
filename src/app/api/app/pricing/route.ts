/**
 * GET /api/app/pricing (T13): the signed-in client's pricing overview: services with their price
 * in the active version, the active version, tax and discount settings, and the version history.
 * Money is returned as integer paise strings (ADR-07). Any member may read; `canEdit` says whether
 * the caller may change pricing (`pricing.override`, the workspace owner).
 */
import { getPricingOverview, serializeOverview } from '@/server/services/pricing/catalog';
import { withRoute } from '../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute({ auth: 'session', roles: ['USER'] }, async ({ ctx }) => serializeOverview(await getPricingOverview(ctx)));

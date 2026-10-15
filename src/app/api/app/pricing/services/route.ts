/**
 * POST /api/app/pricing/services (T13): adds a service with its price and publishes the next
 * price list version. Body: ServiceCreateBody (src/lib/schemas/pricing.ts); `expectedVersion` is
 * the active version the editor saw (409 when stale). Domain errors are 422 (negative price,
 * quantity bounds, limits), a taken code 409, a member without `pricing.override` 403.
 */
import { parsePaise } from '@/lib/money';
import { ServiceCreateBody } from '@/lib/schemas/pricing';
import { createService, serializeService } from '@/server/services/pricing/catalog';
import { withRoute } from '../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER'], body: ServiceCreateBody, capability: 'pricing.override' }, async ({ ctx, body }) => {
  const result = await createService(ctx, { ...body, unitPricePaise: parsePaise(body.unitPricePaise) });
  return { service: serializeService(result.service), pricingVersion: result.pricingVersion };
});

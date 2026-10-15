/**
 * POST /api/app/pricing/services/[serviceId] (T13): edits a service. Price or quantity changes
 * publish the next price list version (`versionCreated: true`); name, description, unit, timeline
 * and discount limit change the service in place. A service of another workspace is 404.
 */
import { parsePaise } from '@/lib/money';
import { ServiceUpdateBody } from '@/lib/schemas/pricing';
import { serializeService, updateService } from '@/server/services/pricing/catalog';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER'], body: ServiceUpdateBody, capability: 'pricing.override' }, async ({ ctx, body, params }) => {
  const { unitPricePaise, ...rest } = body;
  const result = await updateService(ctx, String(params.serviceId), { ...rest, ...(unitPricePaise === undefined ? {} : { unitPricePaise: parsePaise(unitPricePaise) }) });
  return { service: serializeService(result.service), pricingVersion: result.pricingVersion, versionCreated: result.versionCreated };
});

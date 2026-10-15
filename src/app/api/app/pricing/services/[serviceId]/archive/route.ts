/**
 * POST /api/app/pricing/services/[serviceId]/archive (T13): "delete" a service. A service that a
 * quote or any price list version references is archived and left out of the next version; one
 * that nothing references is removed (`outcome: 'deleted'`). Issued quotes never change.
 */
import { ServiceArchiveBody } from '@/lib/schemas/pricing';
import { archiveService } from '@/server/services/pricing/catalog';
import { withRoute } from '../../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER'], body: ServiceArchiveBody, capability: 'pricing.override' }, async ({ ctx, body, params }) =>
  archiveService(ctx, String(params.serviceId), body),
);

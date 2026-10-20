/**
 * POST /api/app/branding (T27): brand colour, GSTIN and quotation terms. Partial body
 * (BrandingUpdateBody); each value is validated by the branding service (422 with a code) and the
 * change is audited. Owner only (`pricing.override`), the caller's own workspace.
 */
import { BrandingUpdateBody } from '@/lib/schemas/branding';
import { serializeBranding, updateBranding } from '@/server/services/pricing/branding';
import { withRoute } from '../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER'], body: BrandingUpdateBody, capability: 'pricing.override' }, async ({ ctx, body }) => ({
  branding: serializeBranding(await updateBranding(ctx, body)),
}));

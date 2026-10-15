/**
 * POST /api/app/pricing/settings (T13): tax (explicit mode), workspace discount limit, quote
 * validity and GSTIN. Partial body (SettingsUpdateBody); the merged result is validated as a whole
 * (422 with a domain code) and audited.
 */
import { SettingsUpdateBody } from '@/lib/schemas/pricing';
import { serializeSettings } from '@/server/services/pricing/catalog';
import { updatePricingSettings } from '@/server/services/pricing/settings';
import { withRoute } from '../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER'], body: SettingsUpdateBody, capability: 'pricing.override' }, async ({ ctx, body }) => ({
  settings: serializeSettings(await updatePricingSettings(ctx, body)),
}));

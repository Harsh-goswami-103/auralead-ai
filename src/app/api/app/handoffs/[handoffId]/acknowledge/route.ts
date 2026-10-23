/**
 * POST /api/app/handoffs/[handoffId]/acknowledge (ADR-124, lead-gen F5): the client's "Acknowledge"
 * on a handed-over lead. HANDED_OVER becomes ACKNOWLEDGED once (a repeat answers `changed: false`),
 * audited `lead.handoff.acknowledge`. Role USER (an owner or member of the session's workspace),
 * `leads.read`; a handoff of another workspace is 404.
 */
import { acknowledgeHandoff } from '@/server/services/leads/handoff';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER'] }, async ({ ctx, params }) => acknowledgeHandoff(ctx, { handoffId: String(params.handoffId) }));

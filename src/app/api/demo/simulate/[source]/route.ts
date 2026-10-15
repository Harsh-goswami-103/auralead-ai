/**
 * POST /api/demo/simulate/[source] (T11, R11, AT2): DEMO-only source simulation for `sheets`,
 * `meta` and `gmaps`. 404 in a LIVE process before anything else runs (withRoute demoOnly), and
 * the service refuses any LIVE workspace. The caller must be a workspace owner/member or an
 * actively assigned employee with `leads.write` in the target workspace; `workspaceSlug` is
 * resolved against the caller's own memberships or assignments (404 otherwise), never trusted.
 *
 * The simulator persists a provider-shaped WebhookEvent and enqueues `ingest.process`, exactly as
 * a verified webhook does; the worker creates the leads. The answer lists each event with its
 * outcome (ACCEPTED, or DUPLICATE for a replayed batch id with its stored result once processed).
 */
import { NotFoundError } from '@/lib/errors';
import { SIMULATION_SOURCES, simulateBodySchema, type SimulationSource } from '@/lib/schemas/webhooks';
import { buildUserContext } from '@/server/auth/context';
import { requireCapability } from '@/server/auth/guards';
import { requireKeyRing } from '@/server/security/secrets';
import { simulateSource } from '@/server/services/webhooks/simulate';
import { withRoute } from '../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isSource(value: unknown): value is SimulationSource {
  return typeof value === 'string' && (SIMULATION_SOURCES as readonly string[]).includes(value);
}

export const POST = withRoute(
  { auth: 'session', demoOnly: true, roles: ['USER', 'EMPLOYEE'], body: simulateBodySchema },
  async ({ ctx, session, body, params, runtime }) => {
    const source = params.source;
    if (!isSource(source)) throw new NotFoundError({ message: `no simulator for source ${String(source)}` });
    if (!session) throw new NotFoundError();
    const target =
      body.workspaceSlug === undefined
        ? ctx
        : await buildUserContext(session, { prisma: runtime.prisma, mode: ctx.mode, clock: ctx.clock }, { correlationId: ctx.correlationId, workspaceSlug: body.workspaceSlug });
    requireCapability(target, 'leads.write');
    const result = await simulateSource(target, { source, count: body.count, batchId: body.batchId }, { keyRing: requireKeyRing(runtime.config) });
    return {
      source: result.source,
      workspaceId: result.workspaceId,
      batchId: result.batchId,
      records: result.records,
      events: result.events,
    };
  },
);

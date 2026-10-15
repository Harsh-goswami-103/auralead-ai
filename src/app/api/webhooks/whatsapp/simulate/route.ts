/**
 * POST /api/webhooks/whatsapp/simulate (T20, DEMO only): the customer's side of WhatsApp for the
 * demo. A signed-in owner, member or assigned employee with `leads.write` in the target workspace
 * makes one of their leads "send" a text, a quick reply (QUOTE, CALL, STOP) or START. The payload
 * goes through the same receive path as the verified webhook (a Stop is applied synchronously, the
 * rest is processed by the worker), flagged simulated. 404 in a LIVE process or for a LIVE
 * workspace; `workspaceSlug` is resolved server-side like a `[ws]` segment (ADR-54).
 */
import { NotFoundError } from '@/lib/errors';
import { whatsappSimulateBodySchema } from '@/lib/schemas/webhooks/whatsapp';
import { buildUserContext } from '@/server/auth/context';
import { requireCapability } from '@/server/auth/guards';
import { requireKeyRing } from '@/server/security/secrets';
import { simulateWhatsAppInbound } from '@/server/services/messaging/inbound';
import { withRoute } from '../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute(
  { auth: 'session', demoOnly: true, roles: ['USER', 'EMPLOYEE'], body: whatsappSimulateBodySchema },
  async ({ ctx, session, body, runtime }) => {
    if (!session) throw new NotFoundError();
    const target =
      body.workspaceSlug === undefined
        ? ctx
        : await buildUserContext(session, { prisma: runtime.prisma, mode: ctx.mode, clock: ctx.clock }, { correlationId: ctx.correlationId, workspaceSlug: body.workspaceSlug });
    requireCapability(target, 'leads.write');
    const result = await simulateWhatsAppInbound(
      target,
      { leadId: body.leadId, event: body.event, ...(body.text !== undefined ? { text: body.text } : {}) },
      {
        keyRing: requireKeyRing(runtime.config),
        contactKeyPepper: runtime.config.secrets.suppressionPepper ?? '',
        mode: runtime.config.mode,
        journalDir: runtime.config.paths.journalDir,
      },
    );
    return {
      messageId: result.messageId,
      events: result.summary.items.map((i) => ({ eventId: i.eventId, outcome: i.outcome, status: i.status, suppressed: i.stop ? i.stop.outcome : null })),
    };
  },
);

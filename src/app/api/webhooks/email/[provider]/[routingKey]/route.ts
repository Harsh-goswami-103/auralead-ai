/**
 * POST /api/webhooks/email/resend/[routingKey] (T33; R27, plan §9 Webhooks, ADR-101).
 *
 * Resend's signed event deliveries for one workspace's Resend integration. The body is read once
 * as raw bytes with a 256 KB cap, then `services/messaging/resend-webhook.ts` routes by the
 * integration's own routing key (never by payload), verifies the Svix-style signature with that
 * integration's signing secret (+/- 5 minutes) and stores the event (idempotent per svix-id) with
 * a synchronous suppression for a hard bounce or a complaint. Unknown key 404; missing secret, bad
 * or stale signature 401; unreadable body 400; each counted in WebhookRejection, nothing stored.
 * Non-delivery events and `email.received` (inbound email is not supported for this provider) are
 * acknowledged with 200 and not stored. Cookies are never read. Any provider other than `resend`
 * is 404.
 */
import { NotFoundError, SignatureInvalidError, ValidationError } from '@/lib/errors';
import { requireKeyRing } from '@/server/security/secrets';
import { svixHeadersOf } from '@/server/security/svix';
import { receiveResendDelivery } from '@/server/services/messaging/resend-webhook';
import { json, rawRoute } from '../../../_lib/raw-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 256 * 1024;

export const POST = rawRoute({ maxBytes: MAX_BYTES }, async ({ req, raw, params, runtime: rt, clock, correlationId }) => {
  if (params.provider !== 'resend' || typeof params.routingKey !== 'string') throw new NotFoundError();
  const result = await receiveResendDelivery(
    { db: rt.prisma, clock, correlationId },
    { routingKey: params.routingKey, headers: svixHeadersOf(req.headers), raw },
    { keyRing: requireKeyRing(rt.config), contactKeyPepper: rt.config.secrets.suppressionPepper ?? '', mode: rt.config.mode, journalDir: rt.config.paths.journalDir },
  );
  switch (result.kind) {
    case 'rejected':
      if (result.status === 404) throw new NotFoundError({ code: 'WEBHOOK_ROUTE_UNKNOWN', userMessage: 'No Resend integration uses this webhook URL.' });
      if (result.status === 400) throw new ValidationError({ code: result.reason, userMessage: 'The webhook body is not a Resend event.' });
      throw new SignatureInvalidError({ code: result.reason === 'REPLAY_WINDOW' ? 'REPLAY_WINDOW' : 'SIGNATURE_INVALID' });
    case 'ignored':
      return json({ outcome: 'IGNORED', type: result.type });
    case 'received':
      return json({ outcome: result.item.outcome, eventId: result.item.eventId, status: result.item.status, suppressed: result.item.stop ? result.item.stop.outcome : null });
  }
});

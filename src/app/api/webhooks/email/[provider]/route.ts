/**
 * POST /api/webhooks/email/[provider] (T20; R27, M2).
 *  - `demo`: the DEMO email provider (DEMO process only, 404 in LIVE). Events use Resend's event
 *    shape and are signed `x-auralead-signature: sha256=<hex HMAC>` over the raw body with a key
 *    derived from SESSION_SECRET; `x-auralead-event-id` is the idempotency key. A permanent bounce
 *    or a complaint suppresses the address on EMAIL only, synchronously; every event is a
 *    delivery status for the message.
 *  - `resend`: 404 here; T33's Svix-verified receiver is `[provider]/[routingKey]` (the workspace's
 *    own URL), so no event is accepted unverified or unrouted.
 *  - `smtp`: SMTP has no webhooks: 404 `EMAIL_PROVIDER_NO_WEBHOOKS` with the disclosure that it has
 *    no inbound and does not track bounces.
 */
import { NotFoundError, SignatureInvalidError, ValidationError } from '@/lib/errors';
import { emailEventSchema } from '@/lib/schemas/webhooks/email';
import { verifyHmacHex } from '@/server/security/hmac';
import { requireKeyRing } from '@/server/security/secrets';
import { demoEmailWebhookKey, EMAIL_PROVIDER_CAPABILITIES, receiveEmailEvent } from '@/server/services/messaging/inbound';
import { recordWebhookRejection } from '@/server/services/webhooks/rejections';
import { json, rawRoute } from '../../_lib/raw-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 256 * 1024;
const EVENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const POST = rawRoute({ maxBytes: MAX_BYTES }, async ({ req, raw, params, runtime: rt, clock, correlationId }) => {
  const provider = params.provider;
  if (provider === 'smtp') {
    throw new NotFoundError({ code: 'EMAIL_PROVIDER_NO_WEBHOOKS', userMessage: EMAIL_PROVIDER_CAPABILITIES.EMAIL_SMTP.disclosure });
  }
  if (provider === 'resend') {
    // T33: Resend posts to the workspace's own URL, /api/webhooks/email/resend/<routing key>, shown on the setup page.
    throw new NotFoundError({ code: 'WEBHOOK_ROUTE_UNKNOWN', userMessage: 'Resend deliveries go to the workspace webhook URL shown on the Resend setup page.' });
  }
  if (provider !== 'demo' || rt.config.mode !== 'demo') throw new NotFoundError();

  const secret = rt.config.secrets.sessionSecret;
  const signature = req.headers.get('x-auralead-signature');
  const reject = async (reason: string, error: Error): Promise<never> => {
    await recordWebhookRejection(rt.prisma, clock, { provider: 'DEMO', reason });
    throw error;
  };
  if (!secret) await reject('SECRET_NOT_CONFIGURED', new SignatureInvalidError({ message: 'SESSION_SECRET is not set' }));
  if (!signature) await reject('SIGNATURE_MISSING', new SignatureInvalidError());
  if (!signature!.startsWith('sha256=') || !verifyHmacHex(demoEmailWebhookKey(secret!), raw, signature!.slice('sha256='.length))) await reject('SIGNATURE_INVALID', new SignatureInvalidError());
  const eventId = req.headers.get('x-auralead-event-id') ?? '';
  if (!EVENT_ID.test(eventId)) return reject('EVENT_ID_INVALID', new ValidationError({ code: 'EVENT_ID_INVALID', userMessage: 'x-auralead-event-id is missing or invalid.' }));

  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return reject('INVALID_JSON', new ValidationError({ code: 'INVALID_JSON', userMessage: 'The webhook body is not valid JSON.' }));
  }
  const parsed = emailEventSchema.safeParse(body);
  if (!parsed.success) return reject('INVALID_PAYLOAD', new ValidationError({ code: 'INVALID_PAYLOAD', userMessage: 'The webhook body is not an email event.' }));

  const result = await receiveEmailEvent(
    { db: rt.prisma, clock, correlationId },
    { provider: 'DEMO', eventId, event: parsed.data, simulated: true },
    { keyRing: requireKeyRing(rt.config), contactKeyPepper: rt.config.secrets.suppressionPepper ?? '', mode: rt.config.mode, journalDir: rt.config.paths.journalDir },
  );
  return json({ eventId: result.eventId, outcome: result.outcome, status: result.status, suppressed: result.stop ? result.stop.outcome : null });
});

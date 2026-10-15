/**
 * /api/webhooks/whatsapp (T20, plan §9 Webhooks, A34, C14, C9).
 *
 * GET: Meta's subscription check. 200 with the challenge only when `hub.mode=subscribe`, the
 * verify token equals META_VERIFY_TOKEN (constant-time) and the challenge is `[0-9A-Za-z_-]{1,128}`;
 * otherwise 403 with nothing echoed.
 *
 * POST: the body is read once as raw bytes (1 MB cap) and `X-Hub-Signature-256` is verified over
 * those bytes with META_APP_SECRET (timingSafeEqual) before anything is parsed. A missing or bad
 * signature, a missing secret or an unreadable body is 401/400 with a WebhookRejection counter and
 * nothing persisted. Accepted deliveries are routed by `phone_number_id` through
 * Integration.routingKey and persisted per message and status; a Stop is applied in the route
 * transaction (C9); everything else is processed by the worker. Answers 200 quickly.
 */
import { AuthError, SignatureInvalidError, ValidationError } from '@/lib/errors';
import { waWebhookSchema } from '@/lib/schemas/webhooks/whatsapp';
import { safeEqual, verifyHubSignature256 } from '@/server/security/hmac';
import { RAW_BODY_LIMITS } from '@/server/security/raw-body';
import { requireKeyRing } from '@/server/security/secrets';
import { receiveWhatsAppWebhook } from '@/server/services/messaging/inbound';
import { recordWebhookRejection } from '@/server/services/webhooks/rejections';
import { json, rawRoute } from '../_lib/raw-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHALLENGE = /^[0-9A-Za-z_-]{1,128}$/;

export const GET = rawRoute({ maxBytes: 0 }, async ({ req, runtime: rt }) => {
  const url = new URL(req.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token') ?? '';
  const challenge = url.searchParams.get('hub.challenge') ?? '';
  const expected = rt.config.meta.verifyToken;
  const ok = mode === 'subscribe' && expected !== null && expected !== '' && safeEqual(token, expected) && CHALLENGE.test(challenge);
  if (!ok) return new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
});

export const POST = rawRoute({ maxBytes: RAW_BODY_LIMITS.whatsapp }, async ({ req, raw, runtime: rt, clock, correlationId }) => {
  const reject = async (reason: string, error: Error): Promise<never> => {
    await recordWebhookRejection(rt.prisma, clock, { provider: 'WHATSAPP', reason });
    throw error;
  };
  const secret = rt.config.meta.appSecret;
  const header = req.headers.get('x-hub-signature-256');
  if (!secret) await reject('SECRET_NOT_CONFIGURED', new AuthError({ code: 'WEBHOOK_NOT_CONFIGURED', message: 'META_APP_SECRET is not set' }));
  if (!header) await reject('SIGNATURE_MISSING', new SignatureInvalidError({ message: 'X-Hub-Signature-256 is missing' }));
  if (!verifyHubSignature256(raw, header, secret!)) await reject('SIGNATURE_INVALID', new SignatureInvalidError());

  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return reject('INVALID_JSON', new ValidationError({ code: 'INVALID_JSON', userMessage: 'The webhook body is not valid JSON.' }));
  }
  const parsed = waWebhookSchema.safeParse(body);
  if (!parsed.success) return reject('INVALID_PAYLOAD', new ValidationError({ code: 'INVALID_PAYLOAD', userMessage: 'The webhook body is not a WhatsApp Business Account notification.' }));

  const summary = await receiveWhatsAppWebhook(
    { db: rt.prisma, clock, correlationId },
    parsed.data,
    { keyRing: requireKeyRing(rt.config), contactKeyPepper: rt.config.secrets.suppressionPepper ?? '', mode: rt.config.mode, journalDir: rt.config.paths.journalDir },
    { simulated: false, mode: rt.config.mode },
  );
  return json({ received: summary.items.length, accepted: summary.items.filter((i) => i.outcome === 'ACCEPTED').length });
});

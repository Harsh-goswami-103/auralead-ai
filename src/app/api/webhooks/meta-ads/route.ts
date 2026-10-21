/**
 * /api/webhooks/meta-ads (T35, plan §9 Webhooks, A34, C14; PRD "Meta verification + lead events").
 *
 * GET: Meta's subscription check. 200 with the challenge only when `hub.mode=subscribe`, the
 * verify token equals META_VERIFY_TOKEN (constant-time) and the challenge is `[0-9A-Za-z_-]{1,128}`;
 * otherwise 403 with nothing echoed.
 *
 * POST: the body is read once as raw bytes (1 MB cap) and `X-Hub-Signature-256` is verified over
 * those bytes with META_APP_SECRET (timingSafeEqual) before anything is parsed, so a re-serialized
 * body (other whitespace, `\u` escapes for Devanagari names) or one flipped byte fails. A missing
 * or bad signature, a missing secret or an unreadable body is 401/400 with a WebhookRejection
 * counter and nothing persisted. The `metaWebhook` limit (600 per minute) applies per client
 * address before the signature check and per routed integration before anything is written; over
 * it the answer is 429 with Retry-After, counted as a rejection, nothing persisted. Accepted
 * leadgen notifications are routed by `page_id` through Integration.routingKey, persisted as
 * `meta:{page}:{leadgen}` and processed by the worker (`meta.lead.fetch`); the route answers 200
 * quickly and never calls Meta.
 */
import { AuthError, RateLimitedError, SignatureInvalidError, ValidationError } from '@/lib/errors';
import { metaPageWebhookSchema } from '@/lib/schemas/meta';
import { safeEqual, verifyHubSignature256 } from '@/server/security/hmac';
import { clientIp } from '@/server/security/rate-limit';
import { RAW_BODY_LIMITS } from '@/server/security/raw-body';
import { requireKeyRing } from '@/server/security/secrets';
import { receiveMetaLeadgenWebhook, routePages } from '@/server/services/campaigns/meta-webhook';
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

export const POST = rawRoute({ maxBytes: RAW_BODY_LIMITS.meta }, async ({ req, raw, runtime: rt, clock, correlationId }) => {
  const reject = async (reason: string, error: Error, workspaceId: string | null = null): Promise<never> => {
    await recordWebhookRejection(rt.prisma, clock, { provider: 'META_ADS', reason, workspaceId });
    throw error;
  };
  const limited = (retryAfterSeconds: number) => new RateLimitedError({ retryAfterSeconds, userMessage: 'Too many webhook deliveries. Retry later.' });

  const ip = clientIp(req.headers, null, rt.config.trustedProxyHops);
  const byIp = rt.limiters.metaWebhook.take(`meta-webhook:ip:${ip}`);
  if (!byIp.allowed) await reject('RATE_LIMITED', limited(byIp.retryAfterSeconds));

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
  const parsed = metaPageWebhookSchema.safeParse(body);
  if (!parsed.success) return reject('INVALID_PAYLOAD', new ValidationError({ code: 'INVALID_PAYLOAD', userMessage: 'The webhook body is not a Page notification.' }));

  const routes = await routePages(rt.prisma, rt.config.mode, parsed.data);
  for (const route of routes.values()) {
    if (!route) continue;
    const decision = rt.limiters.metaWebhook.take(`meta-webhook:integration:${route.integrationId}`);
    if (!decision.allowed) await reject('RATE_LIMITED', limited(decision.retryAfterSeconds), route.workspaceId);
  }

  const summary = await receiveMetaLeadgenWebhook(rt.prisma, { clock, correlationId }, parsed.data, { keyRing: requireKeyRing(rt.config), mode: rt.config.mode, routes });
  return json({
    received: summary.items.length,
    accepted: summary.items.filter((i) => i.outcome === 'ACCEPTED').length,
    duplicate: summary.items.filter((i) => i.outcome === 'DUPLICATE').length,
    ignored: summary.ignored + summary.items.filter((i) => i.outcome === 'INVALID' || i.outcome === 'CONFLICT').length,
  });
});

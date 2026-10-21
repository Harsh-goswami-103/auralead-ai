/**
 * /api/webhooks/gmaps-extension (T36; plan §9 Extension (T8, C18), Webhooks, C14).
 *
 * POST: one batch from the Maps extension bridge. The raw body is read once (1 MiB cap, 413 over
 * it); `Authorization: Bearer alx_<keyId>_<secret>` only, cookies are never read; http(s) Origins
 * are 403; at most 200 records; per-record results; replay by batch id returns the stored
 * per-record results; 60 batches per minute per token. Everything is decided by
 * `services/extension/receive.ts`; this module only maps the request and the answer.
 *
 * OPTIONS: the CORS preflight, answered only for `chrome-extension://<allowedExtensionId>` of a
 * live token (an MV3 service worker with host permission for this origin needs no CORS at all).
 */
import { requireKeyRing } from '@/server/security/secrets';
import { RAW_BODY_LIMITS } from '@/server/security/raw-body';
import { answerExtensionPreflight, receiveExtensionBatch, type ReceiverAnswer } from '@/server/services/extension/receive';
import { rawRoute } from '../_lib/raw-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function toResponse(answer: ReceiverAnswer): Response {
  const headers = new Headers(answer.headers);
  if (answer.body === null) return new Response(null, { status: answer.status, headers });
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers });
}

export const POST = rawRoute({ maxBytes: RAW_BODY_LIMITS.extension }, async ({ req, raw, runtime: rt, clock, correlationId }) => {
  const answer = await receiveExtensionBatch(
    { db: rt.prisma, clock, correlationId, mode: rt.config.mode, keyRing: requireKeyRing(rt.config), limiter: rt.limiters.extension },
    { authorization: req.headers.get('authorization'), origin: req.headers.get('origin'), raw },
  );
  return toResponse(answer);
});

export const OPTIONS = rawRoute({ maxBytes: 0 }, async ({ req, runtime: rt, clock }) => {
  return toResponse(await answerExtensionPreflight({ db: rt.prisma, clock, mode: rt.config.mode }, { origin: req.headers.get('origin') }));
});

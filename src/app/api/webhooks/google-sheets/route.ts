/**
 * POST /api/webhooks/google-sheets (T34; plan §9 Webhooks, R8, AT3): the signed Apps Script push.
 * The body is read once as raw bytes with the 256 KB Sheets cap (413 above it) before anything is
 * parsed; cookies are never read. Verification, the replay window, the 50-row cap, idempotency per
 * integration and persistence live in `services/sheets/webhook.ts`. Answers 200 with the delivery's
 * outcome (ACCEPTED, or DUPLICATE with the stored per-record result once processed).
 */
import { RAW_BODY_LIMITS } from '@/server/security/raw-body';
import { receiveSheetsPush } from '@/server/services/sheets/webhook';
import { json, rawRoute } from '../_lib/raw-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = rawRoute({ maxBytes: RAW_BODY_LIMITS.sheets }, async ({ req, raw, runtime: rt, clock, correlationId }) => {
  const result = await receiveSheetsPush(
    { db: rt.prisma, clock, correlationId, keyRing: rt.config.secrets.credentials, mode: rt.config.mode, limiter: rt.limiters.appsScript },
    req.headers,
    raw,
  );
  return json(result);
});

/**
 * /api/unsubscribe (T20; M2 / ADR-14, C9 / ADR-06, R27). The signed token is the only credential;
 * cookies are never read.
 *  - POST `?token=...` with `List-Unsubscribe=One-Click` (RFC 8058, sent by mail clients from the
 *    `List-Unsubscribe` header): unsubscribes synchronously and answers 200 JSON.
 *  - POST with a form field `token` (the confirmation page's button): unsubscribes and answers 303
 *    back to `/unsubscribe/<token>?done=1`.
 *  - GET never unsubscribes (link scanners prefetch URLs): 303 to the confirmation page.
 * An invalid, forged or foreign-mode token is 404 and writes nothing.
 */
import { NotFoundError } from '@/lib/errors';
import { deriveUnsubscribeKey } from '@/server/services/messaging/dispatch';
import { resolveUnsubscribeToken, unsubscribeWithToken } from '@/server/services/messaging/unsubscribe';
import type { Runtime } from '@/server/boot';
import { json, rawRoute } from '../webhooks/_lib/raw-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function keyOf(rt: Runtime): Buffer {
  const secret = rt.config.secrets.sessionSecret;
  if (!secret) throw new NotFoundError({ message: 'SESSION_SECRET is not set; unsubscribe links cannot be verified' });
  return deriveUnsubscribeKey(secret);
}

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export const GET = rawRoute({ maxBytes: 0 }, async ({ req, runtime: rt }) => {
  const token = new URL(req.url).searchParams.get('token') ?? '';
  if (!(await resolveUnsubscribeToken(rt.prisma, rt.config.mode, keyOf(rt), token))) throw new NotFoundError();
  return seeOther(`/unsubscribe/${token}`);
});

export const POST = rawRoute({ maxBytes: 4096 }, async ({ req, raw, runtime: rt, clock, correlationId }) => {
  const form = new URLSearchParams(raw.toString('utf8'));
  const queryToken = new URL(req.url).searchParams.get('token');
  const formToken = form.get('token');
  const token = queryToken ?? formToken ?? '';
  const done = await unsubscribeWithToken(
    { db: rt.prisma, clock, correlationId, mode: rt.config.mode },
    token,
    { unsubscribeKey: keyOf(rt), contactKeyPepper: rt.config.secrets.suppressionPepper ?? '', journalDir: rt.config.paths.journalDir },
  );
  if (!done) throw new NotFoundError();
  if (queryToken === null && formToken !== null) return seeOther(`/unsubscribe/${token}?done=1`);
  return json({ status: 'UNSUBSCRIBED', repeat: done.result.outcome === 'ALREADY_ACTIVE' });
});

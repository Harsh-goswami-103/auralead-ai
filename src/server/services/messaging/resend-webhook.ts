/**
 * Resend webhook receiver (T33; plan §4.3, §9 Webhooks, A34, E1, E2, C9, ADR-62, ADR-101).
 *
 * One delivery, verified before anything is parsed or stored:
 *  1. Routing by our own key: Resend posts to `/api/webhooks/email/resend/<routingKey>`, where the
 *     key is the random `Integration.routingKey` a LIVE credential write gave the workspace's
 *     EMAIL_RESEND integration. An unknown key is refused (404) and counted; the payload is never
 *     used to pick a workspace.
 *  2. The integration's own signing secret (`webhookSecret`, a T32 encrypted credential) verifies
 *     the Svix-style signature over the raw bytes (security/svix.ts), with the +/- 5 minute window.
 *     No secret, a secret that no longer decrypts, a missing or wrong signature, or a stale
 *     timestamp is refused (401) and counted in WebhookRejection; nothing is stored.
 *  3. Only email delivery events are kept: anything that is not an `email.*` event with an email
 *     id (domain and contact events) and `email.received` (inbound email is not supported for this
 *     provider, ADR-102) is acknowledged (200 IGNORED) and not stored.
 *  4. The event goes to the shared email receive path (`receiveEmailEvent`): WebhookEvent with a
 *     redacted inspector view and an encrypted processing payload, idempotent per
 *     `(RESEND, integrationId, svix-id)` (E2: the same svix-id in two workspaces never collides), a
 *     hard bounce or a complaint suppressed synchronously through the suppression service, and
 *     `status.apply` for the rank merge (ADR-62), so duplicates and out-of-order events are safe.
 *     A verified delivery for a workspace of the other mode is stored UNROUTED.
 */
import type { PrismaClient } from '@/generated/prisma/client';
import { RESEND_ROUTING_KEY_RE } from '@/lib/domain/integrations';
import { emailEventSchema } from '@/lib/schemas/webhooks/email';
import { credentialAad, decryptSecretString, SecretDecryptError } from '@/server/security/secrets';
import { verifySvixSignature, type SvixHeaders } from '@/server/security/svix';
import { recordWebhookRejection } from '@/server/services/webhooks/rejections';
import { receiveEmailEvent, type ReceiveBase, type ReceiveDeps, type ReceivedItem, type Routing } from './inbound';

export type ResendDeliveryResult =
  | { kind: 'rejected'; status: 400 | 401 | 404; reason: string }
  | { kind: 'ignored'; type: string }
  | { kind: 'received'; item: ReceivedItem; routed: boolean };

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function rejected(db: PrismaClient, base: ReceiveBase, status: 400 | 401 | 404, reason: string, workspaceId: string | null): Promise<ResendDeliveryResult> {
  await recordWebhookRejection(db, base.clock, { provider: 'RESEND', reason, workspaceId });
  return { kind: 'rejected', status, reason };
}

function signingSecret(row: { id: string; workspaceId: string; secrets: unknown }, deps: ReceiveDeps): { ok: true; secret: string } | { ok: false; reason: 'SECRET_NOT_CONFIGURED' | 'SECRET_UNREADABLE' } {
  const envelope = record(row.secrets).webhookSecret;
  if (typeof envelope !== 'string' || envelope === '') return { ok: false, reason: 'SECRET_NOT_CONFIGURED' };
  try {
    return { ok: true, secret: decryptSecretString(deps.keyRing, envelope, credentialAad({ workspaceId: row.workspaceId, integrationId: row.id, field: 'webhookSecret' })) };
  } catch (error) {
    if (error instanceof SecretDecryptError) return { ok: false, reason: 'SECRET_UNREADABLE' };
    throw error;
  }
}

export async function receiveResendDelivery(base: ReceiveBase, input: { routingKey: string; headers: SvixHeaders; raw: Buffer }, deps: ReceiveDeps): Promise<ResendDeliveryResult> {
  const db = base.db;
  if (!RESEND_ROUTING_KEY_RE.test(input.routingKey)) return rejected(db, base, 404, 'ROUTING_KEY_UNKNOWN', null);
  const row = await db.integration.findUnique({ where: { routingKey: input.routingKey }, select: { id: true, workspaceId: true, kind: true, secrets: true } });
  if (!row || row.kind !== 'EMAIL_RESEND') return rejected(db, base, 404, 'ROUTING_KEY_UNKNOWN', null);

  const secret = signingSecret(row, deps);
  if (!secret.ok) return rejected(db, base, 401, secret.reason, row.workspaceId);
  const verified = verifySvixSignature({ secret: secret.secret, headers: input.headers, raw: input.raw, now: base.clock.now() });
  if (!verified.ok) return rejected(db, base, 401, verified.reason, row.workspaceId);

  let body: unknown;
  try {
    body = JSON.parse(input.raw.toString('utf8')) as unknown;
  } catch {
    return rejected(db, base, 400, 'INVALID_JSON', row.workspaceId);
  }
  const type = record(body).type;
  if (typeof type !== 'string' || !type.startsWith('email.') || type === 'email.received' || typeof record(record(body).data).email_id !== 'string') {
    return { kind: 'ignored', type: typeof type === 'string' ? type.slice(0, 64) : 'unknown' };
  }
  const parsed = emailEventSchema.safeParse(body);
  if (!parsed.success) return rejected(db, base, 400, 'INVALID_PAYLOAD', row.workspaceId);

  const workspace = await db.workspace.findUnique({ where: { id: row.workspaceId }, select: { mode: true } });
  const routed = workspace?.mode === (deps.mode === 'demo' ? 'DEMO' : 'LIVE');
  const route: Routing = routed ? { workspaceId: row.workspaceId, integrationId: row.id } : null;
  const item = await receiveEmailEvent(base, { provider: 'RESEND', eventId: verified.id, event: parsed.data, simulated: false, route, externalKey: verified.id }, deps);
  return { kind: 'received', item, routed };
}

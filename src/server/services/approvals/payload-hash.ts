/**
 * Approval payload hash (O3, plan §5.4). An outbound approval binds exactly what the approver saw:
 * sha256 over the canonical JSON (sorted keys, no whitespace) of
 *   { channel, destinationKey, templateName, templateLang, variables, body, subject,
 *     attachment: { quoteVersionId, artifactSha256 } | null }.
 * The dispatch preflight recomputes it from the current rows; any difference (another recipient,
 * template, variables, body, subject or PDF) is `APPROVAL_STALE` and nothing is sent.
 *
 * `destinationKey` is the contact HMAC of the lead's CURRENT phone (WhatsApp) or email, so a
 * contact edit after approval changes the hash. Works for messages with and without a quote.
 */
import { createHash } from 'node:crypto';
import type { Channel } from '@/lib/domain/enums';
import { NotFoundError } from '@/lib/errors';
import { contactKey } from '@/server/security/contact-key';

export type OutboundPayload = {
  channel: Channel;
  destinationKey: string | null;
  templateName: string | null;
  templateLang: string | null;
  variables: unknown;
  body: string | null;
  subject: string | null;
  attachment: { quoteVersionId: string; artifactSha256: string | null } | null;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** Deterministic JSON: object keys sorted at every depth, undefined members dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function computePayloadHash(payload: OutboundPayload): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/** Read access the loader needs: a scoped client, a scoped transaction or a plain transaction. */
type Finder<T> = { findFirst(args: unknown): Promise<T | null> };
export type PayloadReadDb = {
  message: Finder<{ id: string; channel: Channel; conversationId: string; body: string | null; subject: string | null; templateId: string | null; variables: unknown; quoteVersionId: string | null }>;
  conversation: Finder<{ leadId: string }>;
  lead: Finder<{ phoneE164: string | null; emailNormalized: string | null }>;
  whatsAppTemplate: Finder<{ name: string; language: string }>;
  quoteArtifact: Finder<{ sha256: string }>;
};

export function destinationKeyFor(pepper: string, channel: Channel, lead: { phoneE164: string | null; emailNormalized: string | null }): string | null {
  const value = channel === 'WHATSAPP' ? lead.phoneE164 : lead.emailNormalized;
  if (value === null) return null;
  try {
    return contactKey(pepper, channel === 'WHATSAPP' ? 'phone' : 'email', value);
  } catch {
    return null;
  }
}

/** Builds the payload of one outbound Message from its current rows (workspaceId explicit, so any client works). */
export async function loadOutboundPayload(db: PayloadReadDb, ref: { workspaceId: string; messageId: string }, pepper: string): Promise<OutboundPayload> {
  const { workspaceId } = ref;
  const message = await db.message.findFirst({
    where: { id: ref.messageId, workspaceId },
    select: { id: true, channel: true, conversationId: true, body: true, subject: true, templateId: true, variables: true, quoteVersionId: true },
  });
  if (!message) throw new NotFoundError();
  const conversation = await db.conversation.findFirst({ where: { id: message.conversationId, workspaceId }, select: { leadId: true } });
  if (!conversation) throw new NotFoundError();
  const lead = await db.lead.findFirst({ where: { id: conversation.leadId, workspaceId }, select: { phoneE164: true, emailNormalized: true } });
  if (!lead) throw new NotFoundError();
  const template = message.templateId
    ? await db.whatsAppTemplate.findFirst({ where: { id: message.templateId, workspaceId }, select: { name: true, language: true } })
    : null;
  const artifact = message.quoteVersionId
    ? await db.quoteArtifact.findFirst({ where: { quoteVersionId: message.quoteVersionId, workspaceId }, select: { sha256: true } })
    : null;
  return {
    channel: message.channel,
    destinationKey: destinationKeyFor(pepper, message.channel, lead),
    templateName: template?.name ?? null,
    templateLang: template?.language ?? null,
    variables: message.variables ?? null,
    body: message.body,
    subject: message.subject,
    attachment: message.quoteVersionId ? { quoteVersionId: message.quoteVersionId, artifactSha256: artifact?.sha256 ?? null } : null,
  };
}

export async function messagePayloadHash(db: PayloadReadDb, ref: { workspaceId: string; messageId: string }, pepper: string): Promise<string> {
  return computePayloadHash(await loadOutboundPayload(db, ref, pepper));
}

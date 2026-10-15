/**
 * Email unsubscribe (M2 / ADR-14, C9 / ADR-06, R27). Every email carries a signed token
 * (`signUnsubscribeToken`, T19): `{ workspaceId, contactKey }` under a key derived from
 * SESSION_SECRET, so a link names no address and cannot be forged or moved to another contact.
 *
 * `unsubscribeWithToken` is synchronous: in one transaction the EMAIL Suppression is written (or a
 * repeat audited), the contact's QUEUED email attempts, their jobs and messages are cancelled, and
 * the audit row is written; the SuppressionJournal line is appended after commit (E8). The plain
 * address is kept on the row only when a conversation of the workspace proves which address the
 * key belongs to; otherwise the row is keyed by the HMAC alone.
 */
import type { Prisma, PrismaClient } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { contactKey } from '@/server/security/contact-key';
import { withTx } from '@/server/db/tx';
import { verifyUnsubscribeToken } from './dispatch';
import { flushSuppressionJournal, suppressContactKey, SuppressionJournalBatch, type SuppressResult } from './suppression';
import type { JournalDeps } from './suppression-journal';

export type UnsubscribeDeps = JournalDeps & { unsubscribeKey: Buffer; contactKeyPepper: string };
export type UnsubscribeBase = { db: PrismaClient; clock: Clock; correlationId: string; mode: 'demo' | 'live' };
export type ResolvedToken = { workspaceId: string; workspaceName: string; contactKey: string };

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{8,1024}\.[A-Za-z0-9_-]{20,128}$/;

/** The token's workspace (in this process's mode) and contact key, or null for anything invalid. */
export async function resolveUnsubscribeToken(db: PrismaClient, mode: 'demo' | 'live', key: Buffer, token: string): Promise<ResolvedToken | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const claims = verifyUnsubscribeToken(key, token);
  if (!claims || !/^[0-9a-f]{64}$/.test(claims.contactKey)) return null;
  const workspace = await db.workspace.findUnique({ where: { id: claims.workspaceId }, select: { id: true, name: true, mode: true } });
  if (!workspace || workspace.mode !== (mode === 'demo' ? 'DEMO' : 'LIVE')) return null;
  return { workspaceId: workspace.id, workspaceName: workspace.name, contactKey: claims.contactKey };
}

/** The plain address behind the key, when an email conversation's lead proves it. */
async function plainAddressFor(db: PrismaClient, workspaceId: string, key: string, pepper: string): Promise<string | null> {
  const conversations = await db.conversation.findMany({ where: { workspaceId, channel: 'EMAIL', contactKey: key }, select: { leadId: true }, take: 20 });
  for (const { leadId } of conversations) {
    const lead = await db.lead.findFirst({ where: { workspaceId, id: leadId }, select: { emailNormalized: true } });
    const candidates = [lead?.emailNormalized ?? null, ...(await db.leadContactKey.findMany({ where: { workspaceId, leadId, kind: 'EMAIL' }, select: { value: true } })).map((k) => k.value)];
    for (const email of candidates) {
      if (email === null) continue;
      try {
        if (contactKey(pepper, 'email', email) === key) return email;
      } catch {
        // not a usable address
      }
    }
  }
  return null;
}

export type UnsubscribeResult = { workspaceName: string; result: SuppressResult };

export async function unsubscribeWithToken(base: UnsubscribeBase, token: string, deps: UnsubscribeDeps): Promise<UnsubscribeResult | null> {
  const resolved = await resolveUnsubscribeToken(base.db, base.mode, deps.unsubscribeKey, token);
  if (!resolved) return null;
  const plain = await plainAddressFor(base.db, resolved.workspaceId, resolved.contactKey, deps.contactKeyPepper);
  const batch = new SuppressionJournalBatch();
  const ctx = { kind: 'public' as const, actor: null, workspaceId: resolved.workspaceId, correlationId: base.correlationId, clock: base.clock };
  const result = await withTx(base.db, async (tx: Prisma.TransactionClient) => {
    batch.clear();
    return suppressContactKey(tx, ctx, batch, {
      channel: 'EMAIL',
      contactKey: resolved.contactKey,
      contactPlain: plain,
      reason: 'UNSUBSCRIBE',
      sourceEventId: null,
      simulated: base.mode === 'demo',
    });
  });
  await flushSuppressionJournal(base.db, base.clock, deps, batch, base.correlationId);
  return { workspaceName: resolved.workspaceName, result };
}

/** For the confirmation page: whether the link is valid and whether the address is unsubscribed now. */
export async function unsubscribeStatus(db: PrismaClient, mode: 'demo' | 'live', key: Buffer, token: string): Promise<{ workspaceName: string; unsubscribed: boolean } | null> {
  const resolved = await resolveUnsubscribeToken(db, mode, key, token);
  if (!resolved) return null;
  const active = await db.suppression.findFirst({ where: { workspaceId: resolved.workspaceId, channel: 'EMAIL', contactKey: resolved.contactKey, clearedAt: null }, select: { id: true } });
  return { workspaceName: resolved.workspaceName, unsubscribed: active !== null };
}

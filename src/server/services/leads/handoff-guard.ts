/**
 * Handoff guard (ADR-124). Once a lead is handed over to the client (`Lead.handedOverAt` set), the
 * operator side is read-only for it: an EMPLOYEE actor may no longer queue, draft or approve a send
 * to the lead, or change its conversations' AI mode, takeover or resume. The client (USER members)
 * carries on, and automated system work is stopped by the handoff itself (AI off, takeover,
 * pipeline halted), not by this guard.
 *
 * Who counts as an EMPLOYEE actor:
 *  - a request context whose actor has the global role EMPLOYEE;
 *  - a job context (no actor) running a send that a person started, named by `initiatedBy` (a user
 *    id, as `bulk.run` passes the confirming user), when that user is an EMPLOYEE. `system:*`
 *    initiators are never refused.
 *
 * The refusal is a 409 `HANDED_OVER` conflict, raised inside the caller's transaction so nothing is
 * written. It is not a dispatch eligibility reason: the eligibility table, the dispatch preflight
 * and their reason list do not change. The bulk pre-flight reports it as a row failure through
 * `handedOverLeadIds`.
 */
import { ConflictError } from '@/lib/errors';
import type { AppCtx } from '@/server/auth/context';
import type { ScopedDb, ScopedTx } from '@/server/db/scoped';

export class HandedOverError extends ConflictError {
  static override readonly defaultCode: string = 'HANDED_OVER';
  static override readonly defaultUserMessage: string = 'This lead was handed over to the client. Only the client can message it or change its conversations now.';
}

type GuardDb = ScopedDb | ScopedTx;

const SYSTEM_INITIATOR = /^system:/;

/**
 * True when the acting person is an EMPLOYEE: the context's actor, or, for a context without an
 * actor (a job), the user named by `initiatedBy`.
 */
export async function isEmployeeActor(db: GuardDb, ctx: Pick<AppCtx, 'actor'>, initiatedBy?: string | null): Promise<boolean> {
  if (ctx.actor) return ctx.actor.role === 'EMPLOYEE';
  if (!initiatedBy || SYSTEM_INITIATOR.test(initiatedBy)) return false;
  const user = await db.user.findUnique({ where: { id: initiatedBy }, select: { globalRole: true } });
  return user?.globalRole === 'EMPLOYEE';
}

/** The ids among `leadIds` that were handed over to the client (workspace-scoped client). */
export async function handedOverLeadIds(db: GuardDb, leadIds: readonly string[]): Promise<Set<string>> {
  if (leadIds.length === 0) return new Set();
  const rows = await db.lead.findMany({ where: { id: { in: [...leadIds] }, handedOverAt: { not: null } }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

/**
 * The mode a conversation opened for this lead starts in. The handoff turns the AI off and takes
 * every open thread over (ADR-124); a thread that opens afterwards (the customer writes first, or
 * the client messages a lead that had no thread) starts the same way, so the thread never offers AI
 * drafts for a lead the client has taken. Empty for a lead that was not handed over (the column
 * defaults apply).
 */
export async function newConversationMode(db: GuardDb, leadId: string): Promise<{ aiMode?: 'OFF'; humanTakeover?: true }> {
  const lead = await db.lead.findFirst({ where: { id: leadId }, select: { handedOverAt: true } });
  return lead?.handedOverAt ? { aiMode: 'OFF', humanTakeover: true } : {};
}

/**
 * Throws `HandedOverError` (409 HANDED_OVER) when the lead was handed over and the acting person is
 * an EMPLOYEE. An unknown lead is left to the caller (its own lookup answers 404).
 */
export async function assertNotHandedOver(tx: GuardDb, ctx: Pick<AppCtx, 'actor'>, leadId: string, opts: { initiatedBy?: string | null } = {}): Promise<void> {
  const lead = await tx.lead.findFirst({ where: { id: leadId }, select: { handedOverAt: true } });
  if (!lead?.handedOverAt) return;
  if (!(await isEmployeeActor(tx, ctx, opts.initiatedBy))) return;
  throw new HandedOverError({ safeDetails: { leadId } });
}

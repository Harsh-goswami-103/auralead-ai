/**
 * Places details on imported leads (ADR-118 (d), slice F1, P1).
 *
 * - `expirePlacesDetails` (the `leads.placesExpire` sweep, in its fenced transaction): for every
 *   lead of the workspace whose `placesContentExpiresAt` has passed and whose contact was not
 *   confirmed first-party (an inbound WhatsApp confirms it; a handed-over lead, a lead with a quote
 *   or one whose customer has written is left alone too), it nulls the Places-sourced fields (phone and alternate phones, rating,
 *   review count, address, PIN code, category), removes the lead's phone contact keys (they hold
 *   the same number), and clears `placesContentExpiresAt`. The place ID, the name and the
 *   workspace's own data stay. Audited `lead.places_expire` with the count; re-armed for the next
 *   expiry.
 * - `confirmLeadContact` (the operator's "Confirm details", needs `leads.write`): records that the
 *   business confirmed its details (`contactConfirmedAt`, `contactConfirmedVia OPERATOR`), so the
 *   sweep keeps them. Idempotent (a second confirmation changes nothing) and audited
 *   `lead.contact_confirm`.
 */
import { NotFoundError } from '@/lib/errors';
import type { ContactConfirmedVia } from '@/lib/domain/lead-gen';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import type { JobStore } from '@/server/jobs/queue';
import type { TxClient } from '@/server/jobs/types';
import { recordAudit } from '@/server/services/audit/record';
import { loadActiveScoringConfig } from '@/server/services/scoring/config';
import { scoreData, scoreInputOf } from '@/server/services/scoring/record';
import { scoreLead } from '@/server/services/scoring/score';
import { enqueuePlacesExpire } from './jobs';

const BATCH = 200;

/**
 * Leads the sweep leaves alone besides the confirmed ones: a lead that was handed over, that has a
 * quote, or whose customer has written in. Their number is in live use (sends, quote delivery, the
 * thread's contact key), so clearing it would break the conversation and split the thread.
 */
const IN_RELATIONSHIP = { handedOverAt: null, quotes: { none: {} }, conversations: { none: { lastInboundProviderAt: { not: null } } } } as const;

export async function expirePlacesDetails(tx: TxClient, ctx: AppCtx & { workspaceId: string }, input: { jobId: string }): Promise<{ expired: number; nextExpiry: Date | null }> {
  const now = ctx.clock.now();
  let expired = 0;
  for (;;) {
    const due = await tx.lead.findMany({ where: { workspaceId: ctx.workspaceId, placesContentExpiresAt: { lte: now }, contactConfirmedAt: null, ...IN_RELATIONSHIP }, select: { id: true }, take: BATCH, orderBy: { id: 'asc' } });
    if (due.length === 0) break;
    const ids = due.map((l) => l.id);
    await tx.lead.updateMany({
      where: { workspaceId: ctx.workspaceId, id: { in: ids }, contactConfirmedAt: null, ...IN_RELATIONSHIP },
      data: { phoneE164: null, phoneRaw: null, alternatePhones: [], rating: null, reviewCount: null, address: null, pincode: null, category: null, placesContentExpiresAt: null },
    });
    await tx.leadContactKey.deleteMany({ where: { workspaceId: ctx.workspaceId, leadId: { in: ids }, kind: 'PHONE' } });
    // The persisted score reasons quote the rating and review count ("Rated 4.5 of 5"): rescore from
    // the fields that are left so no Places-sourced value survives the expiry as text.
    const scoring = await loadActiveScoringConfig(tx, ctx.workspaceId);
    if (scoring !== null) {
      for (const lead of await tx.lead.findMany({ where: { workspaceId: ctx.workspaceId, id: { in: ids } } })) {
        await tx.lead.updateMany({ where: { id: lead.id, workspaceId: ctx.workspaceId }, data: scoreData(scoreLead(scoreInputOf(lead), scoring)) });
      }
    }
    expired += ids.length;
    if (due.length < BATCH) break;
  }
  if (expired > 0) {
    await recordAudit(tx, ctx, { action: 'lead.places_expire', targetType: 'Workspace', targetId: ctx.workspaceId, workspaceId: ctx.workspaceId, summary: { leads: expired, fields: ['phone', 'rating', 'reviewCount', 'address', 'pincode', 'category'], jobId: input.jobId } });
  }
  const next = await tx.lead.findFirst({ where: { workspaceId: ctx.workspaceId, placesContentExpiresAt: { gt: now }, contactConfirmedAt: null }, orderBy: { placesContentExpiresAt: 'asc' }, select: { placesContentExpiresAt: true } });
  const nextExpiry = next?.placesContentExpiresAt ?? null;
  if (nextExpiry) await enqueuePlacesExpire(tx as unknown as JobStore, ctx.clock, { workspaceId: ctx.workspaceId, expiresAt: nextExpiry, correlationId: ctx.correlationId, causationId: input.jobId });
  return { expired, nextExpiry };
}

export type ConfirmContactResult = { leadId: string; confirmed: boolean; contactConfirmedAt: string; contactConfirmedVia: ContactConfirmedVia | string };

export async function confirmLeadContact(ctx: AppCtx, leadId: string): Promise<ConfirmContactResult> {
  requireCapability(ctx, 'leads.write');
  const workspaceId = requireWorkspace(ctx);
  const now = ctx.clock.now();
  return withTx(ctx.db, async (tx) => {
    const lead = await tx.lead.findFirst({ where: { id: leadId, mergedIntoLeadId: null }, select: { id: true, contactConfirmedAt: true, contactConfirmedVia: true, placesContentExpiresAt: true, simulated: true } });
    if (!lead) throw new NotFoundError();
    if (lead.contactConfirmedAt) return { leadId: lead.id, confirmed: false, contactConfirmedAt: lead.contactConfirmedAt.toISOString(), contactConfirmedVia: lead.contactConfirmedVia ?? 'OPERATOR' };
    const via: ContactConfirmedVia = 'OPERATOR';
    await tx.lead.update({ where: { id: lead.id }, data: { contactConfirmedAt: now, contactConfirmedVia: via } });
    await recordAudit(tx, ctx, {
      action: 'lead.contact_confirm',
      targetType: 'Lead',
      targetId: lead.id,
      workspaceId,
      simulated: lead.simulated,
      summary: { via, placesDetails: lead.placesContentExpiresAt === null ? 'NONE_PENDING' : 'KEPT' },
    });
    return { leadId: lead.id, confirmed: true, contactConfirmedAt: now.toISOString(), contactConfirmedVia: via };
  });
}

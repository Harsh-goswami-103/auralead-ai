/**
 * Approval rows for quote versions (T15, plan §5.4, §6.1). Every quote version gets one
 * QUOTE_VERSION Approval: PENDING when the version is created (the item the approval queue shows),
 * APPROVED by the approve CAS (`decidedBy`, `decidedAt`; at most one APPROVED per version, partial
 * unique), INVALIDATED when a material edit or cancel makes it stale. `flags` carries what the
 * approver must see (AI policy flags such as `ai_price_ignored`, `needs_pricing_review`).
 * Message approvals with a payload hash (O3) are T19's (`payload-hash.ts`).
 *
 * All functions run inside the caller's transaction on the tenant-scoped client.
 */
import type { Prisma } from '@/generated/prisma/client';
import type { AppCtx } from '@/server/auth/context';
import { requireWorkspace } from '@/server/auth/guards';
import type { ScopedTx } from '@/server/db/scoped';

export type QuoteApprovalRef = { quoteId: string; quoteVersionId: string; flags: readonly string[] };

const flagsJson = (flags: readonly string[]) => [...new Set(flags)] as Prisma.InputJsonArray;

export async function openQuoteVersionApproval(tx: ScopedTx, ctx: AppCtx, ref: QuoteApprovalRef): Promise<{ id: string }> {
  return tx.approval.create({
    data: {
      workspaceId: requireWorkspace(ctx),
      kind: 'QUOTE_VERSION',
      status: 'PENDING',
      quoteId: ref.quoteId,
      quoteVersionId: ref.quoteVersionId,
      flags: flagsJson(ref.flags),
      requestedAt: ctx.clock.now(),
    },
    select: { id: true },
  });
}

/** Turns the version's PENDING approval into APPROVED (or records one when none is open). */
export async function approveQuoteVersionApproval(tx: ScopedTx, ctx: AppCtx, ref: QuoteApprovalRef): Promise<{ id: string }> {
  const now = ctx.clock.now();
  const decidedBy = ctx.actor?.userId ?? `system:${ctx.kind}`;
  const open = await tx.approval.findFirst({ where: { kind: 'QUOTE_VERSION', quoteVersionId: ref.quoteVersionId, status: 'PENDING' }, select: { id: true } });
  if (open) {
    await tx.approval.update({ where: { id: open.id }, data: { status: 'APPROVED', decidedBy, decidedAt: now } });
    return open;
  }
  return tx.approval.create({
    data: {
      workspaceId: requireWorkspace(ctx),
      kind: 'QUOTE_VERSION',
      status: 'APPROVED',
      quoteId: ref.quoteId,
      quoteVersionId: ref.quoteVersionId,
      flags: flagsJson(ref.flags),
      requestedAt: now,
      decidedBy,
      decidedAt: now,
    },
    select: { id: true },
  });
}

export type InvalidationReason = 'QUOTE_REVISED' | 'QUOTE_CANCELLED';

/**
 * Marks every open (PENDING or APPROVED) approval bound to the quote or to any of its versions
 * INVALIDATED, including message approvals that attach one of the versions. Returns the count.
 */
export async function invalidateQuoteApprovals(tx: ScopedTx, ctx: AppCtx, input: { quoteId: string; versionIds: readonly string[]; reason: InvalidationReason }): Promise<number> {
  const result = await tx.approval.updateMany({
    where: {
      status: { in: ['PENDING', 'APPROVED'] },
      OR: [{ quoteId: input.quoteId }, { quoteVersionId: { in: [...input.versionIds] } }],
    },
    data: { status: 'INVALIDATED', invalidatedAt: ctx.clock.now(), invalidationReason: input.reason },
  });
  return result.count;
}

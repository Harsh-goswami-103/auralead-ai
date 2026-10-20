/**
 * Manual sales-stage moves (T26, R4, plan §11 M4). The sales stage is a person's view of where a
 * lead stands; it is separate from consent, approval and delivery, which this module never reads
 * or writes (eligibility never reads the stage either, T18).
 *
 * - A move is a compare-and-set on `Lead.stageVersion`: the caller sends the version it saw, the
 *   update matches only that version, and a stale version answers 409 STAGE_VERSION_CONFLICT with
 *   the current stage and version, so a Kanban board opened before another person's move or an
 *   automatic promotion cannot overwrite it blindly.
 * - People may move a lead in any direction (reopening a lost lead included). Automatic
 *   promotions elsewhere (dispatch settle, inbound reply, quote sent or accepted) only move a lead
 *   forward and bump the version too.
 * - LOST needs a short reason; every move is audited `lead.stage` with from, to and the new
 *   version, and the reason when one was given. A move to the current stage is a no-op.
 * - A merged lead is refused (422 LEAD_MERGED): it lives on in the lead it was merged into.
 */
import type { SalesStage } from '@/generated/prisma/client';
import { ConflictError, DomainRuleError, NotFoundError } from '@/lib/errors';
import { LEAD_LOST_REASON_MIN, type LeadStageResult } from '@/lib/schemas/leads';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { recordAudit } from '@/server/services/audit/record';

export class StageVersionConflictError extends ConflictError {
  static override readonly defaultCode: string = 'STAGE_VERSION_CONFLICT';
  static override readonly defaultUserMessage: string = 'This lead changed since you opened it. Reload to see its current stage.';
}

export type MoveLeadStageInput = { leadId: string; toStage: SalesStage; expectedStageVersion: number; reason?: string };

export async function moveLeadStage(ctx: AppCtx, input: MoveLeadStageInput): Promise<LeadStageResult> {
  requireCapability(ctx, 'leads.write');
  const workspaceId = requireWorkspace(ctx);
  const reason = input.reason?.trim() || null;
  if (input.toStage === 'LOST' && (reason === null || reason.length < LEAD_LOST_REASON_MIN)) {
    throw new DomainRuleError({
      code: 'LOST_REASON_REQUIRED',
      userMessage: 'Say briefly why this lead is lost (at least 3 characters).',
      safeDetails: { issues: [{ path: 'reason', message: `at least ${LEAD_LOST_REASON_MIN} characters` }] },
    });
  }

  return withTx(ctx.db, async (tx) => {
    const lead = await tx.lead.findFirst({ where: { id: input.leadId }, select: { id: true, salesStage: true, stageVersion: true, mergedIntoLeadId: true, simulated: true } });
    if (!lead) throw new NotFoundError();
    if (lead.mergedIntoLeadId !== null) {
      throw new DomainRuleError({ code: 'LEAD_MERGED', userMessage: 'This lead was merged into another lead. Move that lead instead.' });
    }
    const conflict = () =>
      new StageVersionConflictError({ safeDetails: { currentStage: lead.salesStage, currentStageVersion: lead.stageVersion, expectedStageVersion: input.expectedStageVersion } });
    if (lead.stageVersion !== input.expectedStageVersion) throw conflict();
    if (lead.salesStage === input.toStage) return { changed: false, lead: { id: lead.id, salesStage: lead.salesStage, stageVersion: lead.stageVersion } };

    const next = lead.stageVersion + 1;
    const cas = await tx.lead.updateMany({
      where: { id: lead.id, stageVersion: input.expectedStageVersion },
      data: { salesStage: input.toStage, stageVersion: next, updatedAt: ctx.clock.now() },
    });
    if (cas.count !== 1) throw conflict();
    await recordAudit(tx, ctx, {
      action: 'lead.stage',
      targetType: 'Lead',
      targetId: lead.id,
      workspaceId,
      simulated: lead.simulated,
      reason,
      summary: { from: lead.salesStage, to: input.toStage, stageVersion: next, manual: true },
    });
    return { changed: true, lead: { id: lead.id, salesStage: input.toStage, stageVersion: next } };
  });
}

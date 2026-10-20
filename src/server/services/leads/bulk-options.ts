/**
 * What the operator console's bulk send needs before anything is checked (T26 wiring of the T23
 * bulk routes): the workspace's approved WhatsApp templates (raw provider status, never an enum,
 * plan §5.1) and whether the viewer may confirm a bulk send (dispatch.send and approvals.decide;
 * the confirmation is the approval, ADR-61). Eligibility itself is the pre-flight's.
 */
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireWorkspace } from '@/server/auth/guards';

export type BulkOptions = {
  templates: Array<{ id: string; name: string; language: string }>;
  canConfirm: boolean;
  missing: Array<'dispatch.send' | 'approvals.decide'>;
};

export async function loadBulkOptions(ctx: AppCtx): Promise<BulkOptions> {
  requireWorkspace(ctx);
  const missing = (['dispatch.send', 'approvals.decide'] as const).filter((c) => !hasCapability(ctx, c));
  const rows = await ctx.db.whatsAppTemplate.findMany({ orderBy: [{ name: 'asc' }, { language: 'asc' }], select: { id: true, name: true, language: true, status: true } });
  return {
    templates: rows.filter((t) => t.status.trim().toUpperCase() === 'APPROVED').map((t) => ({ id: t.id, name: t.name, language: t.language })),
    canConfirm: missing.length === 0,
    missing,
  };
}

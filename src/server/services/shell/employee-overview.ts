/**
 * Per-workspace facts for the employee's assignment overview (T28; 06-design §11.2.2 "Employee
 * overview: assigned workspaces with counts needing action, cross-workspace approval count,
 * integration health summary per workspace").
 *
 * The page reads each assigned workspace through its own tenant-scoped context (the `[ws]`
 * resolution), so nothing here spans tenants. Every number is a count of stored rows:
 * - pending approvals (PENDING Approval rows) and leads created in the last 7 days, both only with
 *   `leads.read` (null otherwise: "not readable", never zero);
 * - integration health over the seven kinds: CONNECTED, SIMULATED, needing attention
 *   (CONFIGURED_UNVERIFIED, VERIFYING, DEGRADED, ERROR, REVOKED) and not configured;
 * - the active pipeline version and its approval mode.
 */
import type { IntegrationStatus, PipelineApprovalMode } from '@/lib/domain/enums';
import { IntegrationKind } from '@/lib/domain/enums';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireWorkspace } from '@/server/auth/guards';

export type WorkspaceOverview = {
  pendingApprovals: number | null;
  newLeads7d: number | null;
  integrations: { total: number; connected: number; simulated: number; attention: number; notConfigured: number };
  pipeline: { version: number; approvalMode: PipelineApprovalMode } | null;
};

const ATTENTION: ReadonlySet<IntegrationStatus> = new Set(['CONFIGURED_UNVERIFIED', 'VERIFYING', 'DEGRADED', 'ERROR', 'REVOKED']);
const WEEK_MS = 7 * 86_400_000;

export async function getWorkspaceOverview(ctx: AppCtx): Promise<WorkspaceOverview> {
  requireWorkspace(ctx);
  const canRead = hasCapability(ctx, 'leads.read');
  const since = new Date(ctx.clock.now().getTime() - WEEK_MS);
  const [pendingApprovals, newLeads7d, rows, pipeline] = await Promise.all([
    canRead ? ctx.db.approval.count({ where: { status: 'PENDING' } }) : Promise.resolve(null),
    canRead ? ctx.db.lead.count({ where: { mergedIntoLeadId: null, createdAt: { gte: since } } }) : Promise.resolve(null),
    ctx.db.integration.findMany({ select: { kind: true, status: true } }),
    ctx.db.pipelineConfigVersion.findFirst({ where: { active: true }, select: { version: true, approvalMode: true } }),
  ]);
  const statuses = IntegrationKind.map((kind) => rows.find((r) => r.kind === kind)?.status ?? 'NOT_CONFIGURED');
  return {
    pendingApprovals,
    newLeads7d,
    integrations: {
      total: statuses.length,
      connected: statuses.filter((s) => s === 'CONNECTED').length,
      simulated: statuses.filter((s) => s === 'SIMULATED').length,
      attention: statuses.filter((s) => ATTENTION.has(s)).length,
      notConfigured: statuses.filter((s) => s === 'NOT_CONFIGURED').length,
    },
    pipeline,
  };
}

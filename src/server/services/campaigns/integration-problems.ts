/**
 * What a Meta answer says about the integration itself (T35; 02-errors §2.3 and §2.12), recorded
 * inside the caller's settle transaction:
 *  - a rejected token (Graph code 190, or HTTP 401) puts the integration back to
 *    CONFIGURED_UNVERIFIED, shown "Verification required": `verifiedAt` cleared, the reason stored,
 *    so campaign controls stop (they need a verified integration) and the setup page asks for a new
 *    token and a connection test;
 *  - a missing permission sets ERROR with the permission named ("Missing permission:
 *    leads_retrieval");
 *  - an unreadable saved secret is recorded by T32's `markCredentialUnreadable`.
 * Each change is audited once; a repeat while the same problem stands writes nothing more.
 */
import type { Prisma } from '@/generated/prisma/client';
import type { IntegrationStatus } from '@/lib/domain/enums';
import { redactText } from '@/lib/redact';
import { recordAudit, type AuditCtx } from '@/server/services/audit/record';
import { markCredentialUnreadable } from '@/server/services/integrations/credentials';

type Tx = Prisma.TransactionClient;

export type IntegrationRef = { id: string; workspaceId: string };

export type AccessProblem = { code: 'PROVIDER_AUTH' | 'PERMISSION_MISSING' | 'CREDENTIAL_UNREADABLE'; message: string; permission?: string | null; field?: string | null };

const MAX_ERROR = 500;

/** Records the problem on the integration (and audits it once). `source` names the job or route that met it. */
export async function recordMetaAccessProblem(tx: Tx, ctx: AuditCtx, integration: IntegrationRef, problem: AccessProblem, source: string): Promise<void> {
  if (problem.code === 'CREDENTIAL_UNREADABLE') {
    await markCredentialUnreadable(tx, { ...ctx, workspaceId: integration.workspaceId }, { workspaceId: integration.workspaceId, integrationId: integration.id, field: problem.field ?? null });
    return;
  }
  const current = await tx.integration.findFirst({ where: { id: integration.id, workspaceId: integration.workspaceId }, select: { status: true, lastErrorCode: true } });
  if (!current) return;
  const status: IntegrationStatus = problem.code === 'PROVIDER_AUTH' ? 'CONFIGURED_UNVERIFIED' : 'ERROR';
  if (current.status === status && current.lastErrorCode === problem.code) return;
  const now = ctx.clock.now();
  await tx.integration.updateMany({
    where: { id: integration.id, workspaceId: integration.workspaceId },
    data: { status, lastErrorCode: problem.code, lastErrorRedacted: redactText(problem.message).slice(0, MAX_ERROR), lastCheckedAt: now, ...(problem.code === 'PROVIDER_AUTH' ? { verifiedAt: null } : {}) },
  });
  await recordAudit(tx, ctx, {
    action: problem.code === 'PROVIDER_AUTH' ? 'integration.verification_required' : 'integration.permission_missing',
    targetType: 'Integration',
    targetId: integration.id,
    workspaceId: integration.workspaceId,
    result: 'FAILED',
    summary: { kind: 'META_ADS', previousStatus: current.status, status, errorCode: problem.code, permission: problem.permission ?? null, source },
  });
}

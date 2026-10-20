/**
 * "Test connection" (T28; PRD: LIVE "Unavailable integration shows Not configured / Verification
 * required with a working setup action. Never silently fall back to simulated success"; DEMO
 * "simulated provider responses, zero outbound delivery").
 *
 * - DEMO (process and workspace): no provider is contacted and no live tester is consulted. The
 *   answer is "Simulated, no provider contacted"; the stored status never changes; a stored row
 *   gets `lastCheckedAt`; the check is audited `integration.test` with `simulated: true`.
 * - LIVE, nothing stored, NOT_CONFIGURED or REVOKED: 422 INTEGRATION_NOT_CONFIGURED (the UI gates
 *   the button on configuration and links to the setup page), nothing written.
 * - LIVE with no tester registered for the kind (`live-adapters.ts`, T32-T36): "Verification
 *   required", status unchanged, audited FAILED. It never upgrades a status.
 * - LIVE with a tester: the provider check runs outside any transaction, then its outcome is stored
 *   (status, lastCheckedAt, redacted error, verifiedAt only on CONNECTED) and audited together.
 * Needs `integrations.manage`.
 */
import type { Prisma } from '@/generated/prisma/client';
import type { IntegrationKind, IntegrationStatus } from '@/lib/domain/enums';
import { catalogEntry, SIMULATED_TEST_LABEL } from '@/lib/domain/integrations';
import { DomainRuleError, NotFoundError } from '@/lib/errors';
import { redactText } from '@/lib/redact';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import type { JobStore } from '@/server/jobs/queue';
import { recordAudit, type AuditCtx, type AuditDb } from '@/server/services/audit/record';
import { armIntegrationSchedules } from './schedules';
import type { LiveTestOutcome, LiveTesters } from './types';

export type ConnectionTestResult = {
  outcome: 'SIMULATED' | 'VERIFICATION_REQUIRED' | 'TESTED';
  kind: IntegrationKind;
  /** The stored status after the test (NOT_CONFIGURED when nothing is stored). */
  status: IntegrationStatus;
  message: string;
  checkedAt: Date;
  errorCode: string | null;
};

export type ConnectionTestDeps = { testers: LiveTesters };

const NOT_TESTABLE: ReadonlySet<IntegrationStatus> = new Set(['NOT_CONFIGURED', 'REVOKED', 'SIMULATED']);
const MAX_ERROR_CHARS = 500;
const ARMING_STATUSES: ReadonlySet<IntegrationStatus> = new Set(['CONNECTED', 'DEGRADED']);

type PersistDb = AuditDb &
  JobStore & {
    integration: { updateMany(args: { where: { id: string; workspaceId: string }; data: Prisma.IntegrationUpdateManyMutationInput }): PromiseLike<{ count: number }> };
  };

/**
 * Stores one live test outcome (status, check time, redacted error, verifiedAt only on CONNECTED)
 * with its audit row, inside the caller's transaction. Used by Test connection and by the
 * `integration.health` job (T32). A CONNECTED or DEGRADED outcome arms the integration's scheduled
 * checks (schedules.ts): the manual test runs them now, a scheduled run arms the next bucket.
 */
export async function persistLiveTestOutcome(
  tx: PersistDb,
  ctx: AuditCtx & { mode: 'demo' | 'live' },
  row: { id: string; workspaceId: string; kind: IntegrationKind; status: IntegrationStatus },
  outcome: LiveTestOutcome,
  opts: { trigger: 'manual' | 'scheduled'; causationId?: string | null },
): Promise<{ errorCode: string | null; errorRedacted: string | null }> {
  const now = ctx.clock.now();
  const errorCode = outcome.status === 'CONNECTED' ? null : (outcome.errorCode ?? null);
  const errorRedacted = outcome.status === 'CONNECTED' || !outcome.errorMessage ? null : redactText(outcome.errorMessage).slice(0, MAX_ERROR_CHARS);
  await tx.integration.updateMany({
    where: { id: row.id, workspaceId: row.workspaceId },
    data: {
      status: outcome.status,
      lastCheckedAt: now,
      lastErrorCode: errorCode,
      lastErrorRedacted: errorRedacted,
      ...(outcome.status === 'CONNECTED' ? { verifiedAt: now } : {}),
    },
  });
  // A scheduled check is audited only when it changes the status (no hourly noise in the trail).
  if (opts.trigger === 'manual' || outcome.status !== row.status) {
    await recordAudit(tx, ctx, {
      action: 'integration.test',
      targetType: 'Integration',
      targetId: row.id,
      workspaceId: row.workspaceId,
      result: outcome.status === 'CONNECTED' ? 'SUCCESS' : 'FAILED',
      summary: { kind: row.kind, outcome: 'TESTED', status: outcome.status, previousStatus: row.status, errorCode, trigger: opts.trigger },
    });
  }
  if (ctx.mode === 'live' && ARMING_STATUSES.has(outcome.status)) {
    await armIntegrationSchedules(tx, ctx, row, { runNow: opts.trigger === 'manual', causationId: opts.causationId ?? null });
  }
  return { errorCode, errorRedacted };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function assertWorkspaceMode(ctx: AppCtx, workspaceId: string): Promise<void> {
  const ws = await ctx.db.workspace.findUnique({ where: { id: workspaceId }, select: { mode: true } });
  if (!ws || ws.mode !== (ctx.mode === 'demo' ? 'DEMO' : 'LIVE')) throw new NotFoundError({ message: 'workspace mode differs from the process mode' });
}

export async function testIntegrationConnection(ctx: AppCtx, input: { kind: IntegrationKind }, deps: ConnectionTestDeps): Promise<ConnectionTestResult> {
  requireCapability(ctx, 'integrations.manage');
  const workspaceId = requireWorkspace(ctx);
  await assertWorkspaceMode(ctx, workspaceId);
  const entry = catalogEntry(input.kind);
  const now = ctx.clock.now();
  const row = await ctx.db.integration.findFirst({ where: { kind: input.kind }, select: { id: true, kind: true, status: true, config: true } });

  if (ctx.mode === 'demo') {
    await withTx(ctx.db, async (tx) => {
      if (row) await tx.integration.update({ where: { id: row.id }, data: { lastCheckedAt: now } });
      await recordAudit(tx, ctx, {
        action: 'integration.test',
        targetType: row ? 'Integration' : 'IntegrationKind',
        targetId: row ? row.id : input.kind,
        simulated: true,
        summary: { kind: input.kind, outcome: 'SIMULATED', status: row?.status ?? 'NOT_CONFIGURED' },
      });
    });
    return { outcome: 'SIMULATED', kind: input.kind, status: row?.status ?? 'NOT_CONFIGURED', message: SIMULATED_TEST_LABEL, checkedAt: now, errorCode: null };
  }

  if (!row || NOT_TESTABLE.has(row.status)) {
    throw new DomainRuleError({
      code: 'INTEGRATION_NOT_CONFIGURED',
      userMessage: `${entry.label} is not configured. Open its setup to add the configuration and credentials first.`,
      safeDetails: { kind: input.kind, status: row?.status ?? 'NOT_CONFIGURED' },
    });
  }

  const tester = deps.testers[input.kind];
  if (!tester) {
    await withTx(ctx.db, async (tx) => {
      await recordAudit(tx, ctx, {
        action: 'integration.test',
        targetType: 'Integration',
        targetId: row.id,
        result: 'FAILED',
        summary: { kind: input.kind, outcome: 'VERIFICATION_REQUIRED', status: row.status },
      });
    });
    return {
      outcome: 'VERIFICATION_REQUIRED',
      kind: input.kind,
      status: row.status,
      message: `Verification required: ${entry.label} has not been verified with ${entry.provider}, so its status stays as it is.`,
      checkedAt: now,
      errorCode: null,
    };
  }

  // The provider call happens outside any transaction (plan §3).
  const outcome = await tester(ctx, { id: row.id, workspaceId, kind: row.kind, status: row.status, config: record(row.config) });
  const { errorCode, errorRedacted } = await withTx(ctx.db, (tx) => persistLiveTestOutcome(tx as unknown as PersistDb, ctx, { id: row.id, workspaceId, kind: row.kind, status: row.status }, outcome, { trigger: 'manual' }));
  const message =
    outcome.status === 'CONNECTED'
      ? `${entry.label} answered the connection test.`
      : `${entry.label} did not pass the connection test${errorRedacted ? `: ${errorRedacted}` : '.'}`;
  return { outcome: 'TESTED', kind: input.kind, status: outcome.status, message, checkedAt: now, errorCode };
}

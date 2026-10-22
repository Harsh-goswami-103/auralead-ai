/**
 * WhatsApp quality rating and messaging limit (T32; R26, plan §7 check 6, §13, ADR-30).
 *
 * `fetchWorkspaceQuality` reads the raw values (adapters/whatsapp/limits.ts) outside any
 * transaction; `applyQualityResult` stores them exactly as returned in `qualityRaw`,
 * `messagingLimitRaw` and `limitsCheckedAt` (a field the answer lacks is stored as null, shown as
 * "Unknown, last checked <time>"). There is no tier list or tier enum anywhere.
 *
 * Quality RED pauses the workspace's automation, not human sends: the shared eligibility function
 * reads `qualityRaw` and refuses AUTOMATED WhatsApp sends with QUALITY_PAUSED ("Automation paused
 * by WhatsApp quality rating"), while a send a person approved still passes (A15). Entering and
 * leaving RED are audited (`integration.quality.automation_paused` / `..._resumed`) with the raw
 * values, and the integration card says so. A failed check stores nothing and is audited FAILED;
 * the previous values and their check time stay.
 */
import type { AuditCtx, AuditDb } from '@/server/services/audit/record';
import { recordAudit } from '@/server/services/audit/record';
import { whatsAppGraphClient } from '@/server/adapters/registry';
import { fetchQualityLimits, isQualityRed, type QualityFetch } from '@/server/adapters/whatsapp/limits';
import type { AppCtx } from '@/server/auth/context';
import { loadIntegrationForUse } from './credentials';
import type { LiveAdapterDeps } from './live-testers';

export type QualityApplied = { qualityRaw: string | null; messagingLimitRaw: string | null; checkedAt: Date; automation: 'PAUSED' | 'RESUMED' | 'UNCHANGED' };

export async function fetchWorkspaceQuality(ctx: AppCtx, deps: LiveAdapterDeps): Promise<QualityFetch | { ok: false; httpStatus: null; errorCode: string; error: string }> {
  const use = await loadIntegrationForUse(ctx.db, 'WHATSAPP_CLOUD', deps.keyRing);
  const client = whatsAppGraphClient({ mode: ctx.mode, integration: use, graphVersion: deps.graphVersion, clock: ctx.clock, graph: deps.graph });
  if (!client.ok) return { ok: false, httpStatus: null, errorCode: client.code, error: client.reason };
  return fetchQualityLimits(client.value);
}

type QualityDb = AuditDb & {
  integration: {
    findFirst(args: { where: { id: string; workspaceId: string }; select: { qualityRaw: true } }): PromiseLike<{ qualityRaw: string | null } | null>;
    updateMany(args: { where: { id: string; workspaceId: string }; data: { qualityRaw: string | null; messagingLimitRaw: string | null; limitsCheckedAt: Date } }): PromiseLike<{ count: number }>;
  };
};

export async function applyQualityResult(tx: QualityDb, ctx: AuditCtx, integration: { id: string; workspaceId: string }, result: QualityFetch | { ok: false; httpStatus: null; errorCode: string; error: string }): Promise<QualityApplied | null> {
  const now = ctx.clock.now();
  if (!result.ok) {
    await recordAudit(tx, ctx, {
      action: 'integration.quality.check',
      targetType: 'Integration',
      targetId: integration.id,
      workspaceId: integration.workspaceId,
      result: 'FAILED',
      summary: { errorCode: result.errorCode, httpStatus: result.httpStatus },
    });
    return null;
  }
  const before = await tx.integration.findFirst({ where: { id: integration.id, workspaceId: integration.workspaceId }, select: { qualityRaw: true } });
  const previousQualityRaw = before?.qualityRaw ?? null;
  await tx.integration.updateMany({ where: { id: integration.id, workspaceId: integration.workspaceId }, data: { qualityRaw: result.values.qualityRaw, messagingLimitRaw: result.values.messagingLimitRaw, limitsCheckedAt: now } });
  const wasRed = isQualityRed(previousQualityRaw);
  const isRed = isQualityRed(result.values.qualityRaw);
  const automation = isRed && !wasRed ? 'PAUSED' : wasRed && !isRed ? 'RESUMED' : 'UNCHANGED';
  await recordAudit(tx, ctx, {
    action: automation === 'PAUSED' ? 'integration.quality.automation_paused' : automation === 'RESUMED' ? 'integration.quality.automation_resumed' : 'integration.quality.check',
    targetType: 'Integration',
    targetId: integration.id,
    workspaceId: integration.workspaceId,
    summary: {
      qualityRaw: result.values.qualityRaw,
      messagingLimitRaw: result.values.messagingLimitRaw,
      previousQualityRaw,
      ...(automation === 'PAUSED' ? { reason: 'Automated WhatsApp sends are paused while the quality rating is RED; sends a person approves still go out.' } : {}),
    },
  });
  return { qualityRaw: result.values.qualityRaw, messagingLimitRaw: result.values.messagingLimitRaw, checkedAt: now, automation };
}

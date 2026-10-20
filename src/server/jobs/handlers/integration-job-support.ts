/**
 * Shared bits of the scheduled integration jobs (T32: `integration.health`, `wa.qualityCheck`,
 * `wa.templateSync`): payload v1 `{ integrationId }`, workspace jobs, LIVE only. A run whose
 * integration is gone or no longer CONNECTED or DEGRADED does nothing and arms nothing, so the
 * chain ends (services/integrations/schedules.ts); provider failures are stored, not thrown, so a
 * transient error never breaks the chain.
 */
import { z } from 'zod';
import { getConfig } from '@/lib/config';
import type { IntegrationKind, IntegrationStatus } from '@/lib/domain/enums';
import type { AppCtx } from '@/server/auth/context';
import { liveAdapterDepsFromConfig, type LiveAdapterDeps } from '@/server/services/integrations/live-adapters';
import { armIntegrationSchedules } from '@/server/services/integrations/schedules';
import type { TxClient } from '../types';

export const integrationPayloadSchema = z.object({ integrationId: z.string().min(1).max(64) });

export const SCHEDULED_STATUSES: ReadonlySet<IntegrationStatus> = new Set(['CONNECTED', 'DEGRADED']);

export type IntegrationJobOptions = { mode?: () => 'demo' | 'live'; deps?: () => LiveAdapterDeps };

export function jobMode(options: IntegrationJobOptions): () => 'demo' | 'live' {
  return options.mode ?? (() => getConfig().mode);
}

export function jobDeps(options: IntegrationJobOptions): () => LiveAdapterDeps {
  return options.deps ?? liveAdapterDepsFromConfig;
}

export type ScheduledIntegration = { id: string; workspaceId: string; kind: IntegrationKind; status: IntegrationStatus; config: Record<string, unknown> };

export async function loadScheduledIntegration(ctx: AppCtx, integrationId: string): Promise<ScheduledIntegration | null> {
  const row = await ctx.db.integration.findFirst({ where: { id: integrationId }, select: { id: true, workspaceId: true, kind: true, status: true, config: true } });
  if (!row || !SCHEDULED_STATUSES.has(row.status)) return null;
  const config = typeof row.config === 'object' && row.config !== null && !Array.isArray(row.config) ? (row.config as Record<string, unknown>) : {};
  return { id: row.id, workspaceId: row.workspaceId, kind: row.kind, status: row.status, config };
}

/** Inside the settle: arms the next bucket of every check while the integration is still scheduled. */
export async function rearm(tx: TxClient, ctx: AppCtx, integration: { id: string; workspaceId: string; kind: IntegrationKind }, jobId: string): Promise<void> {
  const current = await tx.integration.findFirst({ where: { id: integration.id, workspaceId: integration.workspaceId }, select: { status: true } });
  if (!current || !SCHEDULED_STATUSES.has(current.status)) return;
  await armIntegrationSchedules(tx, ctx, integration, { runNow: false, causationId: jobId });
}

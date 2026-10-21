/**
 * Scheduled integration checks (T32; plan §4.3 "scheduled work is enqueued with a time-bucket
 * key, so duplicate schedulers never double-run").
 *
 * Three workspace jobs, payload v1 `{ integrationId }`, LIVE only:
 *  - `integration.health` (hourly): re-runs the live connection tester and stores its outcome, so a
 *    revoked token or a removed permission shows up without anyone pressing Test connection;
 *  - `wa.qualityCheck` (hourly, WhatsApp): stores quality rating and messaging limit raw (R26);
 *  - `wa.templateSync` (every 6 hours, WhatsApp): re-syncs templates, so a PAUSED or REJECTED
 *    template blocks queued sends (TEMPLATE_NOT_APPROVED) without a manual sync.
 * Keys are `<type>:<integrationId>:<UTC bucket start, to the hour>`. The worker has no periodic
 * scheduler (ADR-56), so the chain arms itself: a live connection test that ends CONNECTED or
 * DEGRADED arms all of the integration's checks (the current bucket now, plus the next one), and
 * every run arms the next bucket of every check while the integration stays CONNECTED or DEGRADED.
 * Any surviving chain re-arms the others; an integration that leaves those statuses ends them.
 */
import type { IntegrationKind } from '@/lib/domain/enums';
import type { Clock } from '@/lib/clock';
import { enqueueJob, type JobStore } from '@/server/jobs/queue';
import { CAMPAIGN_METRICS_EVERY_MS, CAMPAIGN_METRICS_SYNC_JOB } from '@/server/services/campaigns/constants';

export const INTEGRATION_HEALTH_JOB = 'integration.health';
export const WA_QUALITY_CHECK_JOB = 'wa.qualityCheck';
export const WA_TEMPLATE_SYNC_JOB = 'wa.templateSync';
export const INTEGRATION_SCHEDULE_PAYLOAD_VERSION = 1;

const HOUR_MS = 60 * 60 * 1000;
export const SCHEDULE_EVERY_MS: Readonly<Record<string, number>> = {
  [INTEGRATION_HEALTH_JOB]: HOUR_MS,
  [WA_QUALITY_CHECK_JOB]: HOUR_MS,
  [WA_TEMPLATE_SYNC_JOB]: 6 * HOUR_MS,
  // T35: Meta campaign metrics (ad account currency, insights) every 6 hours.
  [CAMPAIGN_METRICS_SYNC_JOB]: CAMPAIGN_METRICS_EVERY_MS,
};

/** Kinds with a live connection tester (live-testers.ts); T33-T36 append theirs. */
export const HEALTH_CHECKED_KINDS: ReadonlySet<IntegrationKind> = new Set(['WHATSAPP_CLOUD', 'AI_ANTHROPIC', 'AI_OPENAI', 'META_ADS']);

export function scheduledJobTypes(kind: IntegrationKind): string[] {
  const types: string[] = [];
  if (HEALTH_CHECKED_KINDS.has(kind)) types.push(INTEGRATION_HEALTH_JOB);
  if (kind === 'WHATSAPP_CLOUD') types.push(WA_QUALITY_CHECK_JOB, WA_TEMPLATE_SYNC_JOB);
  if (kind === 'META_ADS') types.push(CAMPAIGN_METRICS_SYNC_JOB);
  return types;
}

export function bucketStart(at: Date, everyMs: number): Date {
  return new Date(Math.floor(at.getTime() / everyMs) * everyMs);
}

export function scheduleKey(type: string, integrationId: string, bucket: Date): string {
  return `${type}:${integrationId}:${bucket.toISOString().slice(0, 13)}`;
}

/**
 * Enqueues the integration's checks inside the caller's transaction: the next bucket of each, and
 * with `runNow` also the current bucket at once. Idempotent by key.
 */
export async function armIntegrationSchedules(
  db: JobStore,
  ctx: { clock: Clock; correlationId: string },
  integration: { id: string; workspaceId: string; kind: IntegrationKind },
  opts: { runNow: boolean; causationId?: string | null },
): Promise<void> {
  const now = ctx.clock.now();
  for (const type of scheduledJobTypes(integration.kind)) {
    const every = SCHEDULE_EVERY_MS[type]!;
    const current = bucketStart(now, every);
    const next = new Date(current.getTime() + every);
    const runs: Array<{ bucket: Date; runAt: Date }> = [{ bucket: next, runAt: next }];
    // A manual test just checked the connection, so only the other checks run at once.
    if (opts.runNow && type !== INTEGRATION_HEALTH_JOB) runs.unshift({ bucket: current, runAt: now });
    for (const run of runs) {
      await enqueueJob(db, ctx.clock, {
        type,
        payload: { integrationId: integration.id },
        payloadVersion: INTEGRATION_SCHEDULE_PAYLOAD_VERSION,
        workspaceId: integration.workspaceId,
        idempotencyKey: scheduleKey(type, integration.id, run.bucket),
        correlationId: ctx.correlationId,
        causationId: opts.causationId ?? null,
        runAt: run.runAt,
        kind: 'fetch',
        priority: 5,
      });
    }
  }
}

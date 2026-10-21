/**
 * `meta.lead.fetch` (T35; 02-errors G-ING-5, plan §4.3): turns one persisted leadgen notification
 * (`meta:{page}:{leadgen}`, ids only) into a lead through the same `ingestBatch` every source uses.
 *
 * 1. Load the event in the job's workspace. PROCESSED: a replay, nothing runs again. FAILED: runs
 *    again only when its failure code can be fixed by a person (a new token, a permission, the
 *    form's mapping), for example after an operator retries the job.
 * 2. Decrypt the processing payload (AAD = event id) and find the form's MetaFormMapping. Without a
 *    mapping the event is FAILED `MAPPING_NOT_FOUND` before Meta is called (no quota spent); once
 *    the form is mapped, a backfill from that form brings the lead in.
 * 3. Outside any transaction, GET /<leadgen id> through the Graph adapter with the saved token
 *    (META_GRAPH_VERSION). The answer is mapped with the form's field and consent mapping (P1) by
 *    `metaToIngest` and ingested by `ingestBatch` (idempotent per leadgen id: a redelivery or a
 *    replay never creates a second lead).
 * 4. Errors: a rejected token (190) sets the integration to "Verification required" and the job
 *    is DEAD, not retried; a missing permission names it (leads_retrieval) and is DEAD; throttling,
 *    5xx and no answer retry with backoff min(30 s * 2^(n-1), 1 h) or Retry-After; a lead Meta does
 *    not return (deleted, or older than its retention) is FAILED `LEAD_UNRETRIEVABLE`. The event
 *    keeps its processing payload (30 days) in every failure case.
 */
import { z } from 'zod';
import type { Prisma, WebhookEvent } from '@/generated/prisma/client';
import { AppError } from '@/lib/errors';
import { metaLeadEventSchema, metaLeadgenChangeSchema, type MetaLeadgenChange } from '@/lib/schemas/webhooks';
import { classifyMetaFailure, parseGraphLead, type MetaFailure } from '@/server/adapters/meta/graph';
import { CHECKABLE_STATUSES, metaLeadsClient } from '@/server/adapters/registry';
import { getJobContext, type AppCtx } from '@/server/auth/context';
import { LeaseLostError } from '@/server/db/fence';
import type { FinalTx, JobHandlerContext, JobResult, TxClient } from '@/server/jobs/types';
import type { KeyRing } from '@/server/security/secrets';
import { recordAudit } from '@/server/services/audit/record';
import { loadIntegrationForUse } from '@/server/services/integrations/credentials';
import type { LiveAdapterDeps } from '@/server/services/integrations/live-testers';
import { ingestBatch, type IngestBatchResult } from '@/server/services/leads/ingest';
import { decryptProcessingPayload, PROCESSED_RETENTION_MS, purgeDueAt, schedulePurge, type WebhookEventResult } from '@/server/services/webhooks/events';
import { metaToIngest, PayloadMappingError } from '@/server/services/webhooks/payload-mapping';
import { ingestResultOf, webhookJobPayloadSchema } from '@/server/services/webhooks/process-ingest';
import { metaBackoffMs } from './constants';
import { recordMetaAccessProblem } from './integration-problems';

export type MetaLeadDeps = LiveAdapterDeps & {
  keyRing: KeyRing | null;
  /** SUPPRESSION_PEPPER, for consent contact keys (C17). */
  contactKeyPepper: string;
  mode: 'demo' | 'live';
};

/** Failure codes a person can fix; an event FAILED with one of them is fetched again when its job runs again. */
export const RECOVERABLE_FETCH_CODES: ReadonlySet<string> = new Set([
  'PROVIDER_AUTH',
  'PERMISSION_MISSING',
  'CREDENTIAL_UNREADABLE',
  'INTEGRATION_NOT_CONFIGURED',
  'MAPPING_NOT_FOUND',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_UNREACHABLE',
]);

function dead(reason: string, error: string, finalTx?: FinalTx): JobResult {
  return { outcome: 'dead', reason, errorCode: reason, error, ...(finalTx ? { finalTx } : {}) };
}

function isRetryable(error: unknown): boolean {
  if (error instanceof AppError) return error.retryable;
  return typeof error === 'object' && error !== null && ((error as { code?: unknown }).code === 'DB_BUSY' || (error as { code?: unknown }).code === 'LEASE_LOST');
}

function failedCode(event: Pick<WebhookEvent, 'result'>): string | null {
  const r = event.result as WebhookEventResult | null;
  return r?.kind === 'failed' ? r.code : null;
}

type EventCtx = { job: JobHandlerContext; ctx: AppCtx; event: WebhookEvent; workspaceId: string };

/** Marks the event FAILED with a code inside the settle (RECEIVED, or FAILED with an earlier code) and audits it. */
async function failEventTx(tx: TxClient, e: EventCtx, code: string, message: string): Promise<void> {
  const result: WebhookEventResult = { kind: 'failed', code, message: message.slice(0, 500) };
  const updated = await tx.webhookEvent.updateMany({ where: { id: e.event.id, workspaceId: e.workspaceId, status: { in: ['RECEIVED', 'FAILED'] } }, data: { status: 'FAILED', result: result as Prisma.InputJsonValue } });
  if (updated.count !== 1) return;
  await schedulePurge(tx, e.job.clock, { eventId: e.event.id, workspaceId: e.workspaceId, runAt: purgeDueAt({ ...e.event, status: 'FAILED' }), correlationId: e.job.correlationId, causationId: e.job.job.id });
  await recordAudit(tx, e.ctx, { action: 'webhook.process', targetType: 'WebhookEvent', targetId: e.event.id, result: 'FAILED', simulated: e.event.simulated, summary: { provider: 'META_ADS', jobId: e.job.job.id, code } });
}

const handled = (e: EventCtx, code: string, message: string): JobResult => ({ outcome: 'succeeded', finalTx: (tx) => failEventTx(tx, e, code, message) });

/** A fetch failure as the job's result. */
function fetchFailure(e: EventCtx, f: MetaFailure, integration: { id: string; workspaceId: string }): JobResult {
  switch (f.code) {
    case 'PROVIDER_AUTH':
    case 'PERMISSION_MISSING':
      // Not retried: nothing changes until a person enters a new token or grants the permission.
      return dead(f.code, f.message, async (tx) => {
        await recordMetaAccessProblem(tx, e.ctx, integration, { code: f.code as 'PROVIDER_AUTH' | 'PERMISSION_MISSING', message: f.message, permission: f.permission }, 'meta.lead.fetch');
        await failEventTx(tx, e, f.code, f.message);
      });
    case 'PROVIDER_RATE_LIMITED':
    case 'PROVIDER_UNAVAILABLE':
    case 'PROVIDER_UNREACHABLE': {
      const last = e.job.job.attempts >= e.job.job.maxAttempts;
      return {
        outcome: 'retry',
        errorCode: f.code,
        error: f.message,
        retryAfterMs: metaBackoffMs(e.job.job.attempts, f.retryAfterMs),
        ...(last ? { finalTx: (tx: TxClient) => failEventTx(tx, e, f.code, f.message) } : {}),
      };
    }
    case 'NOT_FOUND':
      return handled(e, 'LEAD_UNRETRIEVABLE', `Meta did not return this lead (deleted, older than its retention, or not readable with this token). ${f.message}`);
    case 'PROVIDER_REJECTED':
      return handled(e, 'PROVIDER_REJECTED', f.message);
  }
}

export async function processMetaLeadFetch(job: JobHandlerContext, deps: MetaLeadDeps): Promise<JobResult> {
  const payload = webhookJobPayloadSchema.safeParse(job.job.payload);
  if (!payload.success) return dead('INVALID_PAYLOAD', 'meta.lead.fetch payload is not { webhookEventId }');
  const workspaceId = job.job.workspaceId;
  if (workspaceId === null) return dead('INVALID_PAYLOAD', 'meta.lead.fetch needs a workspace job');
  const eventId = payload.data.webhookEventId;

  const event = await job.db.webhookEvent.findFirst({ where: { id: eventId, workspaceId, provider: 'META_ADS' } });
  if (!event) return dead('EVENT_NOT_FOUND', `no Meta webhook event ${eventId} in the job's workspace`);
  if (event.status === 'PROCESSED') return { outcome: 'succeeded' };
  if (event.status === 'FAILED' && !RECOVERABLE_FETCH_CODES.has(failedCode(event) ?? '')) return { outcome: 'succeeded' };

  const ctx = getJobContext({ id: job.job.id, workspaceId, correlationId: job.correlationId }, { prisma: job.db, mode: deps.mode, clock: job.clock });
  const e: EventCtx = { job, ctx, event, workspaceId };
  if (deps.mode !== 'live') return handled(e, 'DEMO_NO_PROVIDER', 'DEMO never contacts Meta; simulated leads carry their answers in the simulation itself.');
  if (event.processingPayload === null) return handled(e, 'PAYLOAD_PURGED', 'the processing payload was purged before processing');
  if (event.integrationId === null) return handled(e, 'INTEGRATION_MISSING', 'a Meta event must be routed to its integration');
  if (!deps.keyRing) throw new Error('CREDENTIALS_KEYRING is not configured: Meta events cannot be decrypted');

  let change: MetaLeadgenChange;
  try {
    const parsed = metaLeadgenChangeSchema.safeParse(decryptProcessingPayload(deps.keyRing, event));
    if (!parsed.success) return handled(e, 'INVALID_PAYLOAD', 'the stored leadgen notification does not match its schema');
    change = parsed.data;
  } catch (error) {
    if (error instanceof Error && (error.name === 'SecretDecryptError' || error instanceof SyntaxError)) return handled(e, 'PAYLOAD_UNREADABLE', 'the processing payload could not be read with the configured key ring');
    throw error;
  }

  const mapping = await job.db.metaFormMapping.findFirst({ where: { workspaceId, integrationId: event.integrationId, formId: change.form_id } });
  if (!mapping) return handled(e, 'MAPPING_NOT_FOUND', `Instant Form ${change.form_id} has no field mapping yet; map it on the Meta page, then backfill from that form.`);

  const use = await loadIntegrationForUse(ctx.db, 'META_ADS', deps.keyRing);
  if (!use || use.id !== event.integrationId) return handled(e, 'INTEGRATION_NOT_CONFIGURED', 'the Meta Lead Ads integration this event was routed to is no longer stored');
  const integration = { id: use.id, workspaceId };
  const client = metaLeadsClient({ mode: deps.mode, integration: use, graphVersion: deps.graphVersion, marketingVersion: deps.marketingVersion ?? null, clock: job.clock, usable: CHECKABLE_STATUSES, ...(deps.graph ? { graph: deps.graph } : {}) });
  if (!client.ok) {
    if (client.code === 'CREDENTIAL_UNREADABLE') {
      return dead('CREDENTIAL_UNREADABLE', client.reason, async (tx) => {
        await recordMetaAccessProblem(tx, ctx, integration, { code: 'CREDENTIAL_UNREADABLE', message: client.reason, field: client.field ?? null }, 'meta.lead.fetch');
        await failEventTx(tx, e, 'CREDENTIAL_UNREADABLE', 'Credential unreadable, re-enter');
      });
    }
    return dead('INTEGRATION_NOT_CONFIGURED', client.reason, (tx) => failEventTx(tx, e, 'INTEGRATION_NOT_CONFIGURED', `The lead cannot be fetched: ${client.reason}.`));
  }

  const res = await client.value.getLead(change.leadgen_id);
  if (job.signal.aborted) throw new LeaseLostError(job.job.id);
  if (!res.ok) return fetchFailure(e, classifyMetaFailure(res, 'leads_retrieval'), integration);

  const lead = parseGraphLead(res.data);
  const leadEvent = metaLeadEventSchema.safeParse({ change, lead });
  if (!lead || !leadEvent.success) return handled(e, 'INVALID_LEAD', 'Meta answered without the documented lead fields (id, created_time, field_data)');

  let ingested: IngestBatchResult;
  try {
    const input = metaToIngest(leadEvent.data, mapping, { externalBatchId: event.externalKey, simulated: false });
    // Lease check before any domain write (E5); the attempt counter is the inspector's retry count.
    await job.fencedTx((tx) => tx.webhookEvent.update({ where: { id: eventId }, data: { attempts: { increment: 1 } } }));
    ingested = await ingestBatch(ctx, input, { contactKeyPepper: deps.contactKeyPepper });
  } catch (error) {
    if (error instanceof PayloadMappingError) return handled(e, error.code, error.message);
    if (isRetryable(error)) throw error;
    if (error instanceof AppError && error.status < 500) return handled(e, error.code, error.message);
    if (error instanceof z.ZodError) return handled(e, 'INVALID_PAYLOAD', 'the mapped lead does not satisfy the ingestion schema');
    throw error;
  }

  const result = ingestResultOf(ingested);
  return {
    outcome: 'succeeded',
    finalTx: async (tx) => {
      const now = job.clock.now();
      const updated = await tx.webhookEvent.updateMany({
        where: { id: eventId, workspaceId, status: { in: ['RECEIVED', 'FAILED'] } },
        data: { status: 'PROCESSED', processedAt: now, result: result as Prisma.InputJsonValue },
      });
      if (updated.count !== 1) return;
      await schedulePurge(tx, job.clock, { eventId, workspaceId, runAt: new Date(now.getTime() + PROCESSED_RETENTION_MS), correlationId: job.correlationId, causationId: job.job.id });
      await recordAudit(tx, ctx, {
        action: 'webhook.process',
        targetType: 'WebhookEvent',
        targetId: eventId,
        simulated: false,
        summary: { provider: 'META_ADS', jobId: job.job.id, importBatchId: ingested.batchId, batchStatus: ingested.status, replayed: ingested.replayed, ...ingested.counts },
      });
    },
  };
}

/**
 * `ingest.process` (T11; E1/ADR-35, E9/ADR-43): turns one persisted lead-source WebhookEvent into
 * leads through the same `ingestBatch` service every source uses.
 *
 * 1. Load the event in the job's workspace. PROCESSED or FAILED: a replay, nothing runs again.
 * 2. Decrypt `processingPayload` with AAD = the event id (never the redacted view) and map it with
 *    the source's stored mapping (SheetMapping by version, MetaFormMapping by form, fixed for the
 *    extension). A payload that cannot be read or mapped marks the event FAILED with a code; the
 *    job is handled, not retried, and the payload is kept for 30 days for an operator.
 * 3. A fenced write (attempt counter) proves the lease is still held, then `ingestBatch` runs.
 *    Ingestion is idempotent per batch and per record (ImportBatch and LeadSourceRecord are
 *    UNIQUE), so a worker that dies mid-batch and is reclaimed resumes without duplicates.
 * 4. The settle transaction marks the event PROCESSED with the per-record result (ids, statuses,
 *    codes; no contact data), schedules `webhook.purge` at processedAt + 7 days and audits.
 * Retryable errors (busy DB, transient provider) retry the job with backoff; other domain errors
 * (validation, conflict) mark the event FAILED with the error code.
 */
import { z } from 'zod';
import type { Prisma, WebhookEvent } from '@/generated/prisma/client';
import { AppError } from '@/lib/errors';
import { getJobContext } from '@/server/auth/context';
import type { JobHandlerContext, JobResult, TxClient } from '@/server/jobs/types';
import type { KeyRing } from '@/server/security/secrets';
import { recordAudit } from '@/server/services/audit/record';
import { ingestBatch, type IngestBatchResult } from '@/server/services/leads/ingest';
import type { IngestBatchInput } from '@/lib/schemas/ingest';
import {
  decryptProcessingPayload,
  PROCESSED_RETENTION_MS,
  purgeDueAt,
  schedulePurge,
  type WebhookEventResult,
} from './events';
import { extensionIntakeOf, extensionToIngest, metaToIngest, parseExtensionBatch, parseMetaLeadEvent, parseSheetsPush, PayloadMappingError, sheetsToIngest, withIntakeRejections } from './payload-mapping';

export type IngestProcessDeps = {
  keyRing: KeyRing;
  /** SUPPRESSION_PEPPER, for consent contact keys (C17). */
  contactKeyPepper: string;
  mode: 'demo' | 'live';
};

export const webhookJobPayloadSchema = z.object({ webhookEventId: z.string().min(1).max(64) });

function dead(reason: string, error: string): JobResult {
  return { outcome: 'dead', reason, errorCode: reason, error };
}

function isRetryable(error: unknown): boolean {
  if (error instanceof AppError) return error.retryable;
  return typeof error === 'object' && error !== null && ((error as { code?: unknown }).code === 'DB_BUSY' || (error as { code?: unknown }).code === 'LEASE_LOST');
}

/** Loads the mapping for the event's source and maps the decrypted body onto the ingestion input. */
async function toIngestInput(job: JobHandlerContext, event: WebhookEvent, body: unknown): Promise<IngestBatchInput> {
  const workspaceId = event.workspaceId!;
  switch (event.provider) {
    case 'GOOGLE_SHEETS': {
      const push = parseSheetsPush(body);
      if (event.integrationId === null) throw new PayloadMappingError('INTEGRATION_MISSING', 'a Sheets event must be routed to its integration');
      const mapping = await job.db.sheetMapping.findFirst({ where: { workspaceId, integrationId: event.integrationId, version: push.mappingVersion } });
      if (!mapping) throw new PayloadMappingError('MAPPING_NOT_FOUND', `no Sheets mapping v${push.mappingVersion} for this integration`);
      return sheetsToIngest(push, mapping, { externalBatchId: event.externalKey, simulated: event.simulated });
    }
    case 'META_ADS': {
      const lead = parseMetaLeadEvent(body);
      if (event.integrationId === null) throw new PayloadMappingError('INTEGRATION_MISSING', 'a Meta event must be routed to its integration');
      const mapping = await job.db.metaFormMapping.findFirst({ where: { workspaceId, integrationId: event.integrationId, formId: lead.change.form_id } });
      if (!mapping) throw new PayloadMappingError('MAPPING_NOT_FOUND', 'no mapping for this Meta lead form');
      return metaToIngest(lead, mapping, { externalBatchId: event.externalKey, simulated: event.simulated });
    }
    case 'GMAPS_EXTENSION':
      // A live batch carries the server-written intake block (T36): the token that sent it.
      return extensionToIngest(parseExtensionBatch(body), { simulated: event.simulated, extensionTokenId: extensionIntakeOf(body)?.extensionTokenId ?? null });
    default:
      throw new PayloadMappingError('UNSUPPORTED_PROVIDER', `ingest.process does not handle ${event.provider} events`);
  }
}

export function ingestResultOf(result: IngestBatchResult): WebhookEventResult {
  return {
    kind: 'ingest',
    importBatchId: result.batchId,
    batchStatus: result.status,
    counts: result.counts,
    records: result.records.map((r) => ({
      externalId: r.externalId,
      status: r.status,
      reasonCode: r.reasonCode,
      sourceRecordId: r.sourceRecordId,
      leadId: r.leadId,
      mergeReviewId: r.mergeReviewId,
      consent: r.consent.outcome === 'CREATED' ? 'CREATED' : r.consent.reason,
    })),
  };
}

export async function processIngestEvent(job: JobHandlerContext, deps: IngestProcessDeps): Promise<JobResult> {
  const payload = webhookJobPayloadSchema.safeParse(job.job.payload);
  if (!payload.success) return dead('INVALID_PAYLOAD', 'ingest.process payload is not { webhookEventId }');
  const workspaceId = job.job.workspaceId;
  if (workspaceId === null) return dead('INVALID_PAYLOAD', 'ingest.process needs a workspace job');
  const eventId = payload.data.webhookEventId;

  const event = await job.db.webhookEvent.findFirst({ where: { id: eventId, workspaceId } });
  if (!event) return dead('EVENT_NOT_FOUND', `no webhook event ${eventId} in the job's workspace`);
  if (event.status === 'PROCESSED' || event.status === 'FAILED') return { outcome: 'succeeded' };

  const ctx = getJobContext({ id: job.job.id, workspaceId, correlationId: job.correlationId }, { prisma: job.db, mode: deps.mode, clock: job.clock });
  const audit = (tx: TxClient, result: 'SUCCESS' | 'FAILED', summary: Record<string, unknown>) =>
    recordAudit(tx, ctx, { action: 'webhook.process', targetType: 'WebhookEvent', targetId: eventId, result, simulated: event.simulated, summary: { provider: event.provider, jobId: job.job.id, ...summary } });

  const failEvent = (code: string, message: string): JobResult => ({
    outcome: 'succeeded',
    finalTx: async (tx) => {
      const result: WebhookEventResult = { kind: 'failed', code, message };
      const updated = await tx.webhookEvent.updateMany({ where: { id: eventId, status: 'RECEIVED' }, data: { status: 'FAILED', result: result as Prisma.InputJsonValue } });
      if (updated.count !== 1) return;
      await schedulePurge(tx, job.clock, { eventId, workspaceId, runAt: purgeDueAt({ ...event, status: 'FAILED' }), correlationId: job.correlationId, causationId: job.job.id });
      await audit(tx, 'FAILED', { code });
    },
  });

  if (event.processingPayload === null) return failEvent('PAYLOAD_PURGED', 'the processing payload was purged before processing');

  let input: IngestBatchInput;
  let body: unknown = null;
  try {
    body = decryptProcessingPayload(deps.keyRing, event);
    input = await toIngestInput(job, event, body);
  } catch (error) {
    if (error instanceof PayloadMappingError) return failEvent(error.code, error.message);
    if (error instanceof Error && error.name === 'SecretDecryptError') return failEvent('PAYLOAD_UNREADABLE', 'the processing payload could not be decrypted with the configured key ring');
    if (error instanceof SyntaxError) return failEvent('PAYLOAD_UNREADABLE', 'the processing payload is not valid JSON');
    throw error;
  }

  // Lease check before any domain write (E5); the attempt counter is the inspector's retry count.
  await job.fencedTx((tx) => tx.webhookEvent.update({ where: { id: eventId }, data: { attempts: { increment: 1 } } }));

  let ingested: IngestBatchResult;
  try {
    ingested = await ingestBatch(ctx, input, { contactKeyPepper: deps.contactKeyPepper });
  } catch (error) {
    if (isRetryable(error)) throw error;
    if (error instanceof AppError && error.status < 500) return failEvent(error.code, error.message);
    if (error instanceof z.ZodError) return failEvent('INVALID_PAYLOAD', 'the mapped records do not satisfy the ingestion schema');
    throw error;
  }

  // Records the extension receiver rejected at intake (T36) are reported next to the ingested ones.
  const result = event.provider === 'GMAPS_EXTENSION' ? withIntakeRejections(ingestResultOf(ingested), extensionIntakeOf(body)?.rejected ?? []) : ingestResultOf(ingested);
  return {
    outcome: 'succeeded',
    finalTx: async (tx) => {
      const now = job.clock.now();
      const updated = await tx.webhookEvent.updateMany({
        where: { id: eventId, status: 'RECEIVED' },
        data: { status: 'PROCESSED', processedAt: now, result: result as Prisma.InputJsonValue },
      });
      if (updated.count !== 1) return;
      await schedulePurge(tx, job.clock, { eventId, workspaceId, runAt: new Date(now.getTime() + PROCESSED_RETENTION_MS), correlationId: job.correlationId, causationId: job.job.id });
      await audit(tx, 'SUCCESS', { importBatchId: ingested.batchId, batchStatus: ingested.status, replayed: ingested.replayed, ...ingested.counts });
    },
  };
}

/**
 * Lead ingestion (R12, R13, R22, P1, O5, E9). Every source (Sheets, Meta, Maps extension, demo
 * simulators, manual import) calls `ingestBatch(ctx, input, deps)` with a workspace-scoped context.
 *
 * Batch: idempotent on (workspace, source, externalBatchId) with a canonical content hash. A
 * finished batch replays its stored per-record results without writing; the same id with
 * different content is a 409 `BATCH_CONTENT_MISMATCH`; an unfinished one (a crash mid-batch)
 * resumes, because every record is itself idempotent.
 *
 * Record, each in its own short busy-retrying transaction (write lock taken first, so concurrent
 * ingestion from the web and worker processes serializes and dedupe sees committed keys):
 * 1. Seen before (same workspace, source and externalId): its stored result, no write.
 * 2. Normalize; on failure a REJECTED LeadSourceRecord with the reason code.
 * 3. Match contact keys: none -> new Lead pinned to the active PipelineConfigVersion (O5), contact
 *    keys, ACCEPTED source record, PipelineExecution, exactly one `pipeline.advance` job and the
 *    audit row; one -> DUPLICATE linked to that lead, which is not modified; several -> REVIEW with
 *    an OPEN MergeReview and no write to the candidates.
 * 4. Consent capture from the mapping (P1) for ACCEPTED and DUPLICATE records.
 * A new lead keeps the record's PIN code and website status (NOT_LISTED when the source says the
 * listing has no website, ADR-119). A GOOGLE_PLACES lead also keeps its place ID (`Lead.placeId`,
 * from `providerId` or `fields.placeId`, also its PROVIDER key) and gets `placesContentExpiresAt`
 * = now + 30 days (ADR-118 (d)). A duplicate never modifies the existing lead.
 * Ingestion never enqueues scoring, enrichment or drafting directly (E9): the pipeline executor
 * runs those stages.
 */
import { createHash } from 'node:crypto';
import { Prisma, type SourceRecordStatus } from '@/generated/prisma/client';
import type { Ctx } from '@/lib/domain/context';
import { IdempotencyConflictError, ValidationError } from '@/lib/errors';
import { redact } from '@/lib/redact';
import { ingestBatchSchema, type IngestBatchInput, type IngestBatchParsed, type IngestRecord } from '@/lib/schemas/ingest';
import { requireWorkspace } from '@/server/auth/guards';
import type { ScopedDb } from '@/server/db/scoped';
import { withTx } from '@/server/db/tx';
import { recordAudit } from '@/server/services/audit/record';
import { captureIngestionConsent, findCapturedConsent, noticeTextHash, type ConsentCaptureResult } from '@/server/services/messaging/consent';
import { enqueuePipelineAdvance } from '@/server/services/pipeline/executor';
import { contactKeysFor, findMatchingLeadIds } from './dedupe';
import { openMergeReview } from './merge-review';
import { normalizeLeadFields } from './normalize';

export type { IngestBatchInput } from '@/lib/schemas/ingest';

/**
 * ADR-118 (d): the Places-sourced fields of a lead imported from Google Places (phone, rating,
 * review count, address, PIN code, category) carry `Lead.placesContentExpiresAt` = ingestion time
 * + 30 days; `leads.placesExpire` (slice F1) nulls them then unless the contact was confirmed.
 */
export const PLACES_CONTENT_TTL_DAYS = 30;
export const PLACES_CONTENT_TTL_MS = PLACES_CONTENT_TTL_DAYS * 86_400_000;

export type IngestDeps = {
  /** SUPPRESSION_PEPPER: consent records carry the same contact key as suppressions (C17). */
  contactKeyPepper: string;
};

export type IngestCtx = Ctx<ScopedDb>;

export type IngestCounts = { received: number; accepted: number; duplicate: number; review: number; rejected: number };

export type IngestRecordResult = {
  externalId: string;
  status: SourceRecordStatus;
  reasonCode: string | null;
  sourceRecordId: string | null;
  leadId: string | null;
  mergeReviewId: string | null;
  consent: ConsentCaptureResult;
  /** True when this record had already been processed (no write this time). */
  replayed: boolean;
};

export type IngestBatchResult = {
  batchId: string;
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED';
  counts: IngestCounts;
  /** True when the whole batch had already finished: stored results, nothing written. */
  replayed: boolean;
  records: IngestRecordResult[];
};

type Tx = Prisma.TransactionClient;

const UNIQUE_RETRIES = 3;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function ingestBodyHash(parsed: IngestBatchParsed): string {
  return createHash('sha256').update(JSON.stringify(canonical(parsed)), 'utf8').digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function tally(results: readonly IngestRecordResult[]): IngestCounts {
  const counts: IngestCounts = { received: results.length, accepted: 0, duplicate: 0, review: 0, rejected: 0 };
  for (const r of results) {
    if (r.status === 'ACCEPTED') counts.accepted += 1;
    else if (r.status === 'DUPLICATE') counts.duplicate += 1;
    else if (r.status === 'REVIEW') counts.review += 1;
    else counts.rejected += 1;
  }
  return counts;
}

function batchStatus(counts: IngestCounts): IngestBatchResult['status'] {
  if (counts.rejected === counts.received) return 'FAILED';
  return counts.rejected > 0 ? 'PARTIAL' : 'COMPLETED';
}

function parseInput(input: IngestBatchInput): IngestBatchParsed {
  const parsed = ingestBatchSchema.parse(input);
  const consent = parsed.mapping?.consent;
  if (consent?.noticeTextHash !== undefined && consent.noticeTextHash !== noticeTextHash(consent.noticeText)) {
    throw new ValidationError({
      code: 'CONSENT_NOTICE_HASH_MISMATCH',
      message: 'consent mapping noticeTextHash does not match sha256(noticeText)',
      userMessage: 'The consent notice text changed since the mapping was saved. Save the mapping again.',
    });
  }
  return parsed;
}

const NONE_FOR_STATUS: Partial<Record<SourceRecordStatus, ConsentCaptureResult>> = {
  REVIEW: { outcome: 'NONE', reason: 'PENDING_REVIEW' },
  REJECTED: { outcome: 'NONE', reason: 'REJECTED' },
  UNRETRIEVABLE: { outcome: 'NONE', reason: 'REJECTED' },
};

export async function ingestBatch(ctx: IngestCtx, input: IngestBatchInput, deps: IngestDeps): Promise<IngestBatchResult> {
  const workspaceId = requireWorkspace(ctx);
  const parsed = parseInput(input);
  const bodyHash = ingestBodyHash(parsed);
  const simulated = parsed.simulated ?? false;
  const auditCtx = { ...ctx, workspaceId };

  const batch = await withTx(ctx.db, async (scoped) => {
    const tx = scoped as unknown as Tx;
    const existing = await tx.importBatch.findFirst({ where: { workspaceId, source: parsed.source, externalBatchId: parsed.externalBatchId } });
    if (existing) {
      if (existing.bodyHash !== bodyHash) {
        throw new IdempotencyConflictError({
          code: 'BATCH_CONTENT_MISMATCH',
          message: `batch ${parsed.externalBatchId} was already received with different content`,
          userMessage: 'This batch id was already used with different records. Send it with a new batch id.',
        });
      }
      return existing;
    }
    return tx.importBatch.create({
      data: {
        workspaceId,
        source: parsed.source,
        externalBatchId: parsed.externalBatchId,
        extensionTokenId: parsed.extensionTokenId ?? null,
        bodyHash,
        status: 'PROCESSING',
        counts: { received: parsed.records.length, accepted: 0, duplicate: 0, review: 0, rejected: 0 },
        simulated,
        createdAt: ctx.clock.now(),
      },
    });
  });
  const finished = batch.status === 'COMPLETED' || batch.status === 'PARTIAL' || batch.status === 'FAILED';

  const results: IngestRecordResult[] = [];
  const seen = new Set<string>();
  for (const record of parsed.records) {
    if (seen.has(record.externalId)) {
      results.push({
        externalId: record.externalId,
        status: 'REJECTED',
        reasonCode: 'DUPLICATE_IN_BATCH',
        sourceRecordId: null,
        leadId: null,
        mergeReviewId: null,
        consent: { outcome: 'NONE', reason: 'REJECTED' },
        replayed: finished,
      });
      continue;
    }
    seen.add(record.externalId);
    for (let attempt = 1; ; attempt += 1) {
      try {
        results.push(
          await withTx(ctx.db, (scoped) =>
            processRecord(scoped as unknown as Tx, auditCtx, { parsed, record, batchId: batch.id, simulated, readOnly: finished }, deps),
          ),
        );
        break;
      } catch (error) {
        // Lost a race on a contact key or source record: the next attempt sees the committed row.
        if (!isUniqueViolation(error) || attempt >= UNIQUE_RETRIES) throw error;
      }
    }
  }

  const counts = tally(results);
  const status = batchStatus(counts);
  if (!finished) {
    await withTx(ctx.db, async (scoped) => {
      const tx = scoped as unknown as Tx;
      const now = ctx.clock.now();
      await tx.importBatch.update({ where: { id: batch.id }, data: { status, counts, completedAt: now } });
      await recordAudit(tx, auditCtx, {
        action: 'import.batch.ingest',
        targetType: 'ImportBatch',
        targetId: batch.id,
        simulated,
        summary: { source: parsed.source, status, ...counts },
      });
    });
  }
  return { batchId: batch.id, status, counts, replayed: finished, records: results };
}

type RecordInput = { parsed: IngestBatchParsed; record: IngestRecord; batchId: string; simulated: boolean; readOnly: boolean };
type RecordCtx = IngestCtx & { workspaceId: string };

async function storedResult(tx: Tx, workspaceId: string, batchId: string, record: IngestRecord, existing: { id: string; status: SourceRecordStatus; reasonCode: string | null; leadId: string | null; importBatchId: string | null; source: IngestBatchParsed['source'] }): Promise<IngestRecordResult> {
  const review = existing.status === 'REVIEW' ? await tx.mergeReview.findFirst({ where: { workspaceId, sourceRecordId: existing.id }, select: { id: true } }) : null;
  const consent =
    NONE_FOR_STATUS[existing.status] ??
    (existing.leadId === null
      ? ({ outcome: 'NONE', reason: 'NOT_CAPTURED' } as const)
      : await findCapturedConsent(tx, workspaceId, { leadId: existing.leadId, source: existing.source, responseId: record.externalId }));
  const sameBatch = existing.importBatchId === batchId;
  return {
    externalId: record.externalId,
    status: sameBatch ? existing.status : 'DUPLICATE',
    reasonCode: sameBatch ? existing.reasonCode : 'ALREADY_RECEIVED',
    sourceRecordId: existing.id,
    leadId: existing.leadId,
    mergeReviewId: review?.id ?? null,
    consent,
    replayed: true,
  };
}

/**
 * What a source record keeps of the received payload. Google Places listings and file-import rows
 * keep the provider ID and the names of the fields only: the values are Places content that expires
 * (ADR-118 (d)) or a spreadsheet's cells (ADR-120: rows never reach the database), and a record
 * that was rejected or sent to review has no lead for the expiry sweep or an erasure to reach. The
 * other sources keep the redacted payload.
 */
function rawPayloadFor(source: string, record: { providerId?: string | undefined; fields: Record<string, unknown>; answers?: Record<string, unknown> | undefined }): Prisma.InputJsonValue {
  if (source === 'GOOGLE_PLACES' || source === 'FILE_IMPORT') {
    return { providerId: record.providerId ?? null, fieldNames: Object.keys(record.fields).sort(), answerCount: Object.keys(record.answers ?? {}).length };
  }
  return redact({ providerId: record.providerId, fields: record.fields, answers: record.answers ?? {} }) as Prisma.InputJsonValue;
}

async function processRecord(tx: Tx, ctx: RecordCtx, input: RecordInput, deps: IngestDeps): Promise<IngestRecordResult> {
  const { parsed, record, batchId, simulated } = input;
  const workspaceId = ctx.workspaceId;
  const source = parsed.source;

  const existing = await tx.leadSourceRecord.findFirst({
    where: { workspaceId, source, externalId: record.externalId },
    select: { id: true, status: true, reasonCode: true, leadId: true, importBatchId: true, source: true },
  });
  if (existing) return storedResult(tx, workspaceId, batchId, record, existing);
  if (input.readOnly) throw new Error(`finished batch ${batchId} is missing the source record for ${record.externalId}`);

  const now = ctx.clock.now();
  const sourceRecordBase = {
    workspaceId,
    importBatchId: batchId,
    source,
    externalId: record.externalId,
    rawPayloadRedacted: rawPayloadFor(source, record),
    mappingVersion: parsed.mapping?.version ?? null,
    attribution: (record.attribution ?? {}) as Prisma.InputJsonValue,
    extractedAt: record.extractedAt ? new Date(record.extractedAt) : null,
    receivedAt: now,
  };
  const result = (status: SourceRecordStatus, reasonCode: string | null, sourceRecordId: string, leadId: string | null, consent: ConsentCaptureResult, mergeReviewId: string | null = null): IngestRecordResult => ({
    externalId: record.externalId,
    status,
    reasonCode,
    sourceRecordId,
    leadId,
    mergeReviewId,
    consent,
    replayed: false,
  });

  const normalized = normalizeLeadFields(record.fields);
  if (!normalized.ok) {
    const rejected = await tx.leadSourceRecord.create({ data: { ...sourceRecordBase, status: 'REJECTED', reasonCode: normalized.reasonCode }, select: { id: true } });
    return result('REJECTED', normalized.reasonCode, rejected.id, null, { outcome: 'NONE', reason: 'REJECTED' });
  }
  const lead = normalized.lead;
  // A Places record may carry its place ID as fields.placeId instead of providerId (the schema
  // refuses a record whose two values differ). Other sources never set Lead.placeId.
  const placeId = source === 'GOOGLE_PLACES' ? (record.providerId ?? record.fields.placeId ?? null) : null;
  const keys = contactKeysFor(lead, source, record.providerId ?? placeId ?? undefined);
  const matches = await findMatchingLeadIds(tx as never, keys);

  const captureConsent = (leadId: string) =>
    captureIngestionConsent(
      tx,
      ctx,
      {
        leadId,
        source,
        mapping: parsed.mapping,
        answers: record.answers,
        responseId: record.externalId,
        submittedAt: record.submittedAt ? new Date(record.submittedAt) : null,
        phoneE164: lead.phoneE164,
        emailNormalized: lead.emailNormalized,
        simulated,
      },
      deps.contactKeyPepper,
    );

  if (matches.length > 1) {
    const sr = await tx.leadSourceRecord.create({ data: { ...sourceRecordBase, status: 'REVIEW', reasonCode: 'MULTIPLE_MATCHES' }, select: { id: true } });
    const reviewId = await openMergeReview(tx, ctx, { sourceRecordId: sr.id, candidateLeadIds: matches, simulated });
    return result('REVIEW', 'MULTIPLE_MATCHES', sr.id, null, { outcome: 'NONE', reason: 'PENDING_REVIEW' }, reviewId);
  }

  if (matches.length === 1) {
    const leadId = matches[0]!;
    const sr = await tx.leadSourceRecord.create({ data: { ...sourceRecordBase, leadId, status: 'DUPLICATE', reasonCode: 'CONTACT_MATCH' }, select: { id: true } });
    return result('DUPLICATE', 'CONTACT_MATCH', sr.id, leadId, await captureConsent(leadId));
  }

  const pipeline = await tx.pipelineConfigVersion.findFirst({ where: { workspaceId, active: true }, select: { id: true, version: true } });
  const created = await tx.lead.create({
    data: {
      workspaceId,
      displayName: lead.displayName,
      nameNormalized: lead.nameNormalized,
      category: lead.category,
      phoneE164: lead.phoneE164,
      phoneRaw: lead.phoneRaw,
      alternatePhones: lead.alternatePhones,
      emailNormalized: lead.emailNormalized,
      website: lead.website,
      websiteStatus: lead.websiteStatus,
      address: lead.address,
      city: lead.city,
      pincode: lead.pincode,
      rating: lead.rating,
      reviewCount: lead.reviewCount,
      placeId,
      placesContentExpiresAt: source === 'GOOGLE_PLACES' ? new Date(now.getTime() + PLACES_CONTENT_TTL_MS) : null,
      scoreReasons: [],
      unknownInputs: [],
      pipelineConfigVersionId: pipeline?.id ?? null,
      firstSource: source,
      simulated,
      createdAt: now,
      updatedAt: now,
    },
    select: { id: true },
  });
  await tx.leadContactKey.createMany({ data: keys.map((k) => ({ workspaceId, leadId: created.id, kind: k.kind, value: k.value })) });
  const sr = await tx.leadSourceRecord.create({ data: { ...sourceRecordBase, leadId: created.id, status: 'ACCEPTED' }, select: { id: true } });

  let executionId: string | null = null;
  if (pipeline) {
    const execution = await tx.pipelineExecution.create({
      data: { workspaceId, leadId: created.id, pipelineConfigVersionId: pipeline.id, currentStage: 'INGESTION', updatedAt: now },
      select: { id: true },
    });
    executionId = execution.id;
    await enqueuePipelineAdvance(tx, ctx.clock, { workspaceId, executionId, stage: 'INGESTION', correlationId: ctx.correlationId, causationId: ctx.causationId ?? null });
  }

  await recordAudit(tx, ctx, {
    action: 'lead.ingest',
    targetType: 'Lead',
    targetId: created.id,
    simulated,
    summary: {
      source,
      sourceRecordId: sr.id,
      importBatchId: batchId,
      contactKeyKinds: keys.map((k) => k.kind),
      pipeline: pipeline ? 'PINNED' : 'NO_ACTIVE_PIPELINE',
      pipelineVersion: pipeline?.version ?? null,
      executionId,
    },
  });

  return result('ACCEPTED', null, sr.id, created.id, await captureConsent(created.id));
}

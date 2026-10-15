/**
 * Webhook event persistence (plan §4.3 "verify, persist, enqueue, 200"; E1/ADR-35; E2/ADR-36).
 *
 * A receiver (a verified webhook route, the extension endpoint, or a DEMO simulator) calls
 * `persistWebhookEvent` after authenticating the source. In one transaction it:
 * 1. Looks up the event by (provider, scopeKey, externalKey). `scopeKey` is the routed
 *    integration id, else the authenticated workspace id (extension token), else `unrouted`, so
 *    identical client-generated ids from two workspaces never collide (E2).
 *    - Seen with the same body hash: a replay. Nothing is written; the caller answers 200 with the
 *      same event id and, once processed, the stored per-record result.
 *    - Seen with a different body hash: 409 `BATCH_CONTENT_MISMATCH`, nothing written.
 * 2. Otherwise inserts the event with two payloads: `payloadRedacted` (the inspector view, passed
 *    through `redact()`, no contact data) and `processingPayload`, the full parsed body encrypted
 *    with AES-256-GCM under the credentials key ring with AAD = the event id (E1), so a worker
 *    restart between persist and process still has the contact data it needs.
 * 3. Enqueues the processing job (`ingest.process`, keyed by the event id) for a routed event, or
 *    schedules the 30-day purge for an unrouted one, and writes the `webhook.receive` audit row.
 *
 * Processing (`./process-ingest.ts`) decrypts only `processingPayload`, never the redacted view;
 * `./purge.ts` nulls it after successful processing plus the retention window.
 */
import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type WebhookEvent, type WebhookProvider, type WebhookStatus } from '@/generated/prisma/client';
import { IdempotencyConflictError } from '@/lib/errors';
import { idempotencyKey } from '@/lib/ids';
import { redact } from '@/lib/redact';
import { withTx } from '@/server/db/tx';
import { enqueueJob, type JobStore } from '@/server/jobs/queue';
import type { Clock } from '@/lib/clock';
import { decryptSecretString, encryptSecret, webhookPayloadAad, type KeyRing } from '@/server/security/secrets';
import { recordAudit, type AuditCtx } from '@/server/services/audit/record';

export const INGEST_PROCESS_JOB = 'ingest.process';
export const WEBHOOK_PURGE_JOB = 'webhook.purge';
export const WEBHOOK_JOB_PAYLOAD_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Processing payload kept after successful processing (ADR-35). */
export const PROCESSED_RETENTION_MS = 7 * DAY_MS;
/** Failed, unrouted or never-processed events keep it until resolved or this long after receipt. */
export const UNRESOLVED_RETENTION_MS = 30 * DAY_MS;
export const UNROUTED_SCOPE = 'unrouted';

export type ProcessJobType = typeof INGEST_PROCESS_JOB;

export type PersistWebhookInput = {
  provider: WebhookProvider;
  /** The routed or authenticated workspace; null stores the event as UNROUTED. */
  workspaceId: string | null;
  /** The routed integration (Sheets, Meta, WhatsApp); null for token-authenticated sources. */
  integrationId: string | null;
  /** Provider idempotency key: sheets eventId, `meta:{page}:{leadgen}`, extension batchId, ... */
  externalKey: string;
  /** The parsed body: stored redacted, and encrypted for processing. */
  body: unknown;
  /** sha256 of the received bytes (raw body for live webhooks, canonical JSON for simulations). */
  bodySha256: string;
  simulated: boolean;
  /** The job that processes a routed event. */
  processJob: ProcessJobType;
};

export type WebhookRecordResult = {
  externalId: string;
  status: string;
  reasonCode: string | null;
  sourceRecordId: string | null;
  leadId: string | null;
  mergeReviewId: string | null;
  /** `CREATED`, or why no consent record was created. */
  consent: string;
};

/** Stored on `WebhookEvent.result`: ids, statuses and codes only, never contact data. */
export type WebhookEventResult =
  | {
      kind: 'ingest';
      importBatchId: string;
      batchStatus: 'COMPLETED' | 'PARTIAL' | 'FAILED';
      counts: { received: number; accepted: number; duplicate: number; review: number; rejected: number };
      records: WebhookRecordResult[];
    }
  | { kind: 'failed'; code: string; message: string };

export type PersistWebhookResult = {
  outcome: 'ACCEPTED' | 'DUPLICATE';
  eventId: string;
  externalKey: string;
  status: WebhookStatus;
  jobId: string | null;
  /** The stored result once processed (replays answer with it). */
  result: WebhookEventResult | null;
};

export function scopeKeyFor(input: { integrationId: string | null; workspaceId: string | null }): string {
  return input.integrationId ?? input.workspaceId ?? UNROUTED_SCOPE;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((k) => record[k] !== undefined)
        .map((k) => [k, sortKeys(record[k])]),
    );
  }
  return value;
}

/** JSON with object keys sorted: the stable byte form of a body that has no raw bytes (simulations). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function ingestJobKey(eventId: string): string {
  return idempotencyKey(INGEST_PROCESS_JOB, eventId);
}

export function purgeJobKey(eventId: string): string {
  return idempotencyKey(WEBHOOK_PURGE_JOB, eventId);
}

/** When the processing payload may be purged: processed + 7 days, otherwise received + 30 days. */
export function purgeDueAt(event: Pick<WebhookEvent, 'status' | 'processedAt' | 'receivedAt'>): Date {
  if (event.status === 'PROCESSED' && event.processedAt) return new Date(event.processedAt.getTime() + PROCESSED_RETENTION_MS);
  return new Date(event.receivedAt.getTime() + UNRESOLVED_RETENTION_MS);
}

/** Schedules the purge of one event's processing payload (idempotent per event). */
export async function schedulePurge(db: JobStore, clock: Clock, input: { eventId: string; workspaceId: string | null; runAt: Date; correlationId: string; causationId?: string | null }) {
  return enqueueJob(db, clock, {
    type: WEBHOOK_PURGE_JOB,
    payload: { webhookEventId: input.eventId },
    payloadVersion: WEBHOOK_JOB_PAYLOAD_VERSION,
    workspaceId: input.workspaceId,
    idempotencyKey: purgeJobKey(input.eventId),
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    runAt: input.runAt,
    kind: 'default',
  });
}

/** Decrypts an event's processing payload (AAD = its own id). Throws SecretDecryptError on any mismatch. */
export function decryptProcessingPayload(ring: KeyRing, event: { id: string; processingPayload: string | null }): unknown {
  if (event.processingPayload === null) throw new Error(`webhook event ${event.id} has no processing payload (purged)`);
  return JSON.parse(decryptSecretString(ring, event.processingPayload, webhookPayloadAad(event.id))) as unknown;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function storedResult(event: Pick<WebhookEvent, 'result'>): WebhookEventResult | null {
  return (event.result as WebhookEventResult | null) ?? null;
}

function recordCount(body: unknown): number | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as { rows?: unknown; records?: unknown; lead?: unknown };
  if (Array.isArray(b.rows)) return b.rows.length;
  if (Array.isArray(b.records)) return b.records.length;
  if (b.lead !== undefined) return 1;
  return null;
}

type Tx = Prisma.TransactionClient;

async function replay(tx: Tx, existing: WebhookEvent, bodySha256: string): Promise<PersistWebhookResult> {
  if (existing.bodySha256 !== bodySha256) {
    throw new IdempotencyConflictError({
      code: 'BATCH_CONTENT_MISMATCH',
      message: `webhook ${existing.provider} ${existing.externalKey} was already received with a different body`,
      userMessage: 'This event or batch id was already received with different content. Send it with a new id.',
    });
  }
  const job = await tx.job.findUnique({ where: { idempotencyKey: ingestJobKey(existing.id) }, select: { id: true } });
  return {
    outcome: 'DUPLICATE',
    eventId: existing.id,
    externalKey: existing.externalKey,
    status: existing.status,
    jobId: job?.id ?? null,
    result: storedResult(existing),
  };
}

export async function persistWebhookEvent(db: PrismaClient, ctx: AuditCtx, input: PersistWebhookInput, deps: { keyRing: KeyRing }): Promise<PersistWebhookResult> {
  if (input.workspaceId === null && input.integrationId !== null) throw new Error('persistWebhookEvent: a routed integration needs its workspace');
  if (input.externalKey.length === 0 || input.externalKey.length > 512) throw new RangeError('persistWebhookEvent: externalKey must be 1-512 characters');
  const scopeKey = scopeKeyFor(input);
  const key = { provider: input.provider, scopeKey, externalKey: input.externalKey };

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await withTx(db, async (tx) => {
        const existing = await tx.webhookEvent.findUnique({ where: { provider_scopeKey_externalKey: key } });
        if (existing) return replay(tx, existing, input.bodySha256);

        const now = ctx.clock.now();
        const routed = input.workspaceId !== null;
        const status: WebhookStatus = routed ? 'RECEIVED' : 'UNROUTED';
        const created = await tx.webhookEvent.create({
          data: {
            ...key,
            workspaceId: input.workspaceId,
            integrationId: input.integrationId,
            bodySha256: input.bodySha256,
            payloadRedacted: redact(input.body) as Prisma.InputJsonValue,
            status,
            simulated: input.simulated,
            receivedAt: now,
          },
          select: { id: true },
        });
        const processingPayload = encryptSecret(deps.keyRing, JSON.stringify(input.body), webhookPayloadAad(created.id));
        await tx.webhookEvent.update({ where: { id: created.id }, data: { processingPayload } });

        let jobId: string | null = null;
        if (routed) {
          const { job } = await enqueueJob(tx, ctx.clock, {
            type: input.processJob,
            payload: { webhookEventId: created.id },
            payloadVersion: WEBHOOK_JOB_PAYLOAD_VERSION,
            workspaceId: input.workspaceId,
            idempotencyKey: ingestJobKey(created.id),
            correlationId: ctx.correlationId,
            kind: 'default',
          });
          jobId = job.id;
        } else {
          await schedulePurge(tx, ctx.clock, { eventId: created.id, workspaceId: null, runAt: new Date(now.getTime() + UNRESOLVED_RETENTION_MS), correlationId: ctx.correlationId });
        }

        await recordAudit(tx, ctx, {
          action: 'webhook.receive',
          targetType: 'WebhookEvent',
          targetId: created.id,
          workspaceId: input.workspaceId,
          simulated: input.simulated,
          summary: { provider: input.provider, status, scope: routed ? (input.integrationId ? 'INTEGRATION' : 'WORKSPACE') : 'UNROUTED', records: recordCount(input.body), jobId },
        });
        return { outcome: 'ACCEPTED' as const, eventId: created.id, externalKey: input.externalKey, status, jobId, result: null };
      });
    } catch (error) {
      // A concurrent delivery of the same event won the insert: the next attempt replays it.
      if (!isUniqueViolation(error) || attempt >= 2) throw error;
    }
  }
}

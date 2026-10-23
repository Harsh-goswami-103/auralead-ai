/**
 * Inbound WhatsApp and email webhooks (T20; plan §4.3, §6.4, §7; C9, C10, C15, C19, E1, E2, E8).
 *
 * Receive (the verified route, or the DEMO simulator, which plays the provider):
 *  - one WebhookEvent per inbound message (`wa:{msgId}`) and per status (`wa:{wamid}:{status}`,
 *    `email:{eventId}`), scoped by the routed integration (E2), with a redacted inspector view that
 *    carries no phone, address or text, and the full item encrypted for processing (E1);
 *  - routing is by `phone_number_id` through `Integration.routingKey`, never payload trust; an
 *    unknown id is stored UNROUTED with no processing job;
 *  - "verify, persist, enqueue, 200": `webhook.process` for messages, `status.apply` for statuses,
 *  - except a Stop (C9, ADR-06): in the same transaction as its WebhookEvent the route writes the
 *    Suppression, cancels the contact's QUEUED attempts, their jobs and messages, and audits; the
 *    SuppressionJournal line is appended after commit (E8). Email hard bounces and complaints are
 *    suppressed the same way.
 *
 * Process (`webhook.process`, worker): the sender becomes (or matches) a lead; the inbound
 * Message is stored once; the window moves only by `advanceLastInbound` (monotone max of provider
 * times, C19); inbound consent is recorded (P13); START re-opts in; quick replies run
 * (quick-replies.ts); the event is PROCESSED with ids-only results.
 *
 * Statuses (`status.apply`, worker): the raw event is stored once per (providerMessageId, status);
 * the message moves by the rank merge (status-merge.ts) with a guarded write; an unknown provider
 * id is PENDING_CORRELATION, retried 5 times over about 10 minutes, then ORPHAN; an echoed
 * `biz_opaque_callback_data` naming an AMBIGUOUS attempt is positive evidence and resolves it.
 */
import { z } from 'zod';
import type { Channel, Prisma, PrismaClient, WebhookProvider } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { AppError, DomainRuleError, NotFoundError } from '@/lib/errors';
import { idempotencyKey, randomBase64Url } from '@/lib/ids';
import { parsePhone } from '@/lib/phone';
import type { EmailEvent } from '@/lib/schemas/webhooks/email';
import { waChangeValueSchema, waInboundMessageSchema, type WaInboundMessage, type WaWebhook, type WhatsAppSimulationEvent } from '@/lib/schemas/webhooks/whatsapp';
import { baseClientOf, getJobContext, type AppCtx } from '@/server/auth/context';
import { requireWorkspace } from '@/server/auth/guards';
import { fenceJob } from '@/server/db/fence';
import type { ScopedTx } from '@/server/db/scoped';
import { withTx } from '@/server/db/tx';
import { enqueueJob, type JobStore } from '@/server/jobs/queue';
import type { JobHandlerContext, JobResult } from '@/server/jobs/types';
import { contactKey, normalizeContact } from '@/server/security/contact-key';
import { hmacSha256 } from '@/server/security/hmac';
import { encryptSecret, webhookPayloadAad, type KeyRing } from '@/server/security/secrets';
import { recordAudit, type AuditCtx } from '@/server/services/audit/record';
import { newConversationMode } from '@/server/services/leads/handoff-guard';
import { ingestBatch } from '@/server/services/leads/ingest';
import { createQuoteFromProposal } from '@/server/services/leads/console';
import { canonicalJson, decryptProcessingPayload, PROCESSED_RETENTION_MS, schedulePurge, scopeKeyFor, sha256Hex, UNRESOLVED_RETENTION_MS } from '@/server/services/webhooks/events';
import { nextQuoteStatus } from '@/server/services/quotes/state-machine';
import { recordInboundMessageConsent, recordStartKeywordConsent } from './consent';
import { afterInboundMessage } from './conversations';
import { projectSent, STATUS_RANK } from './delivery-state';
import { canonicalDeliveryEvent, eventRank, mergeDeliveryStatus } from './status-merge';
import { flushSuppressionJournal, suppressContact, SuppressionJournalBatch, type JournalFlushResult, type SuppressResult } from './suppression';
import type { JournalDeps } from './suppression-journal';
import {
  classifyInbound,
  findDraftQuote,
  findSendableQuote,
  handleCallRequest,
  handleQuoteRequest,
  QUICK_REPLY_PAYLOADS,
  inboundView,
  recordQuickReplyReview,
  stopReasonFor,
  type Classification,
  type QuickReplyContext,
} from './quick-replies';
import { advanceLastInbound } from './window';

export const WEBHOOK_PROCESS_JOB = 'webhook.process';
export const STATUS_APPLY_JOB = 'status.apply';
/** The Resend tag that carries the DispatchAttempt id (set by adapters/email/resend.ts). */
export const EMAIL_ATTEMPT_TAG = 'auralead_attempt';
export const INBOUND_PAYLOAD_VERSION = 1;
/** First try plus 5 correlation retries (plan §6.4). */
export const STATUS_APPLY_MAX_ATTEMPTS = 6;
/** About 10 minutes over 5 retries (plan §6.4). */
export const CORRELATION_RETRY_MS = 120_000;

export type InboundDeps = {
  keyRing: KeyRing;
  /** SUPPRESSION_PEPPER (C17). */
  contactKeyPepper: string;
  mode: 'demo' | 'live';
};
export type ReceiveDeps = InboundDeps & JournalDeps;

/** What a receiving route or simulator knows: the base client, the request clock and id. */
export type ReceiveBase = { db: PrismaClient; clock: Clock; correlationId: string };

/** SMTP and Resend capabilities shown to users (T33 implements the adapters; R27 disclosures). */
export const EMAIL_PROVIDER_CAPABILITIES = {
  EMAIL_SMTP: { inbound: false, bounceTracking: false, disclosure: 'SMTP sends only: there is no inbound (replies are not received here) and bounces are not tracked.' },
  EMAIL_RESEND: {
    inbound: false,
    bounceTracking: true,
    disclosure: 'Bounces and complaints arrive as signed webhooks. Inbound email is not supported for this provider: replies go to your own mailbox, not to the inbox here.',
  },
  DEMO: { inbound: false, bounceTracking: true, disclosure: 'Simulated provider: events are produced inside this app.' },
} as const;

/** The DEMO email provider's webhook signing key, derived from SESSION_SECRET (never the secret itself). */
export function demoEmailWebhookKey(sessionSecret: string): Buffer {
  return hmacSha256(sessionSecret, 'auralead.demo-email-webhook.v1');
}

// ---- Stored processing items ------------------------------------------------------------------------

type WaMessageItem = { v: 1; kind: 'wa.message'; phoneNumberId: string; message: WaInboundMessage; profileName: string | null };
type StatusItem = { v: 1; kind: 'status'; channel: Channel; providerMessageId: string; status: string; providerTs: string; errorCode: string | null; callbackData: string | null };

const statusItemSchema = z.object({
  v: z.literal(1),
  kind: z.literal('status'),
  channel: z.enum(['WHATSAPP', 'EMAIL']),
  providerMessageId: z.string().min(1).max(256),
  status: z.string().min(1).max(64),
  providerTs: z.iso.datetime({ offset: true }),
  errorCode: z.string().max(64).nullable(),
  callbackData: z.string().max(512).nullable(),
});
const waMessageItemSchema = z.object({
  v: z.literal(1),
  kind: z.literal('wa.message'),
  phoneNumberId: z.string().min(1).max(64),
  message: waInboundMessageSchema,
  profileName: z.string().max(256).nullable(),
});
const jobPayloadSchema = z.object({ webhookEventId: z.string().min(1).max(64) });

/** The routed workspace and, for WhatsApp, its integration (email events are routed by our own provider message id). */
export type Routing = { workspaceId: string; integrationId: string | null } | null;

/** Routing by `phone_number_id` (Integration.routingKey), only to a WhatsApp integration of a workspace in this process's mode. */
export async function routeByPhoneNumberId(db: PrismaClient, mode: 'demo' | 'live', phoneNumberId: string): Promise<Routing> {
  const integration = await db.integration.findUnique({ where: { routingKey: phoneNumberId }, select: { id: true, workspaceId: true, kind: true } });
  if (!integration || integration.kind !== 'WHATSAPP_CLOUD') return null;
  const workspace = await db.workspace.findUnique({ where: { id: integration.workspaceId }, select: { mode: true, status: true } });
  if (!workspace || workspace.mode !== (mode === 'demo' ? 'DEMO' : 'LIVE')) return null;
  return { workspaceId: integration.workspaceId, integrationId: integration.id };
}

// ---- Persist ---------------------------------------------------------------------------------------

type Tx = Prisma.TransactionClient;

export type ItemOutcome = 'ACCEPTED' | 'DUPLICATE' | 'CONFLICT';
export type ReceivedItem = { externalKey: string; outcome: ItemOutcome; eventId: string; status: string; stop?: SuppressResult; jobId?: string | null };

type InsertInput = {
  provider: WebhookProvider;
  routing: Routing;
  externalKey: string;
  body: unknown;
  redacted: Prisma.InputJsonValue;
  simulated: boolean;
};

async function insertWebhookItem(tx: Tx, auditCtx: AuditCtx, input: InsertInput, keyRing: KeyRing): Promise<{ outcome: ItemOutcome; eventId: string; status: string }> {
  const workspaceId = input.routing?.workspaceId ?? null;
  const integrationId = input.routing?.integrationId ?? null;
  const key = { provider: input.provider, scopeKey: scopeKeyFor({ integrationId, workspaceId }), externalKey: input.externalKey };
  const bodySha256 = sha256Hex(canonicalJson(input.body));
  const existing = await tx.webhookEvent.findUnique({ where: { provider_scopeKey_externalKey: key }, select: { id: true, bodySha256: true, status: true } });
  if (existing) return { outcome: existing.bodySha256 === bodySha256 ? 'DUPLICATE' : 'CONFLICT', eventId: existing.id, status: existing.status };

  const now = auditCtx.clock.now();
  const status = workspaceId === null ? 'UNROUTED' : 'RECEIVED';
  const created = await tx.webhookEvent.create({
    data: { ...key, workspaceId, integrationId, bodySha256, payloadRedacted: input.redacted, status, simulated: input.simulated, receivedAt: now },
    select: { id: true },
  });
  await tx.webhookEvent.update({ where: { id: created.id }, data: { processingPayload: encryptSecret(keyRing, JSON.stringify(input.body), webhookPayloadAad(created.id)) } });
  if (workspaceId === null) {
    await schedulePurge(tx, auditCtx.clock, { eventId: created.id, workspaceId: null, runAt: new Date(now.getTime() + UNRESOLVED_RETENTION_MS), correlationId: auditCtx.correlationId });
  }
  await recordAudit(tx, auditCtx, {
    action: 'webhook.receive',
    targetType: 'WebhookEvent',
    targetId: created.id,
    workspaceId,
    simulated: input.simulated,
    summary: { provider: input.provider, status, scope: workspaceId === null ? 'UNROUTED' : 'INTEGRATION' },
  });
  return { outcome: 'ACCEPTED', eventId: created.id, status };
}

function enqueueProcessing(tx: JobStore, clock: Clock, input: { type: typeof WEBHOOK_PROCESS_JOB | typeof STATUS_APPLY_JOB; eventId: string; workspaceId: string; correlationId: string }) {
  return enqueueJob(tx, clock, {
    type: input.type,
    payload: { webhookEventId: input.eventId },
    payloadVersion: INBOUND_PAYLOAD_VERSION,
    workspaceId: input.workspaceId,
    idempotencyKey: idempotencyKey(input.type, input.eventId),
    correlationId: input.correlationId,
    kind: 'default',
    ...(input.type === STATUS_APPLY_JOB ? { maxAttempts: STATUS_APPLY_MAX_ATTEMPTS } : {}),
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

/** One transaction (retried once when a concurrent delivery of the same item won the insert). */
async function persistOnce<R>(db: PrismaClient, fn: (tx: Tx) => Promise<R>): Promise<R> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await withTx(db, fn);
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= 2) throw error;
    }
  }
}

function webhookAuditCtx(base: ReceiveBase, workspaceId: string | null): AuditCtx & { workspaceId: string | null; clock: Clock } {
  return { kind: 'webhook', actor: null, workspaceId, correlationId: base.correlationId, clock: base.clock };
}

function e164FromWaId(waId: string): string | null {
  const parsed = parsePhone(`+${waId.replace(/^\+/, '')}`);
  return parsed.valid ? parsed.e164 : null;
}

async function receiveWaMessage(base: ReceiveBase, routing: Routing, item: WaMessageItem, deps: ReceiveDeps, simulated: boolean): Promise<ReceivedItem & { journal?: JournalFlushResult }> {
  const view = inboundView(item.message);
  const classification = classifyInbound(view);
  const externalKey = `wa:${item.message.id}`;
  const redacted = { kind: 'wa.message', providerType: item.message.type, messageId: item.message.id, phoneNumberId: item.phoneNumberId, intent: classification.intent } satisfies Prisma.InputJsonValue;
  const audit = webhookAuditCtx(base, routing?.workspaceId ?? null);
  const phone = e164FromWaId(item.message.from);
  const batch = new SuppressionJournalBatch();

  const result = await persistOnce(base.db, async (tx) => {
    batch.clear();
    const inserted = await insertWebhookItem(tx, audit, { provider: 'WHATSAPP', routing, externalKey, body: item, redacted, simulated }, deps.keyRing);
    if (inserted.outcome !== 'ACCEPTED' || routing === null) return { externalKey, ...inserted };
    let stop: SuppressResult | undefined;
    if (classification.intent === 'STOP' && phone !== null) {
      // C9: the Stop is applied here, in the route's transaction, whether or not a worker runs.
      stop = await suppressContact(
        tx,
        { ...audit, workspaceId: routing.workspaceId },
        batch,
        { channel: 'WHATSAPP', contact: { kind: 'phone', value: phone }, reason: stopReasonFor(classification), sourceEventId: inserted.eventId, simulated },
        deps.contactKeyPepper,
      );
    }
    const { job } = await enqueueProcessing(tx, base.clock, { type: WEBHOOK_PROCESS_JOB, eventId: inserted.eventId, workspaceId: routing.workspaceId, correlationId: base.correlationId });
    return { externalKey, ...inserted, ...(stop ? { stop } : {}), jobId: job.id };
  });
  if (batch.entries().length === 0) return result;
  const journal = await flushSuppressionJournal(base.db, base.clock, deps, batch, base.correlationId);
  return { ...result, journal };
}

async function receiveStatus(base: ReceiveBase, routing: Routing, provider: WebhookProvider, externalKey: string, item: StatusItem, deps: ReceiveDeps, simulated: boolean): Promise<ReceivedItem> {
  const redacted = { kind: 'status', channel: item.channel, providerMessageId: item.providerMessageId, status: item.status, errorCode: item.errorCode } satisfies Prisma.InputJsonValue;
  const audit = webhookAuditCtx(base, routing?.workspaceId ?? null);
  return persistOnce(base.db, async (tx) => {
    const inserted = await insertWebhookItem(tx, audit, { provider, routing, externalKey, body: item, redacted, simulated }, deps.keyRing);
    if (inserted.outcome !== 'ACCEPTED' || routing === null) return { externalKey, ...inserted };
    const { job } = await enqueueProcessing(tx, base.clock, { type: STATUS_APPLY_JOB, eventId: inserted.eventId, workspaceId: routing.workspaceId, correlationId: base.correlationId });
    return { externalKey, ...inserted, jobId: job.id };
  });
}

function unixToIso(ts: string): string {
  return new Date(Number(ts) * 1000).toISOString();
}

export type ReceiveOptions = { simulated: boolean; mode: 'demo' | 'live'; route?: Routing };
export type ReceiveSummary = { items: ReceivedItem[]; skippedChanges: number };

/**
 * Persists every message and status of one verified WhatsApp delivery (each item in its own short
 * transaction) and applies Stops synchronously. `route` overrides routing for the DEMO simulator.
 */
export async function receiveWhatsAppWebhook(base: ReceiveBase, webhook: WaWebhook, deps: ReceiveDeps, opts: ReceiveOptions): Promise<ReceiveSummary> {
  const items: ReceivedItem[] = [];
  let skippedChanges = 0;
  for (const entry of webhook.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') {
        skippedChanges += 1;
        continue;
      }
      const parsed = waChangeValueSchema.safeParse(change.value);
      if (!parsed.success) {
        skippedChanges += 1;
        continue;
      }
      const value = parsed.data;
      const phoneNumberId = value.metadata.phone_number_id;
      const routing = opts.route !== undefined ? opts.route : await routeByPhoneNumberId(base.db, opts.mode, phoneNumberId);
      const names = new Map((value.contacts ?? []).map((c) => [c.wa_id ?? '', c.profile?.name ?? null]));
      for (const message of value.messages ?? []) {
        items.push(await receiveWaMessage(base, routing, { v: 1, kind: 'wa.message', phoneNumberId, message, profileName: names.get(message.from) ?? null }, deps, opts.simulated));
      }
      for (const status of value.statuses ?? []) {
        const item: StatusItem = {
          v: 1,
          kind: 'status',
          channel: 'WHATSAPP',
          providerMessageId: status.id,
          status: status.status,
          providerTs: unixToIso(status.timestamp),
          errorCode: status.errors?.[0]?.code === undefined ? null : String(status.errors[0].code),
          callbackData: status.biz_opaque_callback_data ?? null,
        };
        items.push(await receiveStatus(base, routing, 'WHATSAPP', `wa:${status.id}:${status.status}`, item, deps, opts.simulated));
      }
    }
  }
  return { items, skippedChanges };
}

/**
 * One verified email provider event (Resend shape; the DEMO provider today, T33's Resend receiver
 * later). Routed by our own stored provider message id. A permanent bounce or a complaint is
 * suppressed synchronously (EMAIL only); every event is also a delivery status for the message.
 */
export async function receiveEmailEvent(
  base: ReceiveBase,
  input: {
    provider: Extract<WebhookProvider, 'DEMO' | 'RESEND'>;
    eventId: string;
    event: EmailEvent;
    simulated: boolean;
    /** T33 Resend: routed by the integration's routing key (null = UNROUTED); never by payload. */
    route?: Routing;
    /** T33 Resend: the idempotency key is the svix-id itself. */
    externalKey?: string;
  },
  deps: ReceiveDeps,
): Promise<ReceivedItem & { journal?: JournalFlushResult }> {
  const { event } = input;
  let routing: Routing;
  if (input.route !== undefined) routing = input.route;
  else {
    const message = await base.db.message.findFirst({ where: { channel: 'EMAIL', providerMessageId: event.data.email_id }, select: { workspaceId: true } });
    routing = message ? { workspaceId: message.workspaceId, integrationId: null } : null;
  }
  // T33: the attempt id this app tagged the send with (Resend echoes tags; UNVERIFIED) is positive evidence for an AMBIGUOUS attempt.
  const tags = event.data.tags;
  const tagged = input.provider === 'RESEND' && typeof tags === 'object' && tags !== null && !Array.isArray(tags) ? (tags as Record<string, unknown>)[EMAIL_ATTEMPT_TAG] : undefined;
  const permanentBounce = event.type === 'email.bounced' && event.data.bounce?.type === 'Permanent';
  const status = event.type === 'email.bounced' && !permanentBounce ? 'email.bounce_transient' : event.type;
  const item: StatusItem = {
    v: 1,
    kind: 'status',
    channel: 'EMAIL',
    providerMessageId: event.data.email_id,
    status,
    providerTs: new Date(event.created_at).toISOString(),
    errorCode: event.data.bounce?.subType ?? null,
    callbackData: typeof tagged === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(tagged) ? tagged : null,
  };
  const reason = permanentBounce ? 'HARD_BOUNCE' : event.type === 'email.complained' ? 'COMPLAINT' : null;
  const recipient = event.data.to?.[0] ?? null;
  const externalKey = input.externalKey ?? `email:${input.eventId}`;
  const redacted = { kind: 'status', channel: 'EMAIL', providerMessageId: item.providerMessageId, status, errorCode: item.errorCode } satisfies Prisma.InputJsonValue;
  const audit = webhookAuditCtx(base, routing?.workspaceId ?? null);
  const batch = new SuppressionJournalBatch();

  const result = await persistOnce(base.db, async (tx) => {
    batch.clear();
    const inserted = await insertWebhookItem(tx, audit, { provider: input.provider, routing, externalKey, body: item, redacted, simulated: input.simulated }, deps.keyRing);
    if (inserted.outcome !== 'ACCEPTED' || routing === null) return { externalKey, ...inserted };
    let stop: SuppressResult | undefined;
    if (reason !== null && recipient !== null) {
      let plain: string | null = null;
      try {
        plain = normalizeContact('email', recipient);
      } catch {
        plain = null;
      }
      if (plain !== null) {
        stop = await suppressContact(
          tx,
          { ...audit, workspaceId: routing.workspaceId },
          batch,
          { channel: 'EMAIL', contact: { kind: 'email', value: plain }, reason, sourceEventId: inserted.eventId, simulated: input.simulated },
          deps.contactKeyPepper,
        );
      }
    }
    const { job } = await enqueueProcessing(tx, base.clock, { type: STATUS_APPLY_JOB, eventId: inserted.eventId, workspaceId: routing.workspaceId, correlationId: base.correlationId });
    return { externalKey, ...inserted, ...(stop ? { stop } : {}), jobId: job.id };
  });
  if (batch.entries().length === 0) return result;
  return { ...result, journal: await flushSuppressionJournal(base.db, base.clock, deps, batch, base.correlationId) };
}

// ---- Worker side -------------------------------------------------------------------------------------

/** A tenant-scoped transaction whose first statement (after the write lock) is the claimToken fence (E5). */
function scopedFencedTx<R>(job: JobHandlerContext, ctx: AppCtx, fn: (tx: ScopedTx) => Promise<R>): Promise<R> {
  return withTx(ctx.db as never, async (tx: ScopedTx) => {
    await fenceJob(tx as never, job.job.id, job.job.claimToken, job.clock.now());
    return fn(tx);
  });
}

function dead(reason: string, error: string): JobResult {
  return { outcome: 'dead', reason, errorCode: reason, error };
}

type LoadedEvent = { id: string; workspaceId: string; status: string; simulated: boolean; processingPayload: string | null; provider: WebhookProvider };

async function loadEvent(job: JobHandlerContext): Promise<{ ok: true; event: LoadedEvent; workspaceId: string } | { ok: false; result: JobResult }> {
  const payload = jobPayloadSchema.safeParse(job.job.payload);
  if (!payload.success) return { ok: false, result: dead('INVALID_PAYLOAD', `${job.job.type} payload is not { webhookEventId }`) };
  const workspaceId = job.job.workspaceId;
  if (workspaceId === null) return { ok: false, result: dead('INVALID_PAYLOAD', `${job.job.type} needs a workspace job`) };
  const event = await job.db.webhookEvent.findFirst({
    where: { id: payload.data.webhookEventId, workspaceId },
    select: { id: true, workspaceId: true, status: true, simulated: true, processingPayload: true, provider: true },
  });
  if (!event) return { ok: false, result: dead('EVENT_NOT_FOUND', `no webhook event in the job's workspace`) };
  return { ok: true, event: { ...event, workspaceId }, workspaceId };
}

async function finishEvent(tx: Tx | ScopedTx, ctx: AppCtx, job: JobHandlerContext, event: LoadedEvent, outcome: { status: 'PROCESSED' | 'FAILED' | 'ORPHAN'; result: Record<string, unknown> }): Promise<boolean> {
  const now = ctx.clock.now();
  const updated = await (tx as Tx).webhookEvent.updateMany({
    where: { id: event.id, status: { in: ['RECEIVED', 'PENDING_CORRELATION'] } },
    data: { status: outcome.status, processedAt: now, result: outcome.result as Prisma.InputJsonValue, attempts: { increment: 1 } },
  });
  if (updated.count !== 1) return false;
  const runAt = outcome.status === 'PROCESSED' ? new Date(now.getTime() + PROCESSED_RETENTION_MS) : new Date(now.getTime() + UNRESOLVED_RETENTION_MS);
  await schedulePurge(tx as unknown as JobStore, ctx.clock, { eventId: event.id, workspaceId: event.workspaceId, runAt, correlationId: job.correlationId, causationId: job.job.id });
  await recordAudit(tx as Tx, ctx, {
    action: 'webhook.process',
    targetType: 'WebhookEvent',
    targetId: event.id,
    result: outcome.status === 'PROCESSED' ? 'SUCCESS' : 'FAILED',
    simulated: event.simulated,
    summary: { provider: event.provider, jobId: job.job.id, status: outcome.status, ...outcome.result },
  });
  return true;
}

async function findLeadByPhone(db: PrismaClient, workspaceId: string, phone: string): Promise<{ id: string } | null> {
  const key = await db.leadContactKey.findFirst({ where: { workspaceId, kind: 'PHONE', value: phone }, select: { leadId: true } });
  // Leads entered by hand may have no contact-key row: fall back to the lead's own phone column.
  const byColumn = key ? null : await db.lead.findFirst({ where: { workspaceId, phoneE164: phone }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } });
  let leadId = key?.leadId ?? byColumn?.id ?? null;
  for (let hop = 0; leadId !== null && hop < 5; hop += 1) {
    const lead = await db.lead.findFirst({ where: { workspaceId, id: leadId }, select: { id: true, mergedIntoLeadId: true } });
    if (!lead) return null;
    if (lead.mergedIntoLeadId === null) return { id: lead.id };
    leadId = lead.mergedIntoLeadId;
  }
  return null;
}

const LEAD_STAGES_BEFORE_REPLIED = ['NEW', 'CONTACTED'] as const;

function decodeItem<T>(deps: InboundDeps, event: LoadedEvent, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(decryptProcessingPayload(deps.keyRing, event));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** `webhook.process`: one inbound WhatsApp message. */
export async function processWhatsAppInbound(job: JobHandlerContext, deps: InboundDeps): Promise<JobResult> {
  const loaded = await loadEvent(job);
  if (!loaded.ok) return loaded.result;
  const { event, workspaceId } = loaded;
  if (event.status !== 'RECEIVED') return { outcome: 'succeeded' };
  const ctx = getJobContext({ id: job.job.id, workspaceId, correlationId: job.correlationId }, { prisma: job.db, mode: deps.mode, clock: job.clock });
  const fail = (code: string): JobResult => ({ outcome: 'succeeded', finalTx: async (tx) => void (await finishEvent(tx, ctx, job, event, { status: 'FAILED', result: { kind: 'inbound', code } })) });

  const item = event.processingPayload === null ? null : decodeItem(deps, event, waMessageItemSchema);
  if (item === null) return fail(event.processingPayload === null ? 'PAYLOAD_PURGED' : 'PAYLOAD_UNREADABLE');
  const phone = e164FromWaId(item.message.from);
  if (phone === null) return fail('SENDER_INVALID');
  const providerTs = new Date(Number(item.message.timestamp) * 1000);
  const view = inboundView(item.message);
  const classification: Classification = classifyInbound(view);

  // Lease check before any write (E5).
  await scopedFencedTx(job, ctx, async () => undefined);

  let lead = await findLeadByPhone(job.db, workspaceId, phone);
  if (lead === null) {
    if (classification.intent === 'STOP') {
      // Never create a lead from an opt-out; the suppression itself was written by the route.
      return { outcome: 'succeeded', finalTx: async (tx) => void (await finishEvent(tx, ctx, job, event, { status: 'PROCESSED', result: { kind: 'inbound', intent: 'STOP', leadId: null } })) };
    }
    try {
      const ingested = await ingestBatch(
        ctx,
        {
          source: 'WHATSAPP_INBOUND',
          externalBatchId: `wa:${item.message.id}`,
          simulated: event.simulated,
          records: [{ externalId: item.message.id, fields: { name: item.profileName?.trim() || phone, phone }, submittedAt: providerTs.toISOString() }],
        },
        { contactKeyPepper: deps.contactKeyPepper },
      );
      const record = ingested.records[0];
      lead = record?.leadId ? { id: record.leadId } : null;
      if (lead === null) return fail(`LEAD_NOT_CREATED:${record?.status ?? 'NONE'}`);
    } catch (error) {
      if (error instanceof AppError && error.retryable) throw error;
      if (error instanceof AppError && error.status < 500) return fail(error.code);
      throw error;
    }
  }
  const leadId = lead.id;

  // P3: a QUOTE request with nothing sendable and no DRAFT quote gets one from the lead's last proposal (its own transactions, priced by the server).
  if (classification.intent === 'QUOTE') {
    const now = job.clock.now();
    const hasQuote = (await findSendableQuote(ctx.db as unknown as ScopedTx, leadId, now)) !== null || (await findDraftQuote(ctx.db as unknown as ScopedTx, leadId)) !== null;
    if (!hasQuote) {
      const drafts = await ctx.db.aiDraft.findMany({ where: { leadId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, proposal: true }, take: 10 });
      const withProposal = drafts.find((d) => Array.isArray((d.proposal as { items?: unknown } | null)?.items) && ((d.proposal as { items: unknown[] }).items.length > 0));
      if (withProposal) {
        try {
          await createQuoteFromProposal(ctx, { leadId, draftId: withProposal.id });
        } catch (error) {
          if (error instanceof AppError && error.retryable) throw error;
          if (!(error instanceof AppError && error.status < 500)) throw error;
          // A proposal that cannot become a quote (empty, incomplete, unpriced) leaves the request for review.
        }
      }
    }
  }

  await scopedFencedTx(job, ctx, async (tx) => {
    const current = await tx.webhookEvent.findFirst({ where: { id: event.id }, select: { status: true } });
    if (current?.status !== 'RECEIVED') return;
    const now = ctx.clock.now();
    const key = contactKey(deps.contactKeyPepper, 'phone', phone);
    const conversation =
      (await tx.conversation.findFirst({ where: { leadId, channel: 'WHATSAPP', closedAt: null } })) ??
      (await tx.conversation.create({ data: { workspaceId, leadId, channel: 'WHATSAPP', contactKey: key, createdAt: now, ...(await newConversationMode(tx, leadId)) } }));

    const existing = await tx.message.findFirst({ where: { channel: 'WHATSAPP', providerMessageId: item.message.id }, select: { id: true } });
    const inbound =
      existing ??
      (await tx.message.create({
        data: {
          workspaceId,
          conversationId: conversation.id,
          direction: 'IN',
          channel: 'WHATSAPP',
          kind: view.kind,
          body: view.body,
          variables: view.isQuickReply ? { quickReply: classification.intent, payload: view.payload, matchedBy: classification.matchedBy } : undefined,
          status: 'DELIVERED',
          statusRank: STATUS_RANK.DELIVERED,
          providerMessageId: item.message.id,
          providerTs,
          simulated: event.simulated,
          createdAt: now,
        },
        select: { id: true },
      }));

    // C19: the window moves only forward, to the provider time of a valid inbound message.
    const last = advanceLastInbound(conversation.lastInboundProviderAt, { type: view.isQuickReply ? 'INBOUND_INTERACTIVE_REPLY' : 'INBOUND_MESSAGE', providerTs });
    const advanced = last !== null && (conversation.lastInboundProviderAt === null || last.getTime() !== conversation.lastInboundProviderAt.getTime());
    await tx.conversation.update({
      where: { id: conversation.id },
      data: { lastInboundProviderAt: last, ...(advanced ? { lastInboundMessageId: inbound.id } : {}), unansweredOutboundCount: 0 },
    });
    await tx.lead.updateMany({ where: { id: leadId, salesStage: { in: [...LEAD_STAGES_BEFORE_REPLIED] } }, data: { salesStage: 'REPLIED', stageVersion: { increment: 1 } } });

    const txAny = tx as unknown as Tx;
    const consentInput = { leadId, phoneE164: phone, providerTs, messageId: inbound.id, simulated: event.simulated };
    const result: Record<string, unknown> = { kind: 'inbound', intent: classification.intent, leadId, conversationId: conversation.id, messageId: inbound.id, windowAdvanced: advanced };
    if (classification.intent !== 'STOP') {
      // P13: a service-window consent only; never a template or marketing opt-in.
      await recordInboundMessageConsent(txAny, ctx, consentInput, deps.contactKeyPepper);
    }
    if (classification.intent === 'START') {
      result.reoptIn = (await recordStartKeywordConsent(txAny, ctx, 'enqueue-reconcile', consentInput, deps.contactKeyPepper)).reoptIn;
    }
    if (classification.intent !== 'STOP') {
      // T21: the newest inbound supersedes queued automated replies to older ones and, for plain text
      // in a DRAFT or AUTO thread, queues the guarded reply (reply.auto).
      result.reply = await afterInboundMessage(tx, ctx, {
        conversationId: conversation.id,
        inboundMessageId: inbound.id,
        latest: advanced,
        replyable: classification.intent === 'MESSAGE' && view.kind === 'TEXT' && (view.body ?? '').trim() !== '',
      });
    }
    if (classification.intent === 'QUOTE' || classification.intent === 'CALL' || classification.intent === 'UNKNOWN_QUICK_REPLY') {
      const settings = await tx.workspaceSettings.findFirst({ select: { autoSendEnabled: true, bookingUrl: true } });
      const q: QuickReplyContext = {
        tx,
        ctx,
        leadId,
        conversationId: conversation.id,
        inboundMessageId: inbound.id,
        eventId: event.id,
        settings: { autoSendEnabled: settings?.autoSendEnabled ?? false, bookingUrl: settings?.bookingUrl ?? null },
        deps: { contactKeyPepper: deps.contactKeyPepper },
        simulated: event.simulated,
      };
      if (classification.intent === 'QUOTE') result.quote = await handleQuoteRequest(q);
      else if (classification.intent === 'CALL') result.call = await handleCallRequest(q);
      else {
        await recordQuickReplyReview(q, view);
        result.review = 'UNKNOWN_QUICK_REPLY';
      }
    }
    await finishEvent(tx, ctx, job, event, { status: 'PROCESSED', result });
  });
  return { outcome: 'succeeded' };
}

// ---- status.apply ------------------------------------------------------------------------------------

type ApplyOutcome = 'done' | 'pending';

async function resolveAmbiguous(tx: ScopedTx, ctx: AppCtx, item: StatusItem, simulated: boolean) {
  if (item.callbackData === null) return null;
  const attempt = await tx.dispatchAttempt.findFirst({ where: { id: item.callbackData, channel: item.channel, state: 'AMBIGUOUS' } });
  if (!attempt) return null;
  const workspaceId = requireWorkspace(ctx);
  const now = ctx.clock.now();
  const moved = await tx.dispatchAttempt.updateMany({
    where: { id: attempt.id, state: 'AMBIGUOUS' },
    data: { state: 'SENT', providerMessageId: item.providerMessageId, resolvedBy: 'system:status.apply', resolvedAt: now, resolutionNote: 'provider status echoed this attempt id', updatedAt: now },
  });
  if (moved.count !== 1) return null;
  await projectSent(tx as unknown as Tx, { workspaceId, messageId: attempt.messageId }, { providerMessageId: item.providerMessageId, simulated, providerTs: new Date(item.providerTs) });
  const message = await tx.message.findFirstOrThrow({ where: { id: attempt.messageId }, select: { conversationId: true } });
  // T21: one more business message since the customer's last inbound.
  await tx.conversation.updateMany({ where: { id: message.conversationId }, data: { unansweredOutboundCount: { increment: 1 } } });
  const conversation = await tx.conversation.findFirstOrThrow({ where: { id: message.conversationId }, select: { leadId: true } });
  const target = attempt.quoteVersionId ? 'QUOTE_SENT' : 'CONTACTED';
  const lower = target === 'QUOTE_SENT' ? ['NEW', 'CONTACTED', 'REPLIED'] : ['NEW'];
  await tx.lead.updateMany({ where: { id: conversation.leadId, salesStage: { in: lower as never } }, data: { salesStage: target, stageVersion: { increment: 1 } } });
  if (attempt.quoteVersionId) {
    const version = await tx.quoteVersion.findFirstOrThrow({ where: { id: attempt.quoteVersionId }, select: { quoteId: true, sentAt: true } });
    if (version.sentAt === null) await tx.quoteVersion.updateMany({ where: { id: attempt.quoteVersionId }, data: { sentAt: now } });
    await tx.quote.updateMany({ where: { id: version.quoteId, currentVersionId: attempt.quoteVersionId, status: 'APPROVED' }, data: { status: nextQuoteStatus('APPROVED', 'SEND'), sentVia: 'DISPATCH', updatedAt: now } });
  }
  await recordAudit(tx as unknown as Tx, ctx, {
    action: 'dispatch.ambiguous_resolved',
    targetType: 'DispatchAttempt',
    targetId: attempt.id,
    simulated,
    summary: { channel: item.channel, evidence: 'CALLBACK_DATA', status: item.status },
  });
  return tx.message.findFirst({ where: { id: attempt.messageId } });
}

async function applyStatus(tx: ScopedTx, ctx: AppCtx, job: JobHandlerContext, event: LoadedEvent, item: StatusItem, lastAttempt: boolean): Promise<ApplyOutcome> {
  const current = await tx.webhookEvent.findFirst({ where: { id: event.id }, select: { status: true } });
  if (current?.status !== 'RECEIVED' && current?.status !== 'PENDING_CORRELATION') return 'done';
  const workspaceId = requireWorkspace(ctx);
  const now = ctx.clock.now();
  const delivery = canonicalDeliveryEvent(item.channel, item.status);

  let message = await tx.message.findFirst({ where: { channel: item.channel, providerMessageId: item.providerMessageId } });
  if (!message) message = await resolveAmbiguous(tx, ctx, item, event.simulated);

  const stored = await tx.messageStatusEvent.findFirst({ where: { providerMessageId: item.providerMessageId, status: item.status } });
  const statusEvent =
    stored ??
    (await tx.messageStatusEvent.create({
      data: { workspaceId, messageId: message?.id ?? null, providerMessageId: item.providerMessageId, status: item.status, rank: eventRank(delivery), providerTs: new Date(item.providerTs), errorCode: item.errorCode, receivedAt: now },
    }));
  if (stored && message && stored.messageId === null) await tx.messageStatusEvent.update({ where: { id: stored.id }, data: { messageId: message.id } });

  if (!message) {
    if (lastAttempt) {
      await finishEvent(tx, ctx, job, event, { status: 'ORPHAN', result: { kind: 'status', code: 'NO_MATCHING_MESSAGE', statusEventId: statusEvent.id } });
      return 'done';
    }
    await tx.webhookEvent.updateMany({ where: { id: event.id }, data: { status: 'PENDING_CORRELATION', attempts: { increment: 1 } } });
    return 'pending';
  }

  let applied: { from: string; to: string } | null = null;
  let anomaly = false;
  // A duplicate event (same provider id and status, already linked to the message) was merged already.
  const duplicate = stored !== null && stored.messageId !== null;
  if (delivery !== null && !duplicate) {
    const merge = mergeDeliveryStatus({ status: message.status, statusRank: message.statusRank }, delivery);
    anomaly = merge.anomaly;
    if (merge.next) {
      const moved = await tx.message.updateMany({ where: { id: message.id, status: message.status, statusRank: message.statusRank }, data: { status: merge.next.status, statusRank: merge.next.statusRank } });
      if (moved.count === 1) {
        applied = { from: message.status, to: merge.next.status };
        await recordAudit(tx as unknown as Tx, ctx, {
          action: 'message.status',
          targetType: 'Message',
          targetId: message.id,
          simulated: event.simulated,
          summary: { from: message.status, to: merge.next.status, rank: eventRank(delivery), providerStatus: item.status },
        });
      }
    }
    if (anomaly) await tx.messageStatusEvent.update({ where: { id: statusEvent.id }, data: { anomaly: true } });
  }
  await finishEvent(tx, ctx, job, event, { status: 'PROCESSED', result: { kind: 'status', messageId: message.id, applied: applied !== null, anomaly, duplicate } });
  return 'done';
}

/** `status.apply`: one delivery status event (WhatsApp or email). */
export async function processStatusEvent(job: JobHandlerContext, deps: InboundDeps): Promise<JobResult> {
  const loaded = await loadEvent(job);
  if (!loaded.ok) return loaded.result;
  const { event, workspaceId } = loaded;
  if (event.status !== 'RECEIVED' && event.status !== 'PENDING_CORRELATION') return { outcome: 'succeeded' };
  const ctx = getJobContext({ id: job.job.id, workspaceId, correlationId: job.correlationId }, { prisma: job.db, mode: deps.mode, clock: job.clock });
  const item = event.processingPayload === null ? null : decodeItem(deps, event, statusItemSchema);
  if (item === null) {
    return {
      outcome: 'succeeded',
      finalTx: async (tx) => void (await finishEvent(tx, ctx, job, event, { status: 'FAILED', result: { kind: 'status', code: event.processingPayload === null ? 'PAYLOAD_PURGED' : 'PAYLOAD_UNREADABLE' } })),
    };
  }
  const lastAttempt = job.job.attempts >= job.job.maxAttempts;
  const outcome = await scopedFencedTx(job, ctx, (tx) => applyStatus(tx, ctx, job, event, item, lastAttempt));
  if (outcome === 'pending') {
    return { outcome: 'retry', errorCode: 'PENDING_CORRELATION', error: 'no message with this provider id yet', retryAfterMs: CORRELATION_RETRY_MS };
  }
  return { outcome: 'succeeded' };
}

// ---- DEMO inbound simulation ------------------------------------------------------------------------

export type WhatsAppSimulationInput = { leadId: string; event: WhatsAppSimulationEvent; text?: string };

const SIMULATED_MESSAGES: Record<Exclude<WhatsAppSimulationEvent, 'text'>, Pick<WaInboundMessage, 'type'> & Partial<WaInboundMessage>> = {
  quick_reply_quote: { type: 'button', button: { payload: QUICK_REPLY_PAYLOADS.QUOTE, text: 'Send my quote' } },
  quick_reply_call: { type: 'button', button: { payload: QUICK_REPLY_PAYLOADS.CALL, text: 'Call me' } },
  quick_reply_stop: { type: 'button', button: { payload: QUICK_REPLY_PAYLOADS.STOP, text: 'Stop promotions' } },
  start: { type: 'text', text: { body: 'START' } },
};

/**
 * DEMO only: the customer side of WhatsApp, played inside the app. Builds the Cloud API payload a
 * message from the lead's own number would produce and hands it to the same receive path as the
 * verified route (a Stop is applied synchronously, everything else is processed by the worker).
 * Routed to the workspace's SIMULATED WhatsApp integration (created on first use, no routing key).
 */
export async function simulateWhatsAppInbound(ctx: AppCtx, input: WhatsAppSimulationInput, deps: ReceiveDeps): Promise<{ messageId: string; summary: ReceiveSummary }> {
  const workspaceId = requireWorkspace(ctx);
  if (ctx.mode !== 'demo') throw new NotFoundError({ message: 'simulations exist only in a DEMO process' });
  const db = baseClientOf(ctx);
  const workspace = await db.workspace.findUnique({ where: { id: workspaceId }, select: { mode: true } });
  if (!workspace || workspace.mode !== 'DEMO') throw new NotFoundError({ message: 'simulations never touch a LIVE workspace' });
  const lead = await ctx.db.lead.findFirst({ where: { id: input.leadId }, select: { id: true, phoneE164: true, displayName: true } });
  if (!lead) throw new NotFoundError();
  if (lead.phoneE164 === null) throw new DomainRuleError({ code: 'CONTACT_MISSING', userMessage: 'This lead has no WhatsApp number to simulate a message from.' });

  const integration = await withTx(ctx.db, async (scoped) => {
    const tx = scoped as unknown as Tx;
    const existing = await tx.integration.findFirst({ where: { workspaceId, kind: 'WHATSAPP_CLOUD' }, select: { id: true } });
    if (existing) return existing;
    const created = await tx.integration.create({ data: { workspaceId, kind: 'WHATSAPP_CLOUD', status: 'SIMULATED', config: { phoneNumberId: `demo-${workspaceId}` } }, select: { id: true } });
    await recordAudit(tx, ctx, { action: 'integration.simulated.create', targetType: 'Integration', targetId: created.id, simulated: true, summary: { kind: 'WHATSAPP_CLOUD' } });
    return created;
  });

  const now = ctx.clock.now();
  const messageId = `wamid.demo.${randomBase64Url(12)}`;
  const shape = input.event === 'text' ? { type: 'text', text: { body: input.text ?? 'Hello' } } : SIMULATED_MESSAGES[input.event];
  const message = { ...shape, from: lead.phoneE164.replace(/^\+/, ''), id: messageId, timestamp: String(Math.floor(now.getTime() / 1000)) } as WaInboundMessage;
  const phoneNumberId = `demo-${workspaceId}`;
  const webhook: WaWebhook = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'demo', changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, contacts: [{ wa_id: message.from, profile: { name: lead.displayName } }], messages: [message] } }] }],
  };
  const summary = await receiveWhatsAppWebhook({ db, clock: ctx.clock, correlationId: ctx.correlationId }, webhook, deps, {
    simulated: true,
    mode: 'demo',
    route: { workspaceId, integrationId: integration.id },
  });
  return { messageId, summary };
}

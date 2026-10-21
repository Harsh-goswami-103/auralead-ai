/**
 * "Backfill from form since T" (T35; critic L-8: an on-demand action in the Meta console, not a
 * scheduled poller, so no rate-limit budget is spent silently). LIVE only: DEMO has no provider
 * (the lead simulation exercises the same ingestion).
 *
 * Request (`requestMetaBackfill`, `integrations.manage`): one Instant Form that has a mapping,
 * `since` within the last 90 days and not in the future, on a configured META_ADS integration.
 * One MetaLeadBackfill row per request key (a double click or a retry is the same run) and one
 * `meta.lead.backfill` job, audited `meta.backfill.request`.
 *
 * Run (`runMetaBackfill`, the job): outside any transaction it reads the form's leads created
 * after `since`, 100 per page, at most BACKFILL_MAX_PAGES pages (cursor `after` only); each page
 * is ingested through `ingestBatch` as its own batch, so dedupe by leadgen id makes a lead that
 * already arrived through the webhook a duplicate, never a second lead. Progress (pages, leads,
 * counts) is written in fenced transactions after each page; the run ends COMPLETED (with
 * `truncated` when the page cap was reached) or FAILED with the error code: a rejected token sets
 * the integration to "Verification required" and the job is DEAD; a missing permission is named;
 * throttling and provider errors retry with backoff and fail the run at the last attempt.
 */
import type { Prisma } from '@/generated/prisma/client';
import { DomainRuleError, NotFoundError } from '@/lib/errors';
import { BACKFILL_MAX_AGE_DAYS, type MetaBackfillBody } from '@/lib/schemas/meta';
import { metaLeadEventSchema, type MetaLeadgenChange } from '@/lib/schemas/webhooks';
import type { IngestBatchInput } from '@/lib/schemas/ingest';
import { classifyMetaFailure, parseGraphLead } from '@/server/adapters/meta/graph';
import { CHECKABLE_STATUSES, metaLeadsClient } from '@/server/adapters/registry';
import { getJobContext, type AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { LeaseLostError } from '@/server/db/fence';
import { withTx } from '@/server/db/tx';
import { enqueueJob } from '@/server/jobs/queue';
import type { FinalTx, JobHandlerContext, JobResult, TxClient } from '@/server/jobs/types';
import { recordAudit } from '@/server/services/audit/record';
import { loadIntegrationForUse } from '@/server/services/integrations/credentials';
import { ingestBatch } from '@/server/services/leads/ingest';
import { metaToIngest, PayloadMappingError } from '@/server/services/webhooks/payload-mapping';
import { BACKFILL_MAX_PAGES, META_JOB_PAYLOAD_VERSION, META_LEAD_BACKFILL_JOB, metaBackoffMs } from './constants';
import { recordMetaAccessProblem } from './integration-problems';
import type { MetaLeadDeps } from './meta-leads';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ERROR = 500;

export type BackfillView = {
  id: string;
  formId: string;
  since: Date;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  pages: number;
  fetched: number;
  counts: { received: number; accepted: number; duplicate: number; review: number; rejected: number } | null;
  truncated: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

type Counts = NonNullable<BackfillView['counts']>;
const ZERO: Counts = { received: 0, accepted: 0, duplicate: 0, review: 0, rejected: 0 };

function countsOf(value: unknown): Counts | null {
  if (typeof value !== 'object' || value === null) return null;
  const c = value as Record<string, unknown>;
  const n = (k: keyof Counts) => (typeof c[k] === 'number' ? (c[k] as number) : 0);
  return { received: n('received'), accepted: n('accepted'), duplicate: n('duplicate'), review: n('review'), rejected: n('rejected') };
}

export function backfillView(row: {
  id: string;
  formId: string;
  since: Date;
  status: BackfillView['status'];
  pages: number;
  fetched: number;
  counts: unknown;
  truncated: boolean;
  errorCode: string | null;
  errorRedacted: string | null;
  createdAt: Date;
  completedAt: Date | null;
}): BackfillView {
  return {
    id: row.id,
    formId: row.formId,
    since: row.since,
    status: row.status,
    pages: row.pages,
    fetched: row.fetched,
    counts: countsOf(row.counts),
    truncated: row.truncated,
    errorCode: row.errorCode,
    errorMessage: row.errorRedacted,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

export function backfillJobKey(runId: string): string {
  return `${META_LEAD_BACKFILL_JOB}:${runId}`;
}

export async function requestMetaBackfill(ctx: AppCtx, input: Omit<MetaBackfillBody, 'workspaceSlug'>): Promise<BackfillView & { created: boolean }> {
  requireCapability(ctx, 'integrations.manage');
  const workspaceId = requireWorkspace(ctx);
  const ws = await ctx.db.workspace.findUnique({ where: { id: workspaceId }, select: { mode: true } });
  if (!ws || ws.mode !== (ctx.mode === 'demo' ? 'DEMO' : 'LIVE')) throw new NotFoundError();
  if (ctx.mode !== 'live') {
    throw new DomainRuleError({ code: 'LIVE_ONLY', userMessage: 'A backfill reads leads from Meta, which DEMO never contacts. Use the lead simulation instead.' });
  }
  const existing = await ctx.db.metaLeadBackfill.findFirst({ where: { requestKey: input.requestKey } });
  if (existing) return { ...backfillView(existing), created: false };

  const now = ctx.clock.now();
  const since = new Date(input.since);
  if (since.getTime() > now.getTime() || since.getTime() < now.getTime() - BACKFILL_MAX_AGE_DAYS * DAY_MS) {
    throw new DomainRuleError({ code: 'BACKFILL_SINCE_INVALID', userMessage: `Choose a start time in the last ${BACKFILL_MAX_AGE_DAYS} days (Meta keeps Instant Form leads for 90 days).` });
  }
  const integration = await ctx.db.integration.findFirst({ where: { kind: 'META_ADS' }, select: { id: true, status: true } });
  if (!integration || !CHECKABLE_STATUSES.has(integration.status)) {
    throw new DomainRuleError({ code: 'INTEGRATION_NOT_CONFIGURED', userMessage: 'Meta Lead Ads is not configured. Save the Page ID and access token on its setup page first.' });
  }
  const mapping = await ctx.db.metaFormMapping.findFirst({ where: { integrationId: integration.id, formId: input.formId }, select: { id: true } });
  if (!mapping) throw new DomainRuleError({ code: 'MAPPING_NOT_FOUND', userMessage: `Form ${input.formId} has no field mapping. Map its questions first, so the leads can be read.` });

  const row = await withTx(ctx.db, async (scoped) => {
    const tx = scoped as unknown as TxClient;
    const created = await tx.metaLeadBackfill.create({
      data: { workspaceId, integrationId: integration.id, formId: input.formId, since, requestKey: input.requestKey, requestedBy: ctx.actor?.userId ?? 'system', correlationId: ctx.correlationId },
    });
    const { job } = await enqueueJob(tx, ctx.clock, {
      type: META_LEAD_BACKFILL_JOB,
      payload: { backfillId: created.id },
      payloadVersion: META_JOB_PAYLOAD_VERSION,
      workspaceId,
      idempotencyKey: backfillJobKey(created.id),
      correlationId: ctx.correlationId,
      kind: 'fetch',
    });
    const updated = await tx.metaLeadBackfill.update({ where: { id: created.id }, data: { jobId: job.id } });
    await recordAudit(tx, ctx, { action: 'meta.backfill.request', targetType: 'MetaLeadBackfill', targetId: created.id, summary: { formId: input.formId, since: since.toISOString(), jobId: job.id } });
    return updated;
  });
  return { ...backfillView(row), created: true };
}

/** One lead page as an ingestion batch (one record per lead, the form's mapping applied by `metaToIngest`). */
export function backfillBatch(input: {
  leads: unknown[];
  pageId: string;
  formId: string;
  mapping: { fieldMap: unknown; consentMapping: unknown };
  externalBatchId: string;
}): { batch: IngestBatchInput | null; skipped: number } {
  const records: IngestBatchInput['records'] = [];
  let consent: IngestBatchInput['mapping'];
  let skipped = 0;
  for (const raw of input.leads) {
    const lead = parseGraphLead(raw);
    if (!lead) {
      skipped += 1;
      continue;
    }
    const createdUnix = Math.floor(new Date(lead.created_time.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime() / 1000);
    const change: MetaLeadgenChange = { leadgen_id: lead.id, page_id: input.pageId, form_id: input.formId, created_time: Number.isFinite(createdUnix) ? createdUnix : 0, ...(lead.ad_id ? { ad_id: lead.ad_id } : {}) };
    const event = metaLeadEventSchema.safeParse({ change, lead });
    if (!event.success) {
      skipped += 1;
      continue;
    }
    const one = metaToIngest(event.data, input.mapping, { externalBatchId: input.externalBatchId, simulated: false });
    consent = one.mapping;
    records.push(...one.records);
  }
  if (records.length === 0) return { batch: null, skipped };
  return { batch: { source: 'META_ADS', externalBatchId: input.externalBatchId, simulated: false, ...(consent ? { mapping: consent } : {}), records }, skipped };
}

const add = (a: Counts, b: Counts): Counts => ({ received: a.received + b.received, accepted: a.accepted + b.accepted, duplicate: a.duplicate + b.duplicate, review: a.review + b.review, rejected: a.rejected + b.rejected });

export async function runMetaBackfill(job: JobHandlerContext, deps: MetaLeadDeps): Promise<JobResult> {
  const payload = job.job.payload as { backfillId?: unknown } | null;
  const backfillId = typeof payload?.backfillId === 'string' ? payload.backfillId : null;
  const workspaceId = job.job.workspaceId;
  if (!backfillId || workspaceId === null) return { outcome: 'dead', reason: 'INVALID_PAYLOAD', errorCode: 'INVALID_PAYLOAD', error: 'meta.lead.backfill payload is not { backfillId }' };
  const run = await job.db.metaLeadBackfill.findFirst({ where: { id: backfillId, workspaceId } });
  if (!run) return { outcome: 'dead', reason: 'NOT_FOUND', errorCode: 'NOT_FOUND', error: `no backfill ${backfillId} in the job's workspace` };
  if (run.status === 'COMPLETED' || run.status === 'FAILED') return { outcome: 'succeeded' };

  const ctx = getJobContext({ id: job.job.id, workspaceId, correlationId: job.correlationId }, { prisma: job.db, mode: deps.mode, clock: job.clock });
  const integration = { id: run.integrationId, workspaceId };
  const finish = (status: 'COMPLETED' | 'FAILED', extra: { errorCode?: string; error?: string; truncated?: boolean } = {}): FinalTx => async (tx: TxClient) => {
    const now = job.clock.now();
    const updated = await tx.metaLeadBackfill.updateMany({
      where: { id: run.id, workspaceId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status, completedAt: now, errorCode: extra.errorCode ?? null, errorRedacted: extra.error ? extra.error.slice(0, MAX_ERROR) : null, ...(extra.truncated !== undefined ? { truncated: extra.truncated } : {}) },
    });
    if (updated.count !== 1) return;
    const current = await tx.metaLeadBackfill.findFirst({ where: { id: run.id, workspaceId }, select: { pages: true, fetched: true, counts: true } });
    await recordAudit(tx, ctx, {
      action: 'meta.backfill.run',
      targetType: 'MetaLeadBackfill',
      targetId: run.id,
      result: status === 'COMPLETED' ? 'SUCCESS' : 'FAILED',
      summary: { formId: run.formId, status, pages: current?.pages ?? 0, fetched: current?.fetched ?? 0, counts: countsOf(current?.counts) ?? ZERO, errorCode: extra.errorCode ?? null },
    });
  };

  if (deps.mode !== 'live') return { outcome: 'succeeded', finalTx: finish('FAILED', { errorCode: 'LIVE_ONLY', error: 'DEMO never contacts Meta.' }) };
  const mapping = await job.db.metaFormMapping.findFirst({ where: { workspaceId, integrationId: run.integrationId, formId: run.formId } });
  if (!mapping) return { outcome: 'succeeded', finalTx: finish('FAILED', { errorCode: 'MAPPING_NOT_FOUND', error: `Form ${run.formId} has no field mapping any more.` }) };
  const use = await loadIntegrationForUse(ctx.db, 'META_ADS', deps.keyRing);
  if (!use || use.id !== run.integrationId) return { outcome: 'succeeded', finalTx: finish('FAILED', { errorCode: 'INTEGRATION_NOT_CONFIGURED', error: 'The Meta Lead Ads integration is no longer stored.' }) };
  const pageId = typeof use.config.pageId === 'string' ? use.config.pageId : null;
  const client = metaLeadsClient({ mode: deps.mode, integration: use, graphVersion: deps.graphVersion, marketingVersion: deps.marketingVersion ?? null, clock: job.clock, usable: CHECKABLE_STATUSES, ...(deps.graph ? { graph: deps.graph } : {}) });
  if (!client.ok || !pageId) {
    const reason = client.ok ? 'the Page ID is not set' : client.reason;
    const code = !client.ok && client.code === 'CREDENTIAL_UNREADABLE' ? 'CREDENTIAL_UNREADABLE' : 'INTEGRATION_NOT_CONFIGURED';
    return {
      outcome: 'dead',
      reason: code,
      errorCode: code,
      error: reason,
      finalTx: async (tx) => {
        if (code === 'CREDENTIAL_UNREADABLE') await recordMetaAccessProblem(tx, ctx, integration, { code, message: reason, field: !client.ok ? (client.field ?? null) : null }, 'meta.lead.backfill');
        await finish('FAILED', { errorCode: code, error: `The leads cannot be read: ${reason}.` })(tx);
      },
    };
  }

  await job.fencedTx((tx) => tx.metaLeadBackfill.updateMany({ where: { id: run.id, workspaceId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'RUNNING', pages: 0, fetched: 0, counts: ZERO } }));
  const sinceUnix = Math.floor(run.since.getTime() / 1000);
  let after: string | null = null;
  let counts: Counts = ZERO;
  let fetched = 0;
  for (let page = 1; page <= BACKFILL_MAX_PAGES; page += 1) {
    const res = await client.value.listFormLeads(run.formId, { sinceUnix, after });
    if (job.signal.aborted) throw new LeaseLostError(job.job.id);
    if (!res.ok) {
      const f = classifyMetaFailure(res, 'leads_retrieval');
      if (f.code === 'PROVIDER_AUTH' || f.code === 'PERMISSION_MISSING') {
        const code = f.code;
        return {
          outcome: 'dead',
          reason: code,
          errorCode: code,
          error: f.message,
          finalTx: async (tx) => {
            await recordMetaAccessProblem(tx, ctx, integration, { code, message: f.message, permission: f.permission }, 'meta.lead.backfill');
            await finish('FAILED', { errorCode: code, error: f.message })(tx);
          },
        };
      }
      if (f.code === 'PROVIDER_RATE_LIMITED' || f.code === 'PROVIDER_UNAVAILABLE' || f.code === 'PROVIDER_UNREACHABLE') {
        const last = job.job.attempts >= job.job.maxAttempts;
        return {
          outcome: 'retry',
          errorCode: f.code,
          error: f.message,
          retryAfterMs: metaBackoffMs(job.job.attempts, f.retryAfterMs),
          finalTx: last
            ? finish('FAILED', { errorCode: f.code, error: f.message })
            : async (tx) => {
                await tx.metaLeadBackfill.updateMany({ where: { id: run.id, workspaceId, status: 'RUNNING' }, data: { errorCode: f.code, errorRedacted: `Waiting to retry: ${f.message}`.slice(0, MAX_ERROR) } });
              },
        };
      }
      const code = f.code === 'NOT_FOUND' ? 'CONFIG_INVALID' : f.code;
      return { outcome: 'succeeded', finalTx: finish('FAILED', { errorCode: code, error: f.code === 'NOT_FOUND' ? `Meta did not find form ${run.formId} for this token. ${f.message}` : f.message }) };
    }
    fetched += res.data.data.length;
    try {
      const { batch } = backfillBatch({ leads: res.data.data, pageId, formId: run.formId, mapping, externalBatchId: `meta-backfill:${run.id}:a${job.job.attempts}:p${page}` });
      if (batch) {
        const ingested = await ingestBatch(ctx, batch, { contactKeyPepper: deps.contactKeyPepper });
        counts = add(counts, ingested.counts);
      }
    } catch (error) {
      if (error instanceof PayloadMappingError) return { outcome: 'succeeded', finalTx: finish('FAILED', { errorCode: error.code, error: error.message }) };
      throw error;
    }
    const snapshot = { pages: page, fetched, counts };
    await job.fencedTx((tx) => tx.metaLeadBackfill.updateMany({ where: { id: run.id, workspaceId, status: 'RUNNING' }, data: { pages: snapshot.pages, fetched: snapshot.fetched, counts: snapshot.counts as Prisma.InputJsonValue, errorCode: null, errorRedacted: null } }));
    if (res.data.after === null) return { outcome: 'succeeded', finalTx: finish('COMPLETED', { truncated: false }) };
    after = res.data.after;
  }
  return { outcome: 'succeeded', finalTx: finish('COMPLETED', { truncated: true }) };
}

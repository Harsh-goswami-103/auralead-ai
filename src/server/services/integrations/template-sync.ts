/**
 * Live WhatsApp template sync and template mapping (T32; ADR-17, P12, plan §5.5, §7 check 7).
 *
 * Sync (`LIVE_TEMPLATE_SYNC` through `liveTemplateSync(deps)`, and the `wa.templateSync` job):
 *  1. Outside any transaction, GET /<waba id>/message_templates page by page (100 per page, at most
 *     20 pages, cursor `after` only: the `next` URL in an answer is never followed).
 *  2. In one transaction, upsert every template by (integration, name, language): the provider's
 *     status, category and components stored exactly as returned (raw strings, never enums), a
 *     category change appended to `categoryHistory`, the variable schema derived from the body,
 *     and the mapping pruned to the positions and buttons the template still has. A template the
 *     provider no longer lists is left unchanged and counted as missing (the provider refuses a
 *     send to it: 132001 TEMPLATE_NOT_FOUND). A new template starts unmapped, with quick-reply
 *     intents proposed from the button texts.
 * A status other than APPROVED (PAUSED, REJECTED, ...) makes the eligibility check refuse every
 * queued send that uses the template (TEMPLATE_NOT_APPROVED) at its next preflight.
 *
 * Quota safety: one manual sync per integration per minute (429 with Retry-After), a page cap,
 * and a provider throttle stops the sync without storing a partial "missing" count.
 *
 * Mapping (`saveTemplateMapping`, DEMO and LIVE alike, no provider): a person maps a template to a
 * send intent (FIRST_TOUCH, QUOTE_READY, FOLLOW_UP, CALL_ACK), says what each positional variable
 * holds, and maps each quick-reply button to QUOTE, CALL or STOP. At send time each mapped button
 * carries its stable payload id (ADR-62), set per send by `quickReplyPayloadsFor`.
 *
 * Authored templates (ADR-123, slice F4): a template written in the studio is matched by name and
 * language like any other, and the sync stores its provider id, status, category and rejection
 * reason (`rejected_reason`, when the list carries it). Local rows are never counted as missing: a
 * DRAFT is never touched (a provider template with the same name and language is left unstored and
 * counted as a draft conflict), and a SUBMITTING row is updated when the provider lists it. A
 * SUBMITTING row the complete list does not contain, submitted at least a minute ago and with no
 * submission job still queued or running, was never created: it goes back to DRAFT, audited
 * `template.submit` FAILED NOT_FOUND_AFTER_SUBMIT, so the person can submit it again (never a
 * blind resubmission by the app).
 */
import type { Prisma, TemplateIntent } from '@/generated/prisma/client';
import { parseTemplateMapping, pruneMapping, templateShape, variableSchemaOf, type QuickReplyIntentValue, type TemplateMapping } from '@/lib/domain/whatsapp-templates';
import { isLocalTemplateStatus, TEMPLATE_DRAFT_STATUS, TEMPLATE_SUBMITTING_STATUS } from '@/lib/domain/lead-gen';
import { DomainRuleError, NotFoundError, ProviderRejectedError, RateLimitedError, ValidationError } from '@/lib/errors';
import { redactText } from '@/lib/redact';
import type { TemplateMappingBody } from '@/lib/schemas/integrations';
import { whatsAppGraphClient } from '@/server/adapters/registry';
import { classifyGraphReadFailure, describeGraphFailure, type CloudApiClient } from '@/server/adapters/whatsapp/cloud-api';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { recordAudit, type AuditCtx, type AuditDb } from '@/server/services/audit/record';
import { BUTTON_TEXT_FALLBACK, foldKeyword, QUICK_REPLY_PAYLOADS, STOP_KEYWORDS } from '@/server/services/messaging/quick-replies';
import { loadIntegrationForUse } from './credentials';
import { SUBMIT_RESOLVE_AFTER_MS, TEMPLATE_SUBMIT_JOB, templateSubmitJobKeyPrefix } from './template-jobs';
import type { LiveAdapterDeps } from './live-testers';
import type { IntegrationForAdapter, LiveTemplateSync, TemplateSyncResult } from './types';

export const TEMPLATE_SYNC_PAGE_SIZE = 100;
export const TEMPLATE_SYNC_MAX_PAGES = 20;
export const TEMPLATE_SYNC_COOLDOWN_MS = 60_000;
const MAX_STATUS_CHANGES_AUDITED = 50;
const MAX_RAW = 64;

export type FetchedTemplate = {
  providerId: string | null;
  name: string;
  language: string;
  status: string;
  category: string;
  components: Prisma.InputJsonValue;
  /** Meta's `rejected_reason` (raw); undefined when the list did not carry the field, null for none. */
  rejectedReason?: string | null;
};

export type TemplateFetch =
  | { ok: true; templates: FetchedTemplate[]; complete: boolean }
  | { ok: false; errorCode: 'PROVIDER_AUTH' | 'PERMISSION_MISSING' | 'CONFIG_INVALID' | 'PROVIDER_RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_UNREACHABLE' | 'PROVIDER_REJECTED'; error: string };

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const raw = (v: unknown) => (typeof v === 'string' ? v.slice(0, MAX_RAW) : null);

/** One template from the provider's list, or null when it lacks the documented identity fields. */
export function parseProviderTemplate(value: unknown): FetchedTemplate | null {
  const t = record(value);
  const name = raw(t.name);
  const language = raw(t.language);
  const status = raw(t.status);
  const category = raw(t.category);
  if (!name || !language || status === null || category === null) return null;
  const reasonRaw = t.rejected_reason;
  const reason = reasonRaw === undefined ? undefined : typeof reasonRaw === 'string' && reasonRaw.trim() !== '' && reasonRaw.trim().toUpperCase() !== 'NONE' ? reasonRaw.slice(0, 300) : null;
  return {
    providerId: raw(t.id),
    name,
    language,
    status,
    category,
    components: (Array.isArray(t.components) ? t.components : []) as Prisma.InputJsonValue,
    ...(reason !== undefined ? { rejectedReason: reason } : {}),
  };
}

const FAILURE_CODES = {
  auth: 'PROVIDER_AUTH',
  permission: 'PERMISSION_MISSING',
  'not-found': 'CONFIG_INVALID',
  'rate-limited': 'PROVIDER_RATE_LIMITED',
  unavailable: 'PROVIDER_UNAVAILABLE',
  unreachable: 'PROVIDER_UNREACHABLE',
  rejected: 'PROVIDER_REJECTED',
} as const;

/** Reads every template of the WABA (bounded). `complete` is false when the page cap was reached. */
export async function fetchWabaTemplates(client: CloudApiClient): Promise<TemplateFetch> {
  const templates: FetchedTemplate[] = [];
  let after: string | null = null;
  for (let page = 0; page < TEMPLATE_SYNC_MAX_PAGES; page += 1) {
    const res = await client.listTemplates({ after, limit: TEMPLATE_SYNC_PAGE_SIZE });
    if (!res.ok) return { ok: false, errorCode: FAILURE_CODES[classifyGraphReadFailure(res)], error: describeGraphFailure(res) };
    for (const item of res.data.data) {
      const parsed = parseProviderTemplate(item);
      if (parsed) templates.push(parsed);
    }
    if (res.data.after === null) return { ok: true, templates, complete: true };
    after = res.data.after;
  }
  return { ok: true, templates, complete: false };
}

const QUICK_REPLY_TEXTS: ReadonlyMap<string, QuickReplyIntentValue> = new Map<string, QuickReplyIntentValue>([
  ...Object.entries(BUTTON_TEXT_FALLBACK).map(([text, intent]) => [foldKeyword(text), intent] as [string, QuickReplyIntentValue]),
  ...STOP_KEYWORDS.map((k) => [foldKeyword(k), 'STOP'] as [string, QuickReplyIntentValue]),
  ['send the quotation', 'QUOTE'],
  ['send quotation', 'QUOTE'],
  ['request a call', 'CALL'],
]);

/** A proposed intent for a quick-reply button text (a person confirms it on the mapping form). */
export function suggestQuickReplyIntent(text: string): QuickReplyIntentValue | null {
  return QUICK_REPLY_TEXTS.get(foldKeyword(text)) ?? null;
}

type StoredTemplate = {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: unknown;
  variableMap: unknown;
  categoryHistory: unknown;
  providerTemplateId: string | null;
  rejectedReason: string | null;
  submittedAt: Date | null;
};

type TemplateDb = AuditDb & {
  whatsAppTemplate: {
    findMany(args: {
      where: { workspaceId: string; integrationId: string };
      select: { id: true; name: true; language: true; status: true; category: true; components: true; variableMap: true; categoryHistory: true; providerTemplateId: true; rejectedReason: true; submittedAt: true };
    }): PromiseLike<StoredTemplate[]>;
    create(args: { data: Prisma.WhatsAppTemplateUncheckedCreateInput }): PromiseLike<unknown>;
    updateMany(args: { where: { id: string; workspaceId: string; status?: string }; data: Prisma.WhatsAppTemplateUpdateManyMutationInput }): PromiseLike<{ count: number }>;
  };
  job: { count(args: { where: { workspaceId: string; type: string; status: { in: Array<'QUEUED' | 'RUNNING'> }; idempotencyKey: { startsWith: string } } }): PromiseLike<number> };
};

export type AppliedSync = TemplateSyncResult & {
  statusChanges: Array<{ name: string; language: string; from: string; to: string }>;
  /** Provider templates whose name and language a local DRAFT holds (left unstored, the draft untouched). */
  draftConflicts: number;
  /** SUBMITTING rows the provider never created, set back to DRAFT. */
  submitsUnconfirmed: number;
};

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Stores a fetched template list inside the caller's transaction (scoped or raw: every query names
 * the workspace). Writes the `integration.templates.sync` audit row.
 */
export async function applyTemplateSync(
  tx: TemplateDb,
  ctx: AuditCtx,
  integration: { id: string; workspaceId: string },
  fetched: { templates: FetchedTemplate[]; complete: boolean },
  opts: { trigger: 'manual' | 'scheduled' },
): Promise<AppliedSync> {
  const now = ctx.clock.now();
  const stored = await tx.whatsAppTemplate.findMany({
    where: { workspaceId: integration.workspaceId, integrationId: integration.id },
    select: { id: true, name: true, language: true, status: true, category: true, components: true, variableMap: true, categoryHistory: true, providerTemplateId: true, rejectedReason: true, submittedAt: true },
  });
  const byKey = new Map(stored.map((t) => [`${t.name}\u0000${t.language}`, t]));
  const seen = new Set<string>();
  let created = 0;
  let updated = 0;
  let existing = 0;
  let draftConflicts = 0;
  const statusChanges: AppliedSync['statusChanges'] = [];

  for (const t of fetched.templates) {
    const key = `${t.name}\u0000${t.language}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const shape = templateShape(t.components);
    const row = byKey.get(key);
    if (!row) {
      const buttons: TemplateMapping['buttons'] = {};
      for (const q of shape.quickReplies) {
        const intent = suggestQuickReplyIntent(q.text);
        if (intent) buttons[String(q.index)] = intent;
      }
      const mapping: TemplateMapping = { body: {}, buttons };
      await tx.whatsAppTemplate.create({
        data: {
          workspaceId: integration.workspaceId,
          integrationId: integration.id,
          name: t.name,
          language: t.language,
          category: t.category,
          status: t.status,
          components: t.components,
          variableSchema: variableSchemaOf(shape, mapping),
          intent: null,
          variableMap: mapping,
          categoryHistory: [{ category: t.category, at: now.toISOString() }],
          providerTemplateId: t.providerId,
          rejectedReason: t.status.trim().toUpperCase() === 'REJECTED' ? (t.rejectedReason ?? null) : null,
          syncedAt: now,
        },
      });
      created += 1;
      continue;
    }
    // A local draft is the person's unsent work: never overwritten by a provider template of the same name.
    if (row.status.trim().toUpperCase() === TEMPLATE_DRAFT_STATUS) {
      draftConflicts += 1;
      continue;
    }
    const rejectedReason = t.status.trim().toUpperCase() !== 'REJECTED' ? null : t.rejectedReason === undefined ? row.rejectedReason : t.rejectedReason;
    const providerTemplateId = t.providerId ?? row.providerTemplateId;
    const changed =
      row.status !== t.status || row.category !== t.category || !sameJson(row.components, t.components) || rejectedReason !== row.rejectedReason || providerTemplateId !== row.providerTemplateId;
    const mapping = pruneMapping(parseTemplateMapping(row.variableMap), shape);
    const history = Array.isArray(row.categoryHistory) ? [...(row.categoryHistory as Prisma.InputJsonValue[])] : [];
    if (row.category !== t.category) history.push({ category: t.category, at: now.toISOString() });
    if (row.status !== t.status && statusChanges.length < MAX_STATUS_CHANGES_AUDITED) statusChanges.push({ name: t.name, language: t.language, from: row.status, to: t.status });
    await tx.whatsAppTemplate.updateMany({
      where: { id: row.id, workspaceId: integration.workspaceId },
      data: changed
        ? { status: t.status, category: t.category, components: t.components, variableSchema: variableSchemaOf(shape, mapping), variableMap: mapping, categoryHistory: history, providerTemplateId, rejectedReason, syncedAt: now }
        : { syncedAt: now },
    });
    if (changed) updated += 1;
    else existing += 1;
  }
  const unseen = fetched.complete ? stored.filter((s) => !seen.has(`${s.name}\u0000${s.language}`)) : [];
  // DRAFT and SUBMITTING rows are local: never missing (ADR-123).
  const missing = unseen.filter((s) => !isLocalTemplateStatus(s.status)).length;
  const submitsUnconfirmed = await resolveUnconfirmedSubmits(tx, ctx, integration, unseen, now);

  await recordAudit(tx, ctx, {
    action: 'integration.templates.sync',
    targetType: 'Integration',
    targetId: integration.id,
    workspaceId: integration.workspaceId,
    summary: { kind: 'WHATSAPP_CLOUD', outcome: 'SYNCED', created, updated, existing, missing, complete: fetched.complete, statusChanges, draftConflicts, submitsUnconfirmed, trigger: opts.trigger },
  });
  return { integrationId: integration.id, simulated: false, created, updated, existing, missing, statusChanges, draftConflicts, submitsUnconfirmed };
}

/**
 * SUBMITTING rows that a complete provider list does not contain: when the submission is at least
 * SUBMIT_RESOLVE_AFTER_MS old and no `wa.templateSubmit` job for it is still queued or running,
 * Meta never created the template, so the row goes back to DRAFT (audited FAILED). Returns the count.
 */
async function resolveUnconfirmedSubmits(tx: TemplateDb, ctx: AuditCtx, integration: { id: string; workspaceId: string }, unseen: readonly StoredTemplate[], now: Date): Promise<number> {
  let resolved = 0;
  for (const row of unseen) {
    if (row.status.trim().toUpperCase() !== TEMPLATE_SUBMITTING_STATUS) continue;
    if (row.submittedAt === null || now.getTime() - row.submittedAt.getTime() < SUBMIT_RESOLVE_AFTER_MS) continue;
    const inFlight = await tx.job.count({
      where: { workspaceId: integration.workspaceId, type: TEMPLATE_SUBMIT_JOB, status: { in: ['QUEUED', 'RUNNING'] }, idempotencyKey: { startsWith: templateSubmitJobKeyPrefix(row.id) } },
    });
    if (inFlight > 0) continue;
    const moved = await tx.whatsAppTemplate.updateMany({ where: { id: row.id, workspaceId: integration.workspaceId, status: row.status }, data: { status: TEMPLATE_DRAFT_STATUS } });
    if (moved.count !== 1) continue;
    resolved += 1;
    await recordAudit(tx, ctx, {
      action: 'template.submit',
      targetType: 'WhatsAppTemplate',
      targetId: row.id,
      workspaceId: integration.workspaceId,
      result: 'FAILED',
      summary: { template: row.name, language: row.language, outcome: 'NOT_CREATED', errorCode: 'NOT_FOUND_AFTER_SUBMIT' },
    });
  }
  return resolved;
}

/** Records a failed live sync (its own small transaction). */
export async function recordTemplateSyncFailure(tx: AuditDb, ctx: AuditCtx, integration: { id: string; workspaceId: string }, failure: { errorCode: string; error: string }, trigger: 'manual' | 'scheduled'): Promise<void> {
  await recordAudit(tx, ctx, {
    action: 'integration.templates.sync',
    targetType: 'Integration',
    targetId: integration.id,
    workspaceId: integration.workspaceId,
    result: 'FAILED',
    summary: { kind: 'WHATSAPP_CLOUD', outcome: 'FAILED', errorCode: failure.errorCode, error: redactText(failure.error).slice(0, 300), trigger },
  });
}

/** Loads, decrypts and fetches (no transaction). */
export async function fetchTemplatesForIntegration(ctx: AppCtx, deps: LiveAdapterDeps): Promise<{ ok: true; fetch: TemplateFetch } | { ok: false; code: string; reason: string }> {
  const use = await loadIntegrationForUse(ctx.db, 'WHATSAPP_CLOUD', deps.keyRing);
  const client = whatsAppGraphClient({ mode: ctx.mode, integration: use, graphVersion: deps.graphVersion, clock: ctx.clock, graph: deps.graph });
  if (!client.ok) return { ok: false, code: client.code, reason: client.reason };
  if (client.value.wabaId === null) return { ok: false, code: 'INTEGRATION_NOT_CONFIGURED', reason: 'the WhatsApp Business Account ID is not set' };
  return { ok: true, fetch: await fetchWabaTemplates(client.value) };
}

/** The live sync behind "Sync templates" (LIVE_TEMPLATE_SYNC). */
export function liveTemplateSync(deps: LiveAdapterDeps): LiveTemplateSync {
  return async (ctx: AppCtx, integration: IntegrationForAdapter): Promise<TemplateSyncResult> => {
    const workspaceId = requireWorkspace(ctx);
    const now = ctx.clock.now();
    const last = await ctx.db.auditEvent.findFirst({
      where: { action: 'integration.templates.sync', targetType: 'Integration', targetId: integration.id, createdAt: { gt: new Date(now.getTime() - TEMPLATE_SYNC_COOLDOWN_MS) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (last) {
      const wait = Math.max(1, Math.ceil((last.createdAt.getTime() + TEMPLATE_SYNC_COOLDOWN_MS - now.getTime()) / 1000));
      throw new RateLimitedError({ code: 'TEMPLATE_SYNC_TOO_SOON', userMessage: `Templates were synced less than a minute ago. Try again in ${wait} seconds.`, retryAfterSeconds: wait });
    }
    const fetched = await fetchTemplatesForIntegration(ctx, deps);
    if (!fetched.ok) {
      throw new DomainRuleError({ code: fetched.code === 'CREDENTIAL_UNREADABLE' ? 'CREDENTIAL_UNREADABLE' : 'INTEGRATION_NOT_CONFIGURED', userMessage: `Templates cannot be synced: ${fetched.reason}.` });
    }
    if (!fetched.fetch.ok) {
      const failure = fetched.fetch;
      await withTx(ctx.db, (tx) => recordTemplateSyncFailure(tx, ctx, { id: integration.id, workspaceId }, failure, 'manual'));
      throw new ProviderRejectedError({ provider: 'whatsapp', code: 'TEMPLATE_SYNC_FAILED', message: failure.error, userMessage: `WhatsApp Manager did not return the templates (${failure.errorCode}). Nothing was changed.` });
    }
    const list = fetched.fetch;
    const applied = await withTx(ctx.db, (tx) => applyTemplateSync(tx as unknown as TemplateDb, ctx, { id: integration.id, workspaceId }, list, { trigger: 'manual' }));
    return { integrationId: applied.integrationId, simulated: false, created: applied.created, existing: applied.existing, updated: applied.updated, missing: applied.missing };
  };
}

// ---- Mapping (P12) ---------------------------------------------------------------------------------

export type TemplateMappingResult = { templateId: string; intent: TemplateIntent | null; mapping: TemplateMapping };

export async function saveTemplateMapping(ctx: AppCtx, input: { templateId: string } & Pick<TemplateMappingBody, 'intent' | 'variables' | 'buttons'>): Promise<TemplateMappingResult> {
  requireCapability(ctx, 'integrations.manage');
  const workspaceId = requireWorkspace(ctx);
  return withTx(ctx.db, async (tx) => {
    const t = await tx.whatsAppTemplate.findFirst({ where: { id: input.templateId }, select: { id: true, name: true, components: true, intent: true, variableMap: true } });
    if (!t) throw new NotFoundError();
    const shape = templateShape(t.components);
    const positions = new Set(shape.bodyVariables);
    const indexes = new Set(shape.quickReplies.map((q) => String(q.index)));
    const bad = [
      ...Object.keys(input.variables).filter((k) => !positions.has(String(Number(k)))).map((k) => `variable {{${k}}}`),
      ...Object.keys(input.buttons).filter((k) => !indexes.has(String(Number(k)))).map((k) => `button ${k}`),
    ];
    if (bad.length > 0) {
      throw new ValidationError({ code: 'TEMPLATE_MAPPING_INVALID', userMessage: `This template has no ${bad.join(', ')}. Sync templates and try again.`, safeDetails: { unknown: bad } });
    }
    const mapping: TemplateMapping = {
      body: Object.fromEntries(Object.entries(input.variables).map(([k, v]) => [String(Number(k)), v])),
      buttons: Object.fromEntries(Object.entries(input.buttons).map(([k, v]) => [String(Number(k)), v])),
    };
    await tx.whatsAppTemplate.update({ where: { id: t.id }, data: { intent: input.intent, variableMap: mapping, variableSchema: variableSchemaOf(shape, mapping) } });
    await recordAudit(tx, ctx, {
      action: 'integration.template.map',
      targetType: 'WhatsAppTemplate',
      targetId: t.id,
      workspaceId,
      simulated: ctx.mode === 'demo',
      summary: { template: t.name, intent: input.intent, previousIntent: t.intent, variables: Object.keys(mapping.body).length, buttons: mapping.buttons },
    });
    return { templateId: t.id, intent: input.intent, mapping };
  });
}

/** The quick-reply payload ids a send of this template carries, by button index (ADR-62). */
export function quickReplyPayloadsFor(template: { components: unknown; variableMap: unknown }): Array<{ index: number; payload: string }> {
  const shape = templateShape(template.components);
  const mapping = parseTemplateMapping(template.variableMap);
  return shape.quickReplies.flatMap((q) => {
    const intent = mapping.buttons[String(q.index)];
    return intent ? [{ index: q.index, payload: QUICK_REPLY_PAYLOADS[intent] }] : [];
  });
}

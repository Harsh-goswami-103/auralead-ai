/**
 * The template studio (ADR-123, slice F4): write WhatsApp templates here, submit them to Meta, and
 * see Meta's verdict.
 *
 * Drafts (`createTemplateDraft`, `updateTemplateDraft`, `deleteTemplate`; `templates.manage`): a
 * draft is a `WhatsAppTemplate` row with origin AUTHORED and status DRAFT (never sendable: only
 * APPROVED is), hanging off the workspace's WHATSAPP_CLOUD integration like every synced template
 * (DEMO creates the SIMULATED integration when absent; LIVE needs a stored one). It stores Meta's
 * create-template components (with examples), the variable schema (source and example per body
 * position), the mapping (body sources for per-lead resolution, quick-reply intents with the STOP
 * payload on the Stop button), the UTILITY trigger and the copy's generator. The rules are
 * `checkTemplateDraft` (src/lib/domain/template-authoring.ts): errors are 422 TEMPLATE_INVALID,
 * warnings are returned. Names are unique per integration and language (409 TEMPLATE_NAME_TAKEN).
 * A DRAFT is deleted locally; an authored template Meta REJECTED is deleted at Meta first in LIVE
 * (`DELETE message_templates?name=`), then locally.
 *
 * Submission (`submitTemplate`, rate limit `templateSubmit` on the route):
 *  - DEMO: the simulated WhatsApp Manager (template-admin-demo.ts) accepts it: PENDING with a
 *    simulated id, and a `wa.templateReview` job 30 s later approves it, or rejects a name
 *    containing `reject` with a reason (`runTemplateReview`). Audited simulated; zero network.
 *  - LIVE: the integration must be verified (CONNECTED or DEGRADED) with a WABA ID, else 422
 *    INTEGRATION_NOT_CONFIGURED and nothing changes. The row moves DRAFT -> SUBMITTING with a
 *    `wa.templateSubmit` job (`runTemplateSubmit`), which calls Meta outside any transaction:
 *      - created: the provider id and Meta's status (PENDING) and category are stored, and a
 *        `wa.templateSync` keyed `wa.templateSync:<integrationId>:submit:<templateId>:<time>` runs
 *        60 s later;
 *      - a timeout after the write, a 5xx, a 2xx without an id, or "name already exists": the row
 *        stays SUBMITTING and that sync resolves it by name and language (template-sync.ts), never a
 *        blind retry; a job run that finds a previous attempt (a crash during the call) does the same;
 *      - a definite refusal or a failure before the write: back to DRAFT with the reason audited
 *        (`template.submit` FAILED), so the person can fix it and submit again.
 * A DOCUMENT header (P1) is a PDF brochure from the media library (media-assets.ts): its bytes are
 * checked against the stored hash and uploaded for the header sample (DEMO: a simulated handle;
 * LIVE: the resumable upload, which needs the WHATSAPP_CLOUD config `appId`, else 422 before
 * anything changes), and the handle goes into the header's example. An upload that fails changes
 * nothing at Meta, so the template goes back to DRAFT with the reason.
 * Consent is unchanged: every category needs OPT_IN + MARKETING to be sent (eligibility).
 */
import type { IntegrationStatus, Prisma } from '@/generated/prisma/client';
import { TEMPLATE_DRAFT_STATUS, TEMPLATE_SUBMITTING_STATUS } from '@/lib/domain/lead-gen';
import {
  authoredVariableSchema,
  checkTemplateDraft,
  draftFromStored,
  templateComponentsOf,
  templateMappingOf,
  type DraftIssue,
  type TemplateDraft,
} from '@/lib/domain/template-authoring';
import { NOT_SENDABLE_LABELS, templateShape } from '@/lib/domain/whatsapp-templates';
import { ConflictError, DomainRuleError, NotFoundError, ProviderRejectedError } from '@/lib/errors';
import { redactText } from '@/lib/redact';
import type { COPY_GENERATOR_LABELS } from '@/lib/schemas/templates';
import { USABLE_AI_STATUSES } from '@/server/adapters/ai/registry';
import { SEND_USABLE_STATUSES, whatsAppTemplateAdmin, type GraphSeams, type Resolution, type TemplateAdmin } from '@/server/adapters/registry';
import { classifyTemplateCreateFailure, TEMPLATE_SUBMIT_FAILURE_LABELS } from '@/server/adapters/whatsapp/template-admin';
import { DEMO_TEMPLATE_REVIEW_DELAY_MS } from '@/server/adapters/whatsapp/template-admin-demo';
import { getJobContext, type AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { LeaseLostError } from '@/server/db/fence';
import { assertSameWorkspace } from '@/server/db/scoped';
import { withTx } from '@/server/db/tx';
import { enqueueJob, type JobStore } from '@/server/jobs/queue';
import type { JobHandlerContext, JobResult, TxClient } from '@/server/jobs/types';
import type { KeyRing } from '@/server/security/secrets';
import { recordAudit } from '@/server/services/audit/record';
import { loadIntegrationForUse } from './credentials';
import { listMediaAssets, readMediaAssetFile, type MediaAssetView, type StoredMedia } from './media-assets';
import { INTEGRATION_SCHEDULE_PAYLOAD_VERSION, WA_TEMPLATE_SYNC_JOB } from './schedules';
import { submitSyncJobKey, SUBMIT_SYNC_DELAY_MS, TEMPLATE_JOB_PAYLOAD_VERSION, TEMPLATE_REVIEW_JOB, TEMPLATE_SUBMIT_JOB, templateReviewJobKey, templateSubmitJobKey } from './template-jobs';

export type TemplateStudioDeps = {
  keyRing: KeyRing | null;
  /** META_GRAPH_VERSION; null means WhatsApp cannot reach Meta from this server. */
  graphVersion: string | null;
  storageDir: string;
  graph?: GraphSeams;
};

export type CopyGeneratorLabel = (typeof COPY_GENERATOR_LABELS)[number];

const MAX_ERROR = 300;
const SUBMIT_AUDIT_LIMIT = 200;

// ---- Read model ------------------------------------------------------------------------------------

export type StudioTemplateView = {
  id: string;
  name: string;
  language: string;
  /** Raw provider strings for synced templates; the chosen category for authored ones. */
  category: string;
  status: string;
  origin: 'SYNCED' | 'AUTHORED';
  rejectedReason: string | null;
  utilityTrigger: string | null;
  copyGeneratorLabel: string | null;
  submittedAt: string | null;
  syncedAt: string | null;
  /** The template lives on the SIMULATED (DEMO) integration. */
  simulated: boolean;
  headerFormat: string | null;
  body: string;
  variables: string[];
  notSendable: string | null;
  editable: boolean;
  submittable: boolean;
  deletable: boolean;
  /** The authored draft, for editing (null for a synced template). */
  draft: TemplateDraft | null;
  /** The latest submission outcome from the audit trail. */
  lastSubmit: { result: string; outcome: string | null; errorCode: string | null; message: string | null; at: string } | null;
};

export type StudioWhatsApp = {
  integrationId: string | null;
  status: IntegrationStatus | 'NOT_CONFIGURED';
  simulated: boolean;
  /** Drafts can be saved (DEMO always; LIVE once a WhatsApp integration is stored). */
  canDraft: boolean;
  /** Submissions can reach Meta (DEMO simulated; LIVE verified with a WABA ID). */
  canSubmit: boolean;
  /** Why not, in words (LIVE configuration). */
  problem: string | null;
};

export type TemplateStudioView = {
  workspace: { name: string; timezone: string };
  mode: 'demo' | 'live';
  canManage: boolean;
  whatsapp: StudioWhatsApp;
  /** "Generate with AI": DEMO runs the labelled local generator; LIVE needs an AI integration. */
  ai: { local: boolean; available: boolean };
  templates: StudioTemplateView[];
  /** PDF brochures for document headers (P1). */
  media: MediaAssetView[];
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

const isStatus = (status: string, value: string) => status.trim().toUpperCase() === value;

type TemplateRow = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  origin: 'SYNCED' | 'AUTHORED';
  components: unknown;
  variableSchema: unknown;
  variableMap: unknown;
  rejectedReason: string | null;
  utilityTrigger: string | null;
  copyGeneratorLabel: string | null;
  submittedAt: Date | null;
  syncedAt: Date | null;
  headerMediaId: string | null;
  integrationId: string;
};

const templateSelect = {
  id: true,
  name: true,
  language: true,
  category: true,
  status: true,
  origin: true,
  components: true,
  variableSchema: true,
  variableMap: true,
  rejectedReason: true,
  utilityTrigger: true,
  copyGeneratorLabel: true,
  submittedAt: true,
  syncedAt: true,
  headerMediaId: true,
  integrationId: true,
} as const;

/** The words for a recorded submission outcome. */
export function submitOutcomeMessage(summary: Record<string, unknown>): string | null {
  const code = str(summary.errorCode);
  if (code === null) return null;
  const label = TEMPLATE_SUBMIT_FAILURE_LABELS[code] ?? 'The submission did not go through.';
  const detail = str(summary.error);
  return code === 'TEMPLATE_REJECTED_BY_PROVIDER' && detail ? `${label} ${detail}` : label;
}

export function studioTemplateView(t: TemplateRow, opts: { simulated: boolean; lastSubmit: StudioTemplateView['lastSubmit'] }): StudioTemplateView {
  const shape = templateShape(t.components);
  const body = (record((Array.isArray(t.components) ? t.components : []).map(record).find((c) => String(c.type).toUpperCase() === 'BODY')).text as string | undefined) ?? '';
  const authored = t.origin === 'AUTHORED';
  const draft = isStatus(t.status, TEMPLATE_DRAFT_STATUS);
  return {
    id: t.id,
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    origin: t.origin,
    rejectedReason: t.rejectedReason,
    utilityTrigger: t.utilityTrigger,
    copyGeneratorLabel: t.copyGeneratorLabel,
    submittedAt: t.submittedAt?.toISOString() ?? null,
    syncedAt: t.syncedAt?.toISOString() ?? null,
    simulated: opts.simulated,
    headerFormat: shape.headerFormat,
    body,
    variables: shape.bodyVariables,
    notSendable: shape.sendable.ok ? null : NOT_SENDABLE_LABELS[shape.sendable.reason],
    editable: authored && draft,
    submittable: authored && draft,
    deletable: authored && (draft || isStatus(t.status, 'REJECTED')),
    draft: authored ? draftFromStored(t) : null,
    lastSubmit: opts.lastSubmit,
  };
}

async function lastSubmits(ctx: AppCtx, ids: readonly string[]): Promise<Map<string, StudioTemplateView['lastSubmit']>> {
  const out = new Map<string, StudioTemplateView['lastSubmit']>();
  if (ids.length === 0) return out;
  const rows = await ctx.db.auditEvent.findMany({
    where: { action: 'template.submit', targetType: 'WhatsAppTemplate', targetId: { in: [...ids] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: SUBMIT_AUDIT_LIMIT,
    select: { targetId: true, result: true, summary: true, createdAt: true },
  });
  // Newest first; at the same instant an outcome outranks the "queued" request it follows.
  const rank = (summary: unknown) => (str(record(summary).outcome) === 'QUEUED' ? 1 : 0);
  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || rank(a.summary) - rank(b.summary));
  for (const row of rows) {
    if (out.has(row.targetId)) continue;
    const summary = record(row.summary);
    out.set(row.targetId, { result: row.result, outcome: str(summary.outcome), errorCode: str(summary.errorCode), message: submitOutcomeMessage(summary), at: row.createdAt.toISOString() });
  }
  return out;
}

function whatsAppState(mode: 'demo' | 'live', row: { id: string; status: IntegrationStatus; config: unknown } | null, graphVersion: string | null): StudioWhatsApp {
  if (mode === 'demo') return { integrationId: row?.id ?? null, status: row?.status ?? 'NOT_CONFIGURED', simulated: true, canDraft: true, canSubmit: true, problem: null };
  if (!row || row.status === 'SIMULATED') {
    return { integrationId: null, status: 'NOT_CONFIGURED', simulated: false, canDraft: false, canSubmit: false, problem: 'Set up WhatsApp first: templates belong to the WhatsApp Business Account.' };
  }
  const config = record(row.config);
  let problem: string | null = null;
  if (!SEND_USABLE_STATUSES.has(row.status)) problem = 'Connect and verify WhatsApp (Test connection) before submitting templates.';
  else if (str(config.wabaId) === null) problem = 'Add the WhatsApp Business Account ID in the WhatsApp setup before submitting templates.';
  else if (graphVersion === null) problem = 'META_GRAPH_VERSION is not configured on the server, so Meta cannot be reached.';
  return { integrationId: row.id, status: row.status, simulated: false, canDraft: true, canSubmit: problem === null, problem };
}

/** The studio page: every template of the workspace's WhatsApp integration with its state and the available actions. */
export async function getTemplateStudio(ctx: AppCtx, opts: { graphVersion: string | null }): Promise<TemplateStudioView> {
  requireCapability(ctx, 'leads.read');
  const workspaceId = requireWorkspace(ctx);
  const workspace = await ctx.db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true, timezone: true, mode: true } });
  if (!workspace || workspace.mode !== (ctx.mode === 'demo' ? 'DEMO' : 'LIVE')) throw new NotFoundError();
  const integration = await ctx.db.integration.findFirst({ where: { kind: 'WHATSAPP_CLOUD' }, select: { id: true, status: true, config: true } });
  const rows: TemplateRow[] = integration
    ? await ctx.db.whatsAppTemplate.findMany({ where: { integrationId: integration.id }, orderBy: [{ name: 'asc' }, { language: 'asc' }], select: templateSelect })
    : [];
  const submits = await lastSubmits(
    ctx,
    rows.filter((r) => r.origin === 'AUTHORED').map((r) => r.id),
  );
  const simulated = integration?.status === 'SIMULATED';
  const aiAvailable = ctx.mode === 'demo' || (await ctx.db.integration.count({ where: { kind: { in: ['AI_ANTHROPIC', 'AI_OPENAI'] }, status: { in: [...USABLE_AI_STATUSES] as IntegrationStatus[] } } })) > 0;
  const authoredFirst = [...rows].sort((a, b) => Number(b.origin === 'AUTHORED') - Number(a.origin === 'AUTHORED'));
  return {
    workspace: { name: workspace.name, timezone: workspace.timezone },
    mode: ctx.mode,
    canManage: hasCapability(ctx, 'templates.manage'),
    whatsapp: whatsAppState(ctx.mode, integration, opts.graphVersion),
    ai: { local: ctx.mode === 'demo', available: aiAvailable },
    templates: authoredFirst.map((t) => studioTemplateView(t, { simulated, lastSubmit: submits.get(t.id) ?? null })),
    media: await listMediaAssets(ctx),
  };
}

// ---- Drafts ----------------------------------------------------------------------------------------

export type DraftInput = { draft: TemplateDraft; copyGeneratorLabel: CopyGeneratorLabel | null };
export type TemplateMutationResult = { template: StudioTemplateView; warnings: DraftIssue[] };

function invalid(errors: readonly DraftIssue[]): DomainRuleError {
  return new DomainRuleError({
    code: 'TEMPLATE_INVALID',
    userMessage: errors.length === 1 ? errors[0]!.message : `${errors[0]!.message} (${errors.length - 1} more ${errors.length === 2 ? 'problem' : 'problems'} to fix.)`,
    safeDetails: { issues: errors.map((e) => ({ field: e.field, code: e.code })) },
  });
}

async function assertWorkspaceMode(ctx: AppCtx): Promise<string> {
  const workspaceId = requireWorkspace(ctx);
  const ws = await ctx.db.workspace.findUnique({ where: { id: workspaceId }, select: { mode: true } });
  if (!ws || ws.mode !== (ctx.mode === 'demo' ? 'DEMO' : 'LIVE')) throw new NotFoundError({ message: 'workspace mode differs from the process mode' });
  return workspaceId;
}

type Tx = TxClient;

/** The workspace's WhatsApp integration for a draft: DEMO creates the SIMULATED one; LIVE needs a stored one. */
async function draftIntegration(tx: Tx, ctx: AppCtx, workspaceId: string): Promise<{ id: string; simulated: boolean }> {
  const found = await tx.integration.findFirst({ where: { workspaceId, kind: 'WHATSAPP_CLOUD' }, select: { id: true, status: true } });
  if (ctx.mode === 'demo') {
    if (found) return { id: found.id, simulated: true };
    const created = await tx.integration.create({ data: { workspaceId, kind: 'WHATSAPP_CLOUD', status: 'SIMULATED', config: { phoneNumberId: `demo-${workspaceId}` } }, select: { id: true } });
    await recordAudit(tx, ctx, { action: 'integration.simulated.create', targetType: 'Integration', targetId: created.id, simulated: true, summary: { kind: 'WHATSAPP_CLOUD' } });
    return { id: created.id, simulated: true };
  }
  if (!found || found.status === 'SIMULATED') {
    throw new DomainRuleError({ code: 'INTEGRATION_NOT_CONFIGURED', userMessage: 'Set up WhatsApp first: templates belong to the WhatsApp Business Account.' });
  }
  return { id: found.id, simulated: false };
}

function rowData(input: DraftInput): Omit<Prisma.WhatsAppTemplateUncheckedCreateInput, 'workspaceId' | 'integrationId'> {
  const d = input.draft;
  return {
    name: d.name,
    language: d.language,
    category: d.category,
    status: TEMPLATE_DRAFT_STATUS,
    origin: 'AUTHORED',
    components: templateComponentsOf(d) as Prisma.InputJsonValue,
    variableSchema: authoredVariableSchema(d) as unknown as Prisma.InputJsonValue,
    variableMap: templateMappingOf(d) as unknown as Prisma.InputJsonValue,
    categoryHistory: [],
    utilityTrigger: d.category === 'UTILITY' ? d.utilityTrigger : null,
    copyGeneratorLabel: input.copyGeneratorLabel,
    headerMediaId: d.header.format === 'DOCUMENT' ? d.header.mediaId : null,
    rejectedReason: null,
  };
}

function draftSummary(input: DraftInput) {
  const d = input.draft;
  return { template: d.name, language: d.language, category: d.category, header: d.header.format, variables: d.variables.length, buttons: d.buttons.length, generator: input.copyGeneratorLabel };
}

async function assertNameFree(tx: Tx, workspaceId: string, integrationId: string, draft: TemplateDraft, exceptId: string | null): Promise<void> {
  const clash = await tx.whatsAppTemplate.findFirst({ where: { workspaceId, integrationId, name: draft.name, language: draft.language, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
  if (clash) throw new ConflictError({ code: 'TEMPLATE_NAME_TAKEN', userMessage: `A template named ${draft.name} already exists in this language. Choose another name.` });
}

async function assertHeaderMedia(tx: Tx, ctx: AppCtx, draft: TemplateDraft): Promise<void> {
  if (draft.header.format !== 'DOCUMENT' || draft.header.mediaId === null) return;
  await assertSameWorkspace(tx, ctx, { mediaAssetId: draft.header.mediaId });
  const asset = await tx.mediaAsset.findFirst({ where: { id: draft.header.mediaId, workspaceId: ctx.workspaceId! }, select: { kind: true, mimeType: true } });
  if (!asset || asset.kind !== 'DOCUMENT' || asset.mimeType !== 'application/pdf') throw new DomainRuleError({ code: 'TEMPLATE_INVALID', userMessage: 'The document header must be a PDF from the media library.' });
}

async function viewOf(tx: Tx, ctx: AppCtx, id: string, simulated: boolean): Promise<StudioTemplateView> {
  const row = await tx.whatsAppTemplate.findFirstOrThrow({ where: { id, workspaceId: requireWorkspace(ctx) }, select: templateSelect });
  return studioTemplateView(row, { simulated, lastSubmit: null });
}

export async function createTemplateDraft(ctx: AppCtx, input: DraftInput): Promise<TemplateMutationResult> {
  requireCapability(ctx, 'templates.manage');
  const workspaceId = await assertWorkspaceMode(ctx);
  const check = checkTemplateDraft(input.draft, { forSubmit: false });
  if (!check.ok) throw invalid(check.errors);
  const template = await withTx(ctx.db, async (scoped) => {
    const tx = scoped as unknown as Tx;
    const integration = await draftIntegration(tx, ctx, workspaceId);
    await assertNameFree(tx, workspaceId, integration.id, input.draft, null);
    await assertHeaderMedia(tx, ctx, input.draft);
    const created = await tx.whatsAppTemplate.create({ data: { workspaceId, integrationId: integration.id, ...rowData(input) }, select: { id: true } });
    await recordAudit(tx, ctx, { action: 'template.draft.create', targetType: 'WhatsAppTemplate', targetId: created.id, simulated: ctx.mode === 'demo', summary: draftSummary(input) });
    return viewOf(tx, ctx, created.id, integration.simulated);
  });
  return { template, warnings: check.warnings };
}

async function loadAuthored(tx: Tx, ctx: AppCtx, templateId: string): Promise<TemplateRow & { integration: { status: IntegrationStatus } }> {
  const row = await tx.whatsAppTemplate.findFirst({ where: { id: templateId, workspaceId: requireWorkspace(ctx) }, select: { ...templateSelect, integration: { select: { status: true } } } });
  if (!row) throw new NotFoundError();
  return row;
}

export async function updateTemplateDraft(ctx: AppCtx, templateId: string, input: DraftInput): Promise<TemplateMutationResult> {
  requireCapability(ctx, 'templates.manage');
  const workspaceId = await assertWorkspaceMode(ctx);
  const check = checkTemplateDraft(input.draft, { forSubmit: false });
  const template = await withTx(ctx.db, async (scoped) => {
    const tx = scoped as unknown as Tx;
    const row = await loadAuthored(tx, ctx, templateId);
    if (row.origin !== 'AUTHORED' || !isStatus(row.status, TEMPLATE_DRAFT_STATUS)) {
      throw new ConflictError({ code: 'TEMPLATE_NOT_EDITABLE', userMessage: 'Only a draft can be edited. Submitted templates are reviewed by Meta as they were sent.' });
    }
    if (!check.ok) throw invalid(check.errors);
    await assertNameFree(tx, workspaceId, row.integrationId, input.draft, row.id);
    await assertHeaderMedia(tx, ctx, input.draft);
    const moved = await tx.whatsAppTemplate.updateMany({ where: { id: row.id, workspaceId, status: row.status }, data: rowData(input) });
    if (moved.count !== 1) throw new ConflictError({ code: 'TEMPLATE_NOT_EDITABLE', userMessage: 'This template changed while you were editing it. Reload and try again.' });
    await recordAudit(tx, ctx, { action: 'template.draft.update', targetType: 'WhatsAppTemplate', targetId: row.id, simulated: ctx.mode === 'demo', summary: draftSummary(input) });
    return viewOf(tx, ctx, row.id, row.integration.status === 'SIMULATED');
  });
  return { template, warnings: check.warnings };
}

/** Deletes a DRAFT (local only) or an authored template Meta REJECTED (LIVE: at Meta first). */
export async function deleteTemplate(ctx: AppCtx, templateId: string, deps: TemplateStudioDeps): Promise<{ deleted: true; templateId: string }> {
  requireCapability(ctx, 'templates.manage');
  const workspaceId = await assertWorkspaceMode(ctx);
  const row = await loadAuthored(ctx.db as unknown as Tx, ctx, templateId);
  const draft = isStatus(row.status, TEMPLATE_DRAFT_STATUS);
  if (row.origin !== 'AUTHORED' || !(draft || isStatus(row.status, 'REJECTED'))) {
    throw new ConflictError({ code: 'TEMPLATE_NOT_DELETABLE', userMessage: 'Only drafts and templates Meta rejected can be deleted here. Delete other templates in WhatsApp Manager.' });
  }
  const atProvider = !draft && ctx.mode === 'live';
  if (atProvider) {
    const admin = await resolveAdmin(ctx, deps);
    if (!admin.ok) throw notConfigured(admin);
    const res = await admin.value.deleteTemplate(row.name);
    if (!res.ok && !(res.phase === 'response' && res.status === 404)) {
      throw new ProviderRejectedError({ provider: 'whatsapp', code: 'TEMPLATE_DELETE_FAILED', message: redactText(res.error.message), userMessage: `Meta did not delete the template (${res.status ?? 'no answer'}). Nothing was changed here.` });
    }
  }
  await withTx(ctx.db, async (scoped) => {
    const tx = scoped as unknown as Tx;
    const messages = await tx.message.count({ where: { workspaceId, templateId: row.id } });
    if (messages > 0) throw new ConflictError({ code: 'TEMPLATE_NOT_DELETABLE', userMessage: 'Messages were sent with this template, so it is kept for their history.' });
    const removed = await tx.whatsAppTemplate.deleteMany({ where: { id: row.id, workspaceId, status: row.status } });
    if (removed.count !== 1) throw new ConflictError({ code: 'TEMPLATE_NOT_DELETABLE', userMessage: 'This template changed in the meantime. Reload and try again.' });
    await recordAudit(tx, ctx, {
      action: draft ? 'template.draft.delete' : 'template.delete',
      targetType: 'WhatsAppTemplate',
      targetId: row.id,
      simulated: ctx.mode === 'demo',
      summary: { template: row.name, language: row.language, status: row.status, atProvider },
    });
  });
  return { deleted: true, templateId: row.id };
}

// ---- Submission ------------------------------------------------------------------------------------

async function resolveAdmin(ctx: AppCtx, deps: Pick<TemplateStudioDeps, 'keyRing' | 'graphVersion' | 'graph'>): Promise<Resolution<TemplateAdmin>> {
  const ws = await ctx.db.workspace.findUnique({ where: { id: requireWorkspace(ctx) }, select: { mode: true } });
  const workspaceMode = ws?.mode ?? (ctx.mode === 'demo' ? 'LIVE' : 'DEMO');
  const integration = ctx.mode === 'live' ? await loadIntegrationForUse(ctx.db, 'WHATSAPP_CLOUD', deps.keyRing) : null;
  return whatsAppTemplateAdmin({ mode: ctx.mode, workspaceMode, integration, graphVersion: deps.graphVersion, clock: ctx.clock, ...(deps.graph ? { graph: deps.graph } : {}) });
}

function notConfigured(p: Extract<Resolution<unknown>, { ok: false }>): DomainRuleError {
  return new DomainRuleError({
    code: p.code === 'CREDENTIAL_UNREADABLE' ? 'CREDENTIAL_UNREADABLE' : 'INTEGRATION_NOT_CONFIGURED',
    userMessage: p.code === 'CREDENTIAL_UNREADABLE' ? 'The stored WhatsApp access token could not be read. Re-enter it in the WhatsApp setup.' : `Templates cannot be submitted: ${p.reason}. Finish the WhatsApp setup first.`,
    safeDetails: { reason: p.code },
  });
}

export type SubmitResult = { template: StudioTemplateView; simulated: boolean; reviewAt: string | null };

type HeaderDocument = { assetId: string; fileName: string; bytes: Buffer };

/** The DOCUMENT header's brochure, read and checked against its stored hash; null without a document header. */
async function headerDocumentOf(db: { mediaAsset: { findFirst(args: { where: { id: string; workspaceId: string }; select: { id: true; storagePath: true; sha256: true; byteSize: true; fileName: true } }): PromiseLike<(StoredMedia & { id: string }) | null> } }, workspaceId: string, row: TemplateRow, storageDir: string): Promise<HeaderDocument | null | 'MEDIA_MISSING'> {
  if (templateShape(row.components).headerFormat !== 'DOCUMENT' || row.headerMediaId === null) return null;
  const asset = await db.mediaAsset.findFirst({ where: { id: row.headerMediaId, workspaceId }, select: { id: true, storagePath: true, sha256: true, byteSize: true, fileName: true } });
  if (!asset) return 'MEDIA_MISSING';
  try {
    return { assetId: asset.id, fileName: asset.fileName, bytes: readMediaAssetFile(storageDir, asset) };
  } catch {
    return 'MEDIA_MISSING';
  }
}

const mediaMissing = () => new DomainRuleError({ code: 'MEDIA_MISSING', userMessage: TEMPLATE_SUBMIT_FAILURE_LABELS.MEDIA_MISSING! });

export async function submitTemplate(ctx: AppCtx, templateId: string, deps: TemplateStudioDeps): Promise<SubmitResult> {
  requireCapability(ctx, 'templates.manage');
  const workspaceId = await assertWorkspaceMode(ctx);
  const row = await loadAuthored(ctx.db as unknown as Tx, ctx, templateId);
  if (row.origin !== 'AUTHORED' || !isStatus(row.status, TEMPLATE_DRAFT_STATUS)) {
    throw new ConflictError({ code: 'TEMPLATE_NOT_SUBMITTABLE', userMessage: 'Only a draft can be submitted for approval.' });
  }
  const draft = draftFromStored(row);
  const check = checkTemplateDraft(draft, { forSubmit: true });
  if (!check.ok) throw invalid(check.errors);
  const admin = await resolveAdmin(ctx, deps);
  if (!admin.ok) {
    await withTx(ctx.db, (scoped) =>
      recordAudit(scoped as unknown as Tx, ctx, { action: 'template.submit', targetType: 'WhatsAppTemplate', targetId: row.id, result: 'DENIED', summary: { template: row.name, outcome: 'NOT_SUBMITTED', errorCode: admin.code === 'CREDENTIAL_UNREADABLE' ? 'CREDENTIAL_UNREADABLE' : 'INTEGRATION_NOT_CONFIGURED' } }),
    );
    throw notConfigured(admin);
  }
  const now = ctx.clock.now();
  const actor = ctx.actor?.userId ?? `system:${ctx.kind}`;
  const document = await headerDocumentOf(ctx.db as unknown as Tx, workspaceId, row, deps.storageDir);
  if (document === 'MEDIA_MISSING') throw mediaMissing();
  if (document && !admin.value.simulated && admin.value.appId === null) {
    throw new DomainRuleError({ code: 'INTEGRATION_NOT_CONFIGURED', userMessage: TEMPLATE_SUBMIT_FAILURE_LABELS.APP_ID_MISSING!, safeDetails: { reason: 'APP_ID_MISSING' } });
  }

  if (admin.value.simulated) {
    // DEMO: the simulated WhatsApp Manager accepts it (no network); the review job decides 30 s later.
    let headerHandle: string | null = null;
    if (document) {
      const uploaded = await admin.value.uploadHeaderDocument({ fileName: document.fileName, mimeType: 'application/pdf', bytes: document.bytes });
      if (!uploaded.ok) throw new DomainRuleError({ code: 'TEMPLATE_SUBMIT_FAILED', userMessage: 'The simulated review could not take the brochure.' });
      headerHandle = uploaded.data.handle;
    }
    const components = templateComponentsOf(draft, { headerHandle });
    const created = await admin.value.createTemplate({ name: row.name, language: row.language, category: row.category, components });
    if (!created.ok) throw new DomainRuleError({ code: 'TEMPLATE_SUBMIT_FAILED', userMessage: 'The simulated review could not accept the template.' });
    const reviewAt = new Date(now.getTime() + DEMO_TEMPLATE_REVIEW_DELAY_MS);
    const template = await withTx(ctx.db, async (scoped) => {
      const tx = scoped as unknown as Tx;
      const moved = await tx.whatsAppTemplate.updateMany({
        where: { id: row.id, workspaceId, status: row.status },
        data: { status: created.data.status ?? 'PENDING', providerTemplateId: created.data.id, submittedBy: actor, submittedAt: now, rejectedReason: null, components: components as Prisma.InputJsonValue },
      });
      if (moved.count !== 1) throw new ConflictError({ code: 'TEMPLATE_NOT_SUBMITTABLE', userMessage: 'This template changed in the meantime. Reload and try again.' });
      if (document && headerHandle) await tx.mediaAsset.updateMany({ where: { id: document.assetId, workspaceId }, data: { providerHandle: headerHandle, providerHandleAt: now } });
      const { job } = await enqueueJob(tx as unknown as JobStore, ctx.clock, {
        type: TEMPLATE_REVIEW_JOB,
        payload: { templateId: row.id },
        payloadVersion: TEMPLATE_JOB_PAYLOAD_VERSION,
        workspaceId,
        idempotencyKey: templateReviewJobKey(row.id, now),
        correlationId: ctx.correlationId,
        runAt: reviewAt,
        kind: 'default',
      });
      await recordAudit(tx, ctx, {
        action: 'template.submit',
        targetType: 'WhatsAppTemplate',
        targetId: row.id,
        simulated: true,
        summary: { template: row.name, language: row.language, category: row.category, outcome: 'SUBMITTED', status: created.data.status ?? 'PENDING', reviewJobId: job.id },
      });
      return viewOf(tx, ctx, row.id, true);
    });
    return { template, simulated: true, reviewAt: reviewAt.toISOString() };
  }

  // LIVE: SUBMITTING now; the job calls Meta outside any transaction.
  const template = await withTx(ctx.db, async (scoped) => {
    const tx = scoped as unknown as Tx;
    const moved = await tx.whatsAppTemplate.updateMany({ where: { id: row.id, workspaceId, status: row.status }, data: { status: TEMPLATE_SUBMITTING_STATUS, submittedBy: actor, submittedAt: now, rejectedReason: null } });
    if (moved.count !== 1) throw new ConflictError({ code: 'TEMPLATE_NOT_SUBMITTABLE', userMessage: 'This template changed in the meantime. Reload and try again.' });
    const { job } = await enqueueJob(tx as unknown as JobStore, ctx.clock, {
      type: TEMPLATE_SUBMIT_JOB,
      payload: { templateId: row.id },
      payloadVersion: TEMPLATE_JOB_PAYLOAD_VERSION,
      workspaceId,
      idempotencyKey: templateSubmitJobKey(row.id, now),
      correlationId: ctx.correlationId,
      kind: 'send',
      serialKey: `template:${row.id}`,
    });
    await recordAudit(tx, ctx, { action: 'template.submit', targetType: 'WhatsAppTemplate', targetId: row.id, summary: { template: row.name, language: row.language, category: row.category, outcome: 'QUEUED', jobId: job.id } });
    return viewOf(tx, ctx, row.id, false);
  });
  return { template, simulated: false, reviewAt: null };
}

// ---- Jobs ----------------------------------------------------------------------------------------

export type TemplateJobDeps = Omit<TemplateStudioDeps, 'storageDir'> & { storageDir: string; mode: 'demo' | 'live' };

type LoadedJob = { ctx: AppCtx; workspaceId: string; row: TemplateRow };

async function loadJobTemplate(job: JobHandlerContext, mode: 'demo' | 'live'): Promise<LoadedJob | JobResult> {
  const payload = record(job.job.payload);
  const templateId = typeof payload.templateId === 'string' && payload.templateId.length <= 64 ? payload.templateId : null;
  if (templateId === null || job.job.workspaceId === null) return { outcome: 'dead', reason: 'INVALID_PAYLOAD', errorCode: 'INVALID_PAYLOAD', error: `${job.job.type} payload is not { templateId } on a workspace job` };
  const ctx = getJobContext({ id: job.job.id, workspaceId: job.job.workspaceId, correlationId: job.correlationId }, { prisma: job.db, mode, clock: job.clock });
  const row = await ctx.db.whatsAppTemplate.findFirst({ where: { id: templateId }, select: templateSelect });
  if (!row) return { outcome: 'succeeded' };
  return { ctx, workspaceId: job.job.workspaceId, row };
}

async function enqueueSubmitSync(tx: Tx, l: LoadedJob, job: JobHandlerContext, runAt: Date): Promise<void> {
  await enqueueJob(tx as unknown as JobStore, job.clock, {
    type: WA_TEMPLATE_SYNC_JOB,
    payload: { integrationId: l.row.integrationId },
    payloadVersion: INTEGRATION_SCHEDULE_PAYLOAD_VERSION,
    workspaceId: l.workspaceId,
    idempotencyKey: submitSyncJobKey(l.row.integrationId, l.row.id, l.row.submittedAt ?? job.clock.now()),
    correlationId: job.correlationId,
    causationId: job.job.id,
    runAt,
    kind: 'fetch',
    priority: 5,
  });
}

/** Back to DRAFT after a definite failure (nothing exists at Meta), with the reason audited. */
async function backToDraft(tx: Tx, l: LoadedJob, failure: { code: string; message: string }): Promise<void> {
  const moved = await tx.whatsAppTemplate.updateMany({ where: { id: l.row.id, workspaceId: l.workspaceId, status: TEMPLATE_SUBMITTING_STATUS }, data: { status: TEMPLATE_DRAFT_STATUS } });
  if (moved.count !== 1) return;
  await recordAudit(tx, l.ctx, {
    action: 'template.submit',
    targetType: 'WhatsAppTemplate',
    targetId: l.row.id,
    result: 'FAILED',
    summary: { template: l.row.name, language: l.row.language, outcome: 'NOT_CREATED', errorCode: failure.code, error: redactText(failure.message).slice(0, MAX_ERROR) },
  });
}

/** Still SUBMITTING: a sync by name and language resolves it (never a blind retry). */
function confirming(l: LoadedJob, job: JobHandlerContext, code: string, message: string, runAt: Date): JobResult {
  return {
    outcome: 'succeeded',
    finalTx: async (tx) => {
      const current = await tx.whatsAppTemplate.findFirst({ where: { id: l.row.id, workspaceId: l.workspaceId }, select: { status: true } });
      if (!current || !isStatus(current.status, TEMPLATE_SUBMITTING_STATUS)) return;
      await enqueueSubmitSync(tx, l, job, runAt);
      await recordAudit(tx, l.ctx, {
        action: 'template.submit',
        targetType: 'WhatsAppTemplate',
        targetId: l.row.id,
        summary: { template: l.row.name, language: l.row.language, outcome: 'CONFIRMING', errorCode: code, error: redactText(message).slice(0, MAX_ERROR) },
      });
    },
  };
}

/** `wa.templateSubmit` (LIVE): one call to Meta per submission; the outcome settles in the fenced finalTx. */
export async function runTemplateSubmit(job: JobHandlerContext, deps: TemplateJobDeps): Promise<JobResult> {
  if (deps.mode !== 'live') return { outcome: 'succeeded' };
  const loaded = await loadJobTemplate(job, deps.mode);
  if (!('row' in loaded)) return loaded;
  const l = loaded;
  if (!isStatus(l.row.status, TEMPLATE_SUBMITTING_STATUS)) return { outcome: 'succeeded' };
  const now = job.clock.now();
  if (job.job.attempts > 1) {
    // A previous run may have reached Meta before it stopped: confirm by name and language, never call again.
    return confirming(l, job, 'INTERRUPTED', 'The worker stopped during the submission; confirming with Meta by name and language.', now);
  }
  const admin = await resolveAdmin(l.ctx, deps);
  if (!admin.ok) {
    const code = admin.code === 'CREDENTIAL_UNREADABLE' ? 'CREDENTIAL_UNREADABLE' : 'INTEGRATION_NOT_CONFIGURED';
    return { outcome: 'succeeded', finalTx: (tx) => backToDraft(tx, l, { code, message: admin.reason }) };
  }
  if (admin.value.simulated) return { outcome: 'succeeded', finalTx: (tx) => backToDraft(tx, l, { code: 'INTEGRATION_NOT_CONFIGURED', message: 'DEMO never submits to Meta' }) };
  const draft = draftFromStored(l.row);
  const document = await headerDocumentOf(job.db, l.workspaceId, l.row, deps.storageDir);
  if (document === 'MEDIA_MISSING') return { outcome: 'succeeded', finalTx: (tx) => backToDraft(tx, l, { code: 'MEDIA_MISSING', message: 'the brochure file is missing or changed' }) };
  let headerHandle: string | null = null;
  if (document) {
    // The header sample: nothing exists at Meta until the template is created, so any failure here is a plain "not submitted".
    const uploaded = await admin.value.uploadHeaderDocument({ fileName: document.fileName, mimeType: 'application/pdf', bytes: document.bytes });
    if (job.signal.aborted) throw new LeaseLostError(job.job.id);
    if (!uploaded.ok) {
      const failure = classifyTemplateCreateFailure(uploaded);
      const code = failure.kind === 'refused' || failure.kind === 'not-sent' ? failure.code : 'MEDIA_UPLOAD_FAILED';
      return { outcome: 'succeeded', finalTx: (tx) => backToDraft(tx, l, { code, message: failure.message }) };
    }
    headerHandle = uploaded.data.handle;
  }
  const components = templateComponentsOf(draft, { headerHandle });
  const res = await admin.value.createTemplate({ name: l.row.name, language: l.row.language, category: l.row.category, components });
  if (job.signal.aborted) throw new LeaseLostError(job.job.id);
  if (res.ok) {
    return {
      outcome: 'succeeded',
      finalTx: async (tx) => {
        const status = res.data.status ?? 'PENDING';
        const moved = await tx.whatsAppTemplate.updateMany({
          where: { id: l.row.id, workspaceId: l.workspaceId, status: TEMPLATE_SUBMITTING_STATUS },
          data: { status, providerTemplateId: res.data.id, ...(res.data.category ? { category: res.data.category } : {}), components: components as Prisma.InputJsonValue },
        });
        if (moved.count !== 1) return;
        if (document && headerHandle) await tx.mediaAsset.updateMany({ where: { id: document.assetId, workspaceId: l.workspaceId }, data: { providerHandle: headerHandle, providerHandleAt: now } });
        await enqueueSubmitSync(tx, l, job, new Date(now.getTime() + SUBMIT_SYNC_DELAY_MS));
        await recordAudit(tx, l.ctx, {
          action: 'template.submit',
          targetType: 'WhatsAppTemplate',
          targetId: l.row.id,
          summary: { template: l.row.name, language: l.row.language, outcome: 'SUBMITTED', status, category: res.data.category ?? l.row.category, categoryChanged: res.data.category !== null && res.data.category !== l.row.category },
        });
      },
    };
  }
  const failure = classifyTemplateCreateFailure(res);
  if (failure.kind === 'ambiguous' || failure.kind === 'name-taken') return confirming(l, job, failure.code, failure.message, new Date(now.getTime() + SUBMIT_SYNC_DELAY_MS));
  return { outcome: 'succeeded', finalTx: (tx) => backToDraft(tx, l, failure) };
}

/** `wa.templateReview` (DEMO): the simulated WhatsApp Manager approves the template, or rejects a name containing `reject` with a reason. */
export async function runTemplateReview(job: JobHandlerContext, deps: { mode: 'demo' | 'live' }): Promise<JobResult> {
  if (deps.mode !== 'demo') return { outcome: 'succeeded' };
  const loaded = await loadJobTemplate(job, deps.mode);
  if (!('row' in loaded)) return loaded;
  const l = loaded;
  if (l.row.origin !== 'AUTHORED' || !isStatus(l.row.status, 'PENDING')) return { outcome: 'succeeded' };
  const admin = whatsAppTemplateAdmin({ mode: 'demo', workspaceMode: 'DEMO', integration: null, graphVersion: null, clock: job.clock });
  if (!admin.ok || !admin.value.simulated) return { outcome: 'succeeded' };
  const verdict = admin.value.review({ name: l.row.name });
  return {
    outcome: 'succeeded',
    finalTx: async (tx) => {
      const moved = await tx.whatsAppTemplate.updateMany({
        where: { id: l.row.id, workspaceId: l.workspaceId, status: l.row.status },
        data: { status: verdict.status, rejectedReason: verdict.rejectedReason, syncedAt: job.clock.now() },
      });
      if (moved.count !== 1) return;
      await recordAudit(tx, l.ctx, {
        action: 'template.review',
        targetType: 'WhatsAppTemplate',
        targetId: l.row.id,
        simulated: true,
        result: verdict.status === 'APPROVED' ? 'SUCCESS' : 'FAILED',
        summary: { template: l.row.name, language: l.row.language, outcome: verdict.status },
      });
    },
  };
}

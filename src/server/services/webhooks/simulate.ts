/**
 * DEMO source simulators (T11, R11, AT2; PRD "same application services"). A simulation is a
 * webhook delivery whose provider is played by a DEMO adapter: the simulator builds the provider's
 * own payload shape (Apps Script push, Meta leadgen + Graph lead, extension batch) and hands it to
 * `persistWebhookEvent`, exactly as a verified receiver would. Processing then runs in the worker
 * (`ingest.process` -> `ingestBatch`), so a simulated lead has the same LeadSourceRecord,
 * ImportBatch, pipeline job and audit trail as a live one, all flagged `simulated`.
 *
 * Mode isolation (ADR-04, C20): only a DEMO process (ctx.mode) and only a DEMO workspace; anything
 * else is a 404 before any write. Sheets and Meta simulations route through the workspace's own
 * integration (created as SIMULATED on first use, with the demo form mapping, never a routing key),
 * so their scope key is that integration (E2); extension simulations are scoped by the workspace,
 * as an extension token is.
 */
import type { Prisma } from '@/generated/prisma/client';
import { demoBusiness } from '@/lib/demo/contacts';
import { NotFoundError } from '@/lib/errors';
import { randomBase64Url } from '@/lib/ids';
import { fieldMapSchema, type ExtensionBatch, type FieldMap, type SimulationSource } from '@/lib/schemas/webhooks';
import { DEMO_META_CONSENT, DEMO_META_FIELD_MAP, DEMO_META_FORM_ID, DEMO_META_PAGE_ID, buildSimulatedLeadgenEvents } from '@/server/adapters/meta/demo';
import { DEMO_SHEET_CONSENT, DEMO_SHEET_FIELD_MAP, buildSimulatedSheetsPush, demoSheetId } from '@/server/adapters/sheets/demo';
import { baseClientOf, type AppCtx } from '@/server/auth/context';
import { requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import type { KeyRing } from '@/server/security/secrets';
import { recordAudit } from '@/server/services/audit/record';
import { noticeTextHash } from '@/server/services/messaging/consent';
import { canonicalJson, persistWebhookEvent, sha256Hex, type PersistWebhookResult } from './events';

export type SimulatedSource = SimulationSource;

const SIMULATION_MAX_COUNT = 10;
const BATCH_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export type SimulateInput = { source: SimulatedSource; count: number; batchId?: string };

export type SimulationResult = {
  source: SimulatedSource;
  workspaceId: string;
  batchId: string;
  records: number;
  events: PersistWebhookResult[];
};

type Tx = Prisma.TransactionClient;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

/** The DEMO workspace behind a context, or 404 (LIVE process, LIVE workspace, or no workspace). */
async function demoWorkspace(ctx: AppCtx): Promise<{ id: string; slug: string }> {
  const workspaceId = requireWorkspace(ctx);
  if (ctx.mode !== 'demo') throw new NotFoundError({ message: 'simulations exist only in a DEMO process' });
  const workspace = await baseClientOf(ctx).workspace.findUnique({ where: { id: workspaceId }, select: { id: true, slug: true, mode: true } });
  if (!workspace || workspace.mode !== 'DEMO') throw new NotFoundError({ message: 'simulations never touch a LIVE workspace' });
  return workspace;
}

/** Runs `fn` in a write transaction, retrying once when a concurrent first use created the same rows. */
async function setupTx<R>(ctx: AppCtx, fn: (tx: Tx) => Promise<R>): Promise<R> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await withTx(ctx.db, (scoped) => fn(scoped as unknown as Tx));
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= 2) throw error;
    }
  }
}

async function simulatedIntegration(tx: Tx, ctx: AppCtx, workspaceId: string, kind: 'GOOGLE_SHEETS' | 'META_ADS', config: Prisma.InputJsonValue) {
  const existing = await tx.integration.findFirst({ where: { workspaceId, kind } });
  if (existing) return existing;
  const created = await tx.integration.create({ data: { workspaceId, kind, status: 'SIMULATED', config } });
  await recordAudit(tx, ctx, { action: 'integration.simulated.create', targetType: 'Integration', targetId: created.id, simulated: true, summary: { kind } });
  return created;
}

export type SimulatedSheetsSetup = { integrationId: string; sheetId: string; mappingVersion: number; fieldMap: FieldMap; consentColumn: string | null };

/**
 * The workspace's Sheets integration and active mapping, creating the SIMULATED integration and
 * the demo form mapping (with its consent column, P1) on first use. An existing mapping is used
 * as it is, so the simulated rows follow whatever columns the workspace mapped.
 */
export async function ensureSimulatedSheets(ctx: AppCtx): Promise<SimulatedSheetsSetup> {
  const workspace = await demoWorkspace(ctx);
  return setupTx(ctx, async (tx) => {
    const integration = await simulatedIntegration(tx, ctx, workspace.id, 'GOOGLE_SHEETS', { sheetId: demoSheetId(workspace.slug), simulated: true });
    let mapping = await tx.sheetMapping.findFirst({ where: { workspaceId: workspace.id, integrationId: integration.id, active: true } });
    if (!mapping) {
      const latest = await tx.sheetMapping.findFirst({ where: { workspaceId: workspace.id, integrationId: integration.id }, orderBy: { version: 'desc' } });
      const columns = [...Object.values(DEMO_SHEET_FIELD_MAP), DEMO_SHEET_CONSENT.column];
      mapping = await tx.sheetMapping.create({
        data: {
          workspaceId: workspace.id,
          integrationId: integration.id,
          version: (latest?.version ?? 0) + 1,
          headerFingerprint: sha256Hex(columns.join('\u001f')),
          fieldMap: DEMO_SHEET_FIELD_MAP,
          consentMapping: { ...DEMO_SHEET_CONSENT, noticeTextHash: noticeTextHash(DEMO_SHEET_CONSENT.noticeText) },
          active: true,
        },
      });
      await recordAudit(tx, ctx, { action: 'sheets.mapping.simulated.create', targetType: 'SheetMapping', targetId: mapping.id, simulated: true, summary: { version: mapping.version } });
    }
    const config = (integration.config ?? {}) as { sheetId?: unknown };
    const consent = (mapping.consentMapping ?? null) as { column?: unknown } | null;
    return {
      integrationId: integration.id,
      sheetId: typeof config.sheetId === 'string' ? config.sheetId : demoSheetId(workspace.slug),
      mappingVersion: mapping.version,
      fieldMap: fieldMapSchema.parse(mapping.fieldMap),
      consentColumn: typeof consent?.column === 'string' ? consent.column : null,
    };
  });
}

export type SimulatedMetaSetup = { integrationId: string; pageId: string; formId: string; fieldMap: FieldMap; consentQuestion: string | null };

/** The workspace's Meta integration and the demo lead form mapping, created SIMULATED on first use. */
export async function ensureSimulatedMeta(ctx: AppCtx): Promise<SimulatedMetaSetup> {
  const workspace = await demoWorkspace(ctx);
  return setupTx(ctx, async (tx) => {
    const integration = await simulatedIntegration(tx, ctx, workspace.id, 'META_ADS', { pageId: DEMO_META_PAGE_ID, simulated: true });
    const config = (integration.config ?? {}) as { pageId?: unknown };
    const pageId = typeof config.pageId === 'string' ? config.pageId : DEMO_META_PAGE_ID;
    let mapping = await tx.metaFormMapping.findFirst({ where: { workspaceId: workspace.id, integrationId: integration.id }, orderBy: { formId: 'asc' } });
    if (!mapping) {
      mapping = await tx.metaFormMapping.create({
        data: {
          workspaceId: workspace.id,
          integrationId: integration.id,
          formId: DEMO_META_FORM_ID,
          fieldMap: DEMO_META_FIELD_MAP,
          consentMapping: { ...DEMO_META_CONSENT, noticeTextHash: noticeTextHash(DEMO_META_CONSENT.noticeText) },
        },
      });
      await recordAudit(tx, ctx, { action: 'meta.form_mapping.simulated.create', targetType: 'MetaFormMapping', targetId: mapping.id, simulated: true, summary: { formId: mapping.formId } });
    }
    const consent = (mapping.consentMapping ?? null) as { column?: unknown } | null;
    return {
      integrationId: integration.id,
      pageId,
      formId: mapping.formId,
      fieldMap: fieldMapSchema.parse(mapping.fieldMap),
      consentQuestion: typeof consent?.column === 'string' ? consent.column : null,
    };
  });
}

const DEMO_KEYWORDS = ['clinics near me', 'gyms in sector 29', 'bakery koramangala', 'salon andheri', 'interior designers'] as const;

/** A Maps extension batch (v1) of fictitious local businesses; a pure function of the batch id. */
export function buildSimulatedExtensionBatch(input: { batchId: string; count: number; extractedAt: Date }): ExtensionBatch {
  const keyword = DEMO_KEYWORDS[input.batchId.length % DEMO_KEYWORDS.length]!;
  return {
    version: 1,
    batchId: input.batchId,
    keyword,
    records: Array.from({ length: input.count }, (_, i) => {
      const b = demoBusiness(`gmaps:${input.batchId}:${i}`);
      return {
        recordId: `${input.batchId}:${i + 1}`,
        placeId: b.placeId,
        name: b.name,
        phone: b.phone,
        website: b.website,
        address: b.address,
        city: b.city,
        category: b.category,
        rating: b.rating,
        reviewCount: b.reviewCount,
        extractedAt: new Date(input.extractedAt.getTime() - (input.count - 1 - i) * 1000).toISOString(),
      };
    }),
  };
}

export async function simulateSource(ctx: AppCtx, input: SimulateInput, deps: { keyRing: KeyRing }): Promise<SimulationResult> {
  const workspace = await demoWorkspace(ctx);
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > SIMULATION_MAX_COUNT) throw new RangeError(`simulation count must be 1-${SIMULATION_MAX_COUNT}`);
  const batchId = input.batchId ?? `sim-${randomBase64Url(9)}`;
  if (!BATCH_ID_PATTERN.test(batchId)) throw new RangeError('simulation batch id has an invalid format');
  const base = baseClientOf(ctx);
  const now = ctx.clock.now();
  const persist = (provider: 'GOOGLE_SHEETS' | 'META_ADS' | 'GMAPS_EXTENSION', integrationId: string | null, externalKey: string, body: unknown) =>
    persistWebhookEvent(
      base,
      ctx,
      { provider, workspaceId: workspace.id, integrationId, externalKey, body, bodySha256: sha256Hex(canonicalJson(body)), simulated: true, processJob: 'ingest.process' },
      deps,
    );

  const events: PersistWebhookResult[] = [];
  if (input.source === 'sheets') {
    const setup = await ensureSimulatedSheets(ctx);
    const push = buildSimulatedSheetsPush({ sheetId: setup.sheetId, mappingVersion: setup.mappingVersion, fieldMap: setup.fieldMap, consentColumn: setup.consentColumn, batchId, count: input.count, submittedAt: now });
    events.push(await persist('GOOGLE_SHEETS', setup.integrationId, push.eventId, push));
  } else if (input.source === 'meta') {
    const setup = await ensureSimulatedMeta(ctx);
    const leads = buildSimulatedLeadgenEvents({ batchId, count: input.count, fieldMap: setup.fieldMap, consentQuestion: setup.consentQuestion, formId: setup.formId, pageId: setup.pageId, createdAt: now });
    for (const lead of leads) events.push(await persist('META_ADS', setup.integrationId, `meta:${lead.change.page_id}:${lead.change.leadgen_id}`, lead));
  } else {
    const batch = buildSimulatedExtensionBatch({ batchId, count: input.count, extractedAt: now });
    events.push(await persist('GMAPS_EXTENSION', null, batch.batchId, batch));
  }
  return { source: input.source, workspaceId: workspace.id, batchId, records: input.count, events };
}

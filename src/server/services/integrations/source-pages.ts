/**
 * Read models of the employee's lead-source pages (T28; PRD "Employee": Sheets/Form setup, Meta
 * console, Extension hub; 06-design §11.2.2 and §11.3).
 *
 * Each page shows the configuration state the live adapters fill in M5 (T34 Sheets, T35 Meta, T36
 * extension) and the DEMO simulation that reaches the same webhook path and ingestion as a live
 * delivery (`/api/demo/simulate/[source]`, ADR-54):
 * - Sheets: the GOOGLE_SHEETS integration card, the spreadsheet id, the active SheetMapping (fields,
 *   consent column, truthy values and notice hash, P1) with its version history, recent Sheets
 *   deliveries with their per-record counts, and per-row issues (REJECTED or REVIEW source records).
 * - Meta: the META_ADS card, Page and ad account ids, the form mappings, recent leadgen deliveries,
 *   per-row issues, and campaigns with their latest metric snapshot in the ad-account currency
 *   (minor units as decimal strings, never converted; P6) with its date window, attribution and
 *   As of time.
 * - Extension: ingestion tokens by prefix and state (never the hash), recent batches with counts,
 *   per-row issues, and the documented batch payload as an example.
 * Every page needs `leads.read`; the simulation gate is DEMO plus `leads.write` (the route's rule).
 */
import type { LeadSource, SourceRecordStatus, WebhookProvider, WebhookStatus } from '@/generated/prisma/client';
import type { ExtensionBatch } from '@/lib/schemas/webhooks';
import { NotFoundError } from '@/lib/errors';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability, requireWorkspace } from '@/server/auth/guards';
import type { WebhookEventResult } from '@/server/services/webhooks/events';
import { loadIntegrationCard, type IntegrationCardView, type IntegrationWorkspace } from './center';

export type SimulationGate = { allowed: true } | { allowed: false; category: 'mode' | 'permission'; reason: string };

export type SourceEvent = {
  id: string;
  status: WebhookStatus;
  simulated: boolean;
  receivedAt: Date;
  processedAt: Date | null;
  counts: { received: number; accepted: number; duplicate: number; review: number; rejected: number } | null;
  failureCode: string | null;
};

export type RowIssue = { id: string; externalId: string; status: SourceRecordStatus; reasonCode: string | null; receivedAt: Date; batchId: string | null };

export type ConsentMappingView = { column: string; truthyValues: string[]; channel: string; purpose: string; noticeText: string; noticeTextHash: string | null };

export type FieldMapping = { field: string; column: string };

export type SheetsSetupView = {
  mode: 'demo' | 'live';
  workspace: IntegrationWorkspace;
  /** `sheets.manage`: mapping and sync (T34). */
  canManage: boolean;
  /** `integrations.manage`: Test connection. */
  canTestConnection: boolean;
  integration: IntegrationCardView;
  sheetId: string | null;
  mapping: { version: number; active: boolean; headerFingerprint: string; fields: FieldMapping[]; consent: ConsentMappingView | null } | null;
  mappingVersions: Array<{ version: number; active: boolean }>;
  events: SourceEvent[];
  rowIssues: RowIssue[];
  simulation: SimulationGate;
};

export type MetaCampaignView = {
  id: string;
  name: string;
  providerCampaignId: string;
  currency: string;
  configuredStatus: string;
  effectiveStatus: string;
  lastSyncedAt: Date | null;
  simulated: boolean;
  latest: { spendMinor: string; leads: number; cplMinor: string | null; dateStart: Date; dateStop: Date; attributionSetting: string | null; asOf: Date } | null;
};

export type MetaConsoleView = {
  mode: 'demo' | 'live';
  workspace: IntegrationWorkspace;
  /** `integrations.manage`: Test connection and form mapping. */
  canManage: boolean;
  canTestConnection: boolean;
  canControlCampaigns: boolean;
  integration: IntegrationCardView;
  pageId: string | null;
  adAccountId: string | null;
  forms: Array<{ formId: string; fields: FieldMapping[]; consent: ConsentMappingView | null }>;
  campaigns: MetaCampaignView[];
  events: SourceEvent[];
  rowIssues: RowIssue[];
  simulation: SimulationGate;
};

export type ExtensionTokenView = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  allowedExtensionId: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  state: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
};

export type ExtensionBatchView = {
  id: string;
  externalBatchId: string;
  status: string;
  simulated: boolean;
  createdAt: Date;
  completedAt: Date | null;
  counts: { received: number; accepted: number; duplicate: number; review: number; rejected: number } | null;
};

export type ExtensionHubView = {
  mode: 'demo' | 'live';
  workspace: IntegrationWorkspace;
  canManage: boolean;
  tokens: ExtensionTokenView[];
  batches: ExtensionBatchView[];
  rowIssues: RowIssue[];
  examplePayload: ExtensionBatch;
  /** Extension deliveries the worker has not processed yet (the page re-reads itself meanwhile). */
  deliveriesQueued: number;
  simulation: SimulationGate;
};

const EVENT_LIMIT = 10;
const ISSUE_LIMIT = 20;
const BATCH_LIMIT = 10;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.slice(0, 300) : null;
}

function fieldsOf(fieldMap: unknown): FieldMapping[] {
  return Object.entries(record(fieldMap))
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([field, column]) => ({ field, column }));
}

function consentOf(value: unknown): ConsentMappingView | null {
  const c = record(value);
  const column = str(c.column);
  if (!column) return null;
  return {
    column,
    truthyValues: Array.isArray(c.truthyValues) ? c.truthyValues.filter((v): v is string => typeof v === 'string').slice(0, 20) : [],
    channel: str(c.channel) ?? 'WHATSAPP',
    purpose: str(c.purpose) ?? 'MARKETING',
    noticeText: typeof c.noticeText === 'string' ? c.noticeText.slice(0, 1000) : '',
    noticeTextHash: typeof c.noticeTextHash === 'string' && /^[0-9a-f]{64}$/.test(c.noticeTextHash) ? c.noticeTextHash : null,
  };
}

function countsOf(value: unknown): SourceEvent['counts'] {
  const c = record(value);
  const n = (k: string) => (typeof c[k] === 'number' && Number.isFinite(c[k]) ? (c[k] as number) : 0);
  if (Object.keys(c).length === 0) return null;
  return { received: n('received'), accepted: n('accepted'), duplicate: n('duplicate'), review: n('review'), rejected: n('rejected') };
}

async function workspaceOf(ctx: AppCtx): Promise<IntegrationWorkspace> {
  const workspaceId = requireWorkspace(ctx);
  const ws = await ctx.db.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true, name: true, timezone: true, mode: true } });
  if (!ws) throw new NotFoundError();
  return ws;
}

/** The same rule as POST /api/demo/simulate/[source] (DEMO process and workspace, leads.write). */
export function simulationGate(ctx: AppCtx, workspaceMode: 'DEMO' | 'LIVE'): SimulationGate {
  if (ctx.mode !== 'demo' || workspaceMode !== 'DEMO') {
    return { allowed: false, category: 'mode', reason: 'Simulations run only in DEMO mode. In LIVE, deliveries arrive from the connected provider.' };
  }
  if (!hasCapability(ctx, 'leads.write')) {
    return { allowed: false, category: 'permission', reason: 'Simulations add leads, which needs the “Add and edit leads” capability in this workspace. A super admin can grant it.' };
  }
  return { allowed: true };
}

async function recentEvents(ctx: AppCtx, provider: WebhookProvider): Promise<SourceEvent[]> {
  const rows = await ctx.db.webhookEvent.findMany({
    where: { provider },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    take: EVENT_LIMIT,
    select: { id: true, status: true, simulated: true, receivedAt: true, processedAt: true, result: true },
  });
  return rows.map((e) => {
    const result = (e.result as WebhookEventResult | null) ?? null;
    return {
      id: e.id,
      status: e.status,
      simulated: e.simulated,
      receivedAt: e.receivedAt,
      processedAt: e.processedAt,
      counts: result?.kind === 'ingest' ? result.counts : null,
      failureCode: result?.kind === 'failed' ? result.code : null,
    };
  });
}

async function rowIssues(ctx: AppCtx, source: LeadSource): Promise<RowIssue[]> {
  const rows = await ctx.db.leadSourceRecord.findMany({
    where: { source, status: { in: ['REJECTED', 'REVIEW', 'UNRETRIEVABLE'] } },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    take: ISSUE_LIMIT,
    select: { id: true, externalId: true, status: true, reasonCode: true, receivedAt: true, importBatchId: true },
  });
  return rows.map((r) => ({ id: r.id, externalId: r.externalId, status: r.status, reasonCode: r.reasonCode, receivedAt: r.receivedAt, batchId: r.importBatchId }));
}

export async function getSheetsSetup(ctx: AppCtx): Promise<SheetsSetupView> {
  requireCapability(ctx, 'leads.read');
  const workspace = await workspaceOf(ctx);
  const integration = await loadIntegrationCard(ctx, 'GOOGLE_SHEETS');
  const row = await ctx.db.integration.findFirst({ where: { kind: 'GOOGLE_SHEETS' }, select: { id: true, config: true } });
  const mappings = row ? await ctx.db.sheetMapping.findMany({ where: { integrationId: row.id }, orderBy: { version: 'desc' } }) : [];
  const current = mappings.find((m) => m.active) ?? mappings[0] ?? null;
  return {
    mode: ctx.mode,
    workspace,
    canManage: hasCapability(ctx, 'sheets.manage'),
    canTestConnection: hasCapability(ctx, 'integrations.manage'),
    integration,
    sheetId: str(record(row?.config).sheetId),
    mapping: current
      ? { version: current.version, active: current.active, headerFingerprint: current.headerFingerprint, fields: fieldsOf(current.fieldMap), consent: consentOf(current.consentMapping) }
      : null,
    mappingVersions: mappings.map((m) => ({ version: m.version, active: m.active })),
    events: await recentEvents(ctx, 'GOOGLE_SHEETS'),
    rowIssues: await rowIssues(ctx, 'GOOGLE_SHEETS'),
    simulation: simulationGate(ctx, workspace.mode),
  };
}

export async function getMetaConsole(ctx: AppCtx): Promise<MetaConsoleView> {
  requireCapability(ctx, 'leads.read');
  const workspace = await workspaceOf(ctx);
  const integration = await loadIntegrationCard(ctx, 'META_ADS');
  const row = await ctx.db.integration.findFirst({ where: { kind: 'META_ADS' }, select: { id: true, config: true } });
  const forms = row ? await ctx.db.metaFormMapping.findMany({ where: { integrationId: row.id }, orderBy: { formId: 'asc' } }) : [];
  const campaigns = await ctx.db.campaign.findMany({
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: 50,
    include: { snapshots: { orderBy: [{ asOf: 'desc' }, { dateStop: 'desc' }], take: 1 } },
  });
  return {
    mode: ctx.mode,
    workspace,
    canManage: hasCapability(ctx, 'integrations.manage'),
    canTestConnection: hasCapability(ctx, 'integrations.manage'),
    canControlCampaigns: hasCapability(ctx, 'campaigns.control'),
    integration,
    pageId: str(record(row?.config).pageId),
    adAccountId: str(record(row?.config).adAccountId),
    forms: forms.map((f) => ({ formId: f.formId, fields: fieldsOf(f.fieldMap), consent: consentOf(f.consentMapping) })),
    campaigns: campaigns.map((c) => {
      const s = c.snapshots[0];
      return {
        id: c.id,
        name: c.name,
        providerCampaignId: c.providerCampaignId,
        currency: c.currency,
        configuredStatus: c.configuredStatus,
        effectiveStatus: c.effectiveStatus,
        lastSyncedAt: c.lastSyncedAt,
        simulated: c.simulated,
        latest: s
          ? { spendMinor: s.spendMinor.toString(), leads: s.leads, cplMinor: s.cplMinor === null ? null : s.cplMinor.toString(), dateStart: s.dateStart, dateStop: s.dateStop, attributionSetting: s.attributionSetting, asOf: s.asOf }
          : null,
      };
    }),
    events: await recentEvents(ctx, 'META_ADS'),
    rowIssues: await rowIssues(ctx, 'META_ADS'),
    simulation: simulationGate(ctx, workspace.mode),
  };
}

/** The documented extension batch body (v1, `extensionBatchSchema`), with fictitious values. */
export const EXTENSION_EXAMPLE_PAYLOAD: ExtensionBatch = {
  version: 1,
  batchId: 'gmaps-2026-10-16-0001',
  keyword: 'dental clinic in Gurugram',
  records: [
    {
      recordId: 'row-0001',
      placeId: 'ChIJ-example-place-id',
      name: 'Example Dental Studio',
      phone: '+91 99999 00000',
      email: null,
      website: 'https://example.com',
      address: 'Sector 29, Gurugram',
      city: 'Gurugram',
      category: 'Dental clinic',
      rating: 4.6,
      reviewCount: 128,
      extractedAt: '2026-10-16T05:30:00+05:30',
    },
  ],
};

export async function getExtensionHub(ctx: AppCtx): Promise<ExtensionHubView> {
  requireCapability(ctx, 'leads.read');
  const workspace = await workspaceOf(ctx);
  const now = ctx.clock.now();
  const tokens = await ctx.db.extensionToken.findMany({
    orderBy: [{ revokedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }, { id: 'asc' }],
    take: 50,
    select: { id: true, name: true, prefix: true, scopes: true, allowedExtensionId: true, createdAt: true, lastUsedAt: true, expiresAt: true, revokedAt: true },
  });
  const batches = await ctx.db.importBatch.findMany({
    where: { source: 'GMAPS_EXTENSION' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: BATCH_LIMIT,
    select: { id: true, externalBatchId: true, status: true, simulated: true, createdAt: true, completedAt: true, counts: true },
  });
  return {
    mode: ctx.mode,
    workspace,
    canManage: hasCapability(ctx, 'extension.manage'),
    tokens: tokens.map((t) => ({
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      scopes: Array.isArray(t.scopes) ? t.scopes.filter((s): s is string => typeof s === 'string') : [],
      allowedExtensionId: t.allowedExtensionId,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
      expiresAt: t.expiresAt,
      state: t.revokedAt ? 'REVOKED' : t.expiresAt && t.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'ACTIVE',
    })),
    batches: batches.map((b) => ({ id: b.id, externalBatchId: b.externalBatchId, status: b.status, simulated: b.simulated, createdAt: b.createdAt, completedAt: b.completedAt, counts: countsOf(b.counts) })),
    rowIssues: await rowIssues(ctx, 'GMAPS_EXTENSION'),
    examplePayload: EXTENSION_EXAMPLE_PAYLOAD,
    deliveriesQueued: await ctx.db.webhookEvent.count({ where: { provider: 'GMAPS_EXTENSION', status: 'RECEIVED' } }),
    simulation: simulationGate(ctx, workspace.mode),
  };
}

/**
 * Integration center read models (T28; PRD "Integration center: masked creds, connection tests,
 * real status, template config, quality/limits, internal caps, AI/email setup"; 06-design §11.2.2).
 *
 * - `getIntegrationCenter(ctx)`: one card per IntegrationKind, in catalog order. The status is the
 *   stored `Integration.status`, or NOT_CONFIGURED when nothing is stored: never an invented
 *   Connected. Internal daily caps come from WorkspaceSettings and are labelled internal by the UI;
 *   WhatsApp quality and messaging limit are the raw stored strings or null (shown as Unknown with
 *   the last check time, never a tier list).
 * - `getIntegrationSetup(ctx, kind)`: the card plus the catalog's prerequisites, the webhook path
 *   (only where the receiver exists), the synced WhatsApp templates with raw status and category,
 *   and the integration's recent audited activity.
 *
 * Credentials (plan §9, A33, ADR-25): masked reads only. `secrets` is read solely to know which
 * fields are saved; its values never leave this module. `secretLast4` is shown only when it is four
 * plain characters. Reading needs `leads.read` (the baseline of any assignment); `canManage` is
 * `integrations.manage`.
 */
import type { IntegrationKind, IntegrationStatus } from '@/lib/domain/enums';
import { catalogEntry, INTEGRATION_CATALOG, RESEND_ROUTING_KEY_RE, resendWebhookPath, type IntegrationCatalogEntry, type IntegrationGroup } from '@/lib/domain/integrations';
import { NOT_SENDABLE_LABELS, parseTemplateMapping, templateShape, type QuickReplyIntentValue, type TemplateVariableSource } from '@/lib/domain/whatsapp-templates';
import { NotFoundError } from '@/lib/errors';
import { isQualityRed } from '@/server/adapters/whatsapp/limits';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { CREDENTIAL_UNREADABLE_CODE, CREDENTIAL_UNREADABLE_MESSAGE } from './types';

export type IntegrationConfigValue = { key: string; label: string; value: string | null };
export type MaskedCredential = { field: string; label: string; saved: boolean; last4: string | null; updatedAt: Date | null };

export type IntegrationCardView = {
  kind: IntegrationKind;
  slug: string;
  label: string;
  provider: string;
  group: IntegrationGroup;
  summary: string;
  demoNote: string;
  status: IntegrationStatus;
  /** A row exists for this kind. */
  stored: boolean;
  /** Everything in a DEMO process is simulated (the status chip says so); nothing in LIVE is. */
  simulated: boolean;
  config: IntegrationConfigValue[];
  credentials: MaskedCredential[];
  lastCheckedAt: Date | null;
  verifiedAt: Date | null;
  lastError: { code: string; message: string | null } | null;
  /** "Credential unreadable, re-enter" when a saved secret no longer decrypts (T32); else null. */
  credentialProblem: string | null;
  /** WhatsApp only: raw provider strings, or null when never fetched (shown as Unknown). */
  quality: { qualityRaw: string | null; messagingLimitRaw: string | null; checkedAt: Date | null; pausesAutomation: boolean } | null;
  /** WorkspaceSettings internal daily cap for the channel (an internal cap, not a provider limit). */
  internalDailyCap: number | null;
  /** WhatsApp only: synced template counts. */
  templates: { approved: number; total: number } | null;
};

export type IntegrationWorkspace = { slug: string; name: string; timezone: string; mode: 'DEMO' | 'LIVE' };

export type IntegrationCenterView = {
  mode: 'demo' | 'live';
  workspace: IntegrationWorkspace;
  canManage: boolean;
  cards: IntegrationCardView[];
};

export type TemplateView = {
  id: string;
  name: string;
  language: string;
  /** Raw provider strings (plan §5.1: never enums). */
  category: string;
  status: string;
  intent: string | null;
  variables: string[];
  syncedAt: Date;
  /** T32 mapping (P12): what each body variable holds, the quick-reply buttons and their intents. */
  sources: Record<string, TemplateVariableSource>;
  quickReplies: Array<{ index: number; text: string; intent: QuickReplyIntentValue | null }>;
  documentHeader: boolean;
  /** Null when the template can be sent from this app; otherwise why not, in words. */
  notSendable: string | null;
};

export type IntegrationActivity = { id: string; action: string; result: 'SUCCESS' | 'DENIED' | 'FAILED'; simulated: boolean; outcome: string | null; createdAt: Date };

export type IntegrationSetupView = {
  mode: 'demo' | 'live';
  workspace: IntegrationWorkspace;
  canManage: boolean;
  card: IntegrationCardView;
  entry: IntegrationCatalogEntry;
  webhookUrlPath: string | null;
  templates: TemplateView[];
  activity: IntegrationActivity[];
};

const integrationSelect = {
  id: true,
  kind: true,
  status: true,
  config: true,
  secrets: true,
  secretLast4: true,
  lastCheckedAt: true,
  lastErrorCode: true,
  lastErrorRedacted: true,
  qualityRaw: true,
  messagingLimitRaw: true,
  limitsCheckedAt: true,
  verifiedAt: true,
} as const;

type IntegrationRow = {
  id: string;
  kind: IntegrationKind;
  status: IntegrationStatus;
  config: unknown;
  secrets: unknown;
  secretLast4: unknown;
  lastCheckedAt: Date | null;
  lastErrorCode: string | null;
  lastErrorRedacted: string | null;
  qualityRaw: string | null;
  messagingLimitRaw: string | null;
  limitsCheckedAt: Date | null;
  verifiedAt: Date | null;
};

const LAST4_RE = /^[A-Za-z0-9]{4}$/;
const MAX_CONFIG_CHARS = 200;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function configValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.slice(0, MAX_CONFIG_CHARS);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** `secretLast4[field]` is a string (legacy) or `{ last4, updatedAt }`; anything else is not echoed. */
function maskedCredential(field: { key: string; label: string }, secrets: Record<string, unknown>, last4Map: Record<string, unknown>): MaskedCredential {
  const saved = typeof secrets[field.key] === 'string' && (secrets[field.key] as string).length > 0;
  const raw = last4Map[field.key];
  const last4Raw = typeof raw === 'string' ? raw : typeof record(raw).last4 === 'string' ? (record(raw).last4 as string) : null;
  const updatedRaw = record(raw).updatedAt;
  const updatedAt = typeof updatedRaw === 'string' && !Number.isNaN(Date.parse(updatedRaw)) ? new Date(updatedRaw) : null;
  // updatedAt is shown for any saved value; last4 only when it is four plain characters (T32 stores null for short values).
  return {
    field: field.key,
    label: field.label,
    saved,
    last4: saved && last4Raw !== null && LAST4_RE.test(last4Raw) ? last4Raw : null,
    updatedAt: saved ? updatedAt : null,
  };
}

function capFor(kind: IntegrationKind, settings: { internalWaDailyCap: number | null; internalEmailDailyCap: number | null } | null): number | null {
  if (!settings) return null;
  if (kind === 'WHATSAPP_CLOUD') return settings.internalWaDailyCap;
  if (kind === 'EMAIL_RESEND' || kind === 'EMAIL_SMTP') return settings.internalEmailDailyCap;
  return null;
}

function cardFor(
  ctx: AppCtx,
  entry: IntegrationCatalogEntry,
  row: IntegrationRow | undefined,
  settings: { internalWaDailyCap: number | null; internalEmailDailyCap: number | null } | null,
  templates: { approved: number; total: number } | null,
): IntegrationCardView {
  const config = record(row?.config);
  const secrets = record(row?.secrets);
  const last4 = record(row?.secretLast4);
  return {
    kind: entry.kind,
    slug: entry.slug,
    label: entry.label,
    provider: entry.provider,
    group: entry.group,
    summary: entry.summary,
    demoNote: entry.demoNote,
    status: row?.status ?? 'NOT_CONFIGURED',
    stored: row !== undefined,
    simulated: ctx.mode === 'demo',
    config: entry.configFields.map((f) => ({ key: f.key, label: f.label, value: configValue(config[f.key]) })),
    credentials: entry.credentialFields.map((f) => maskedCredential(f, secrets, last4)),
    lastCheckedAt: row?.lastCheckedAt ?? null,
    verifiedAt: row?.verifiedAt ?? null,
    lastError: row?.lastErrorCode ? { code: row.lastErrorCode, message: row.lastErrorRedacted } : null,
    credentialProblem: row?.lastErrorCode === CREDENTIAL_UNREADABLE_CODE ? CREDENTIAL_UNREADABLE_MESSAGE : null,
    quality:
      entry.kind === 'WHATSAPP_CLOUD'
        ? { qualityRaw: row?.qualityRaw ?? null, messagingLimitRaw: row?.messagingLimitRaw ?? null, checkedAt: row?.limitsCheckedAt ?? null, pausesAutomation: isQualityRed(row?.qualityRaw ?? null) }
        : null,
    internalDailyCap: capFor(entry.kind, settings),
    templates: entry.kind === 'WHATSAPP_CLOUD' ? templates : null,
  };
}

async function workspaceOf(ctx: AppCtx): Promise<IntegrationWorkspace> {
  const workspaceId = requireWorkspace(ctx);
  const ws = await ctx.db.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true, name: true, timezone: true, mode: true } });
  if (!ws) throw new NotFoundError();
  return ws;
}

const isApproved = (status: string) => status.trim().toUpperCase() === 'APPROVED';

async function loadCards(ctx: AppCtx, kinds: readonly IntegrationKind[]): Promise<IntegrationCardView[]> {
  const rows = (await ctx.db.integration.findMany({ where: { kind: { in: [...kinds] } }, select: integrationSelect })) as IntegrationRow[];
  const settings = await ctx.db.workspaceSettings.findFirst({ select: { internalWaDailyCap: true, internalEmailDailyCap: true } });
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  let templates: { approved: number; total: number } | null = null;
  if (kinds.includes('WHATSAPP_CLOUD')) {
    const wa = byKind.get('WHATSAPP_CLOUD');
    const statuses = wa ? await ctx.db.whatsAppTemplate.findMany({ where: { integrationId: wa.id }, select: { status: true } }) : [];
    templates = { approved: statuses.filter((t) => isApproved(t.status)).length, total: statuses.length };
  }
  return kinds.map((kind) => cardFor(ctx, catalogEntry(kind), byKind.get(kind), settings, templates));
}

/** The card for one kind (used by the source pages and the pipeline editor as well). */
export async function loadIntegrationCard(ctx: AppCtx, kind: IntegrationKind): Promise<IntegrationCardView> {
  requireWorkspace(ctx);
  const [card] = await loadCards(ctx, [kind]);
  return card!;
}

export async function getIntegrationCenter(ctx: AppCtx): Promise<IntegrationCenterView> {
  requireCapability(ctx, 'leads.read');
  const workspace = await workspaceOf(ctx);
  const cards = await loadCards(
    ctx,
    INTEGRATION_CATALOG.map((e) => e.kind),
  );
  return { mode: ctx.mode, workspace, canManage: hasCapability(ctx, 'integrations.manage'), cards };
}

function variableNames(schema: unknown): string[] {
  if (!Array.isArray(schema)) return [];
  return schema
    .map((v) => (typeof v === 'string' ? v : typeof v === 'object' && v !== null && 'name' in v ? String((v as { name: unknown }).name) : ''))
    .filter((v) => v.length > 0)
    .slice(0, 20);
}

function templateView(t: { id: string; name: string; language: string; category: string; status: string; intent: string | null; variableSchema: unknown; variableMap: unknown; components: unknown; syncedAt: Date }): TemplateView {
  const shape = templateShape(t.components);
  const mapping = parseTemplateMapping(t.variableMap);
  const fromSchema = variableNames(t.variableSchema);
  return {
    id: t.id,
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    intent: t.intent,
    variables: shape.bodyVariables.length > 0 ? shape.bodyVariables : fromSchema,
    syncedAt: t.syncedAt,
    sources: mapping.body,
    quickReplies: shape.quickReplies.map((q) => ({ index: q.index, text: q.text, intent: mapping.buttons[String(q.index)] ?? null })),
    documentHeader: shape.documentHeader,
    notSendable: shape.sendable.ok ? null : NOT_SENDABLE_LABELS[shape.sendable.reason],
  };
}

export async function getIntegrationSetup(ctx: AppCtx, kind: IntegrationKind): Promise<IntegrationSetupView> {
  requireCapability(ctx, 'leads.read');
  const workspace = await workspaceOf(ctx);
  const entry = catalogEntry(kind);
  const card = await loadIntegrationCard(ctx, kind);
  const row = await ctx.db.integration.findFirst({ where: { kind }, select: { id: true, routingKey: true } });
  // T33: Resend posts to this integration's own URL, which exists once a LIVE write gave it a routing key.
  const webhookUrlPath =
    kind === 'EMAIL_RESEND' ? (ctx.mode === 'live' && row?.routingKey && RESEND_ROUTING_KEY_RE.test(row.routingKey) ? resendWebhookPath(row.routingKey) : null) : entry.webhookPath;

  const templates: TemplateView[] =
    kind === 'WHATSAPP_CLOUD' && row
      ? (
          await ctx.db.whatsAppTemplate.findMany({
            where: { integrationId: row.id },
            orderBy: [{ name: 'asc' }, { language: 'asc' }],
            select: { id: true, name: true, language: true, category: true, status: true, intent: true, variableSchema: true, variableMap: true, components: true, syncedAt: true },
          })
        ).map((t) => templateView(t))
      : [];

  const targets = [{ targetType: 'IntegrationKind', targetId: kind }, ...(row ? [{ targetType: 'Integration', targetId: row.id }] : [])];
  const events = await ctx.db.auditEvent.findMany({
    where: { OR: targets },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 10,
    select: { id: true, action: true, result: true, simulated: true, summary: true, createdAt: true },
  });
  const activity = events.map((e) => {
    const outcome = record(e.summary).outcome;
    return { id: e.id, action: e.action, result: e.result, simulated: e.simulated, outcome: typeof outcome === 'string' ? outcome : null, createdAt: e.createdAt };
  });

  return { mode: ctx.mode, workspace, canManage: hasCapability(ctx, 'integrations.manage'), card, entry, webhookUrlPath, templates, activity };
}

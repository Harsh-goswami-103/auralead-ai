/**
 * The live parts of the Google Sheets page (T34): what the T28 read model (`getSheetsSetup`) does not
 * show. Needs `leads.read`; actions report their own capability (`sheets.manage`).
 *  - The service account to share the Sheet with: its email, project and key id (last four) taken
 *    from the saved key file, which is decrypted here and never leaves this module; the private key
 *    is never read out.
 *  - The Apps Script: key id, when the secret was issued, the endpoint (APP_ORIGIN + path, with a
 *    warning when APP_ORIGIN is not reachable from Google), and the generated script for the active
 *    mapping (LIVE, once a key id exists).
 *  - The active mapping for the editor, the latest sync runs with their counts and errors, and the
 *    drift the latest run was blocked by (until a newer mapping is confirmed).
 */
import type { SheetSyncStatus } from '@/generated/prisma/client';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability } from '@/server/auth/guards';
import { parseServiceAccountKey } from '@/server/adapters/sheets/google';
import type { KeyRing } from '@/server/security/secrets';
import { loadIntegrationForUse } from '@/server/services/integrations/credentials';
import type { SheetsMappingInput } from '@/lib/schemas/sheets';
import { generateAppsScript } from './apps-script';
import { loadActiveMapping, mappedColumns } from './mapping';
import { APPS_SCRIPT_KEY_ID_FIELD, APPS_SCRIPT_SECRET_FIELD } from './secret';
import { lastCursorRow } from './sync';

export const SHEETS_WEBHOOK_PATH = '/api/webhooks/google-sheets';

export type ServiceAccountView =
  | { state: 'saved'; email: string; projectId: string | null; privateKeyIdLast4: string | null }
  | { state: 'missing' | 'unreadable' | 'invalid' };

export type SyncRunView = {
  id: string;
  status: SheetSyncStatus;
  createdAt: Date;
  finishedAt: Date | null;
  fromRow: number | null;
  cursorRow: number | null;
  rowsRead: number;
  created: number;
  duplicate: number;
  review: number;
  rejected: number;
  skipped: number;
  weakIdRows: number;
  pendingRows: number[];
  errorCode: string | null;
  errorMessage: string | null;
  mappingVersion: number | null;
};

export type SheetsLiveView = {
  mode: 'demo' | 'live';
  canManage: boolean;
  integrationStatus: string | null;
  lastError: { code: string; message: string | null } | null;
  serviceAccount: ServiceAccountView;
  sheetName: string | null;
  mapping: (SheetsMappingInput & { version: number; columns: string[] | null }) | null;
  appsScript: { keyId: string | null; secretIssuedAt: Date | null; endpoint: string; originReachable: boolean; script: string | null };
  sync: { runs: SyncRunView[]; cursorRow: number; open: boolean; drift: { added: string[]; removed: string[] } | null };
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Google's servers must reach the endpoint: a loopback or private host never works. */
export function originReachableFromGoogle(appOrigin: string): boolean {
  try {
    const u = new URL(appOrigin);
    if (u.protocol !== 'https:') return false;
    return !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(u.hostname) && u.hostname.includes('.');
  } catch {
    return false;
  }
}

export async function getSheetsLiveView(ctx: AppCtx, deps: { keyRing: KeyRing | null; appOrigin: string; now: Date }): Promise<SheetsLiveView> {
  requireCapability(ctx, 'leads.read');
  const row = await ctx.db.integration.findFirst({ where: { kind: 'GOOGLE_SHEETS' }, select: { id: true, status: true, config: true, secretLast4: true, lastErrorCode: true, lastErrorRedacted: true } });
  const endpoint = `${deps.appOrigin.replace(/\/$/, '')}${SHEETS_WEBHOOK_PATH}`;
  const base: SheetsLiveView = {
    mode: ctx.mode,
    canManage: hasCapability(ctx, 'sheets.manage'),
    integrationStatus: row?.status ?? null,
    lastError: row?.lastErrorCode ? { code: row.lastErrorCode, message: row.lastErrorRedacted } : null,
    serviceAccount: { state: 'missing' },
    sheetName: null,
    mapping: null,
    appsScript: { keyId: null, secretIssuedAt: null, endpoint, originReachable: originReachableFromGoogle(deps.appOrigin), script: null },
    sync: { runs: [], cursorRow: 1, open: false, drift: null },
  };
  if (!row) return base;

  let serviceAccount: ServiceAccountView = { state: 'missing' };
  if (ctx.mode === 'live') {
    const use = await loadIntegrationForUse(ctx.db, 'GOOGLE_SHEETS', deps.keyRing);
    if (use?.credentials.state === 'unreadable') serviceAccount = { state: 'unreadable' };
    else if (use?.credentials.state === 'ok' && use.credentials.values.serviceAccountJson) {
      const key = parseServiceAccountKey(use.credentials.values.serviceAccountJson);
      serviceAccount = key ? { state: 'saved', email: key.clientEmail, projectId: key.projectId, privateKeyIdLast4: key.privateKeyId ? key.privateKeyId.slice(-4) : null } : { state: 'invalid' };
    }
  }
  const config = record(row.config);
  const sheetName = typeof config.sheetName === 'string' && config.sheetName.trim() !== '' ? config.sheetName.trim() : null;
  const sheetId = typeof config.sheetId === 'string' ? config.sheetId : null;
  const keyId = typeof config[APPS_SCRIPT_KEY_ID_FIELD] === 'string' ? (config[APPS_SCRIPT_KEY_ID_FIELD] as string) : null;
  const issued = record(record(row.secretLast4)[APPS_SCRIPT_SECRET_FIELD]);
  const secretIssuedAt = typeof issued.updatedAt === 'string' ? new Date(issued.updatedAt) : null;

  const active = await loadActiveMapping(ctx.db as never, row.id);
  const script =
    ctx.mode === 'live' && keyId && sheetId && active
      ? generateAppsScript({ endpoint, keyId, sheetId, sheetName, mappingVersion: active.version, columns: mappedColumns(active), submittedAtColumn: active.submittedAtColumn, generatedAt: deps.now })
      : null;

  const runs = await ctx.db.sheetSyncRun.findMany({ where: { integrationId: row.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 5 });
  const runViews: SyncRunView[] = runs.map((r) => ({
    id: r.id,
    status: r.status,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
    fromRow: r.fromRow,
    cursorRow: r.cursorRow,
    rowsRead: r.rowsRead,
    created: r.created,
    duplicate: r.duplicate,
    review: r.review,
    rejected: r.rejected,
    skipped: r.skipped,
    weakIdRows: r.weakIdRows,
    pendingRows: (Array.isArray(record(r.detail).pendingRows) ? (record(r.detail).pendingRows as unknown[]) : []).filter((n): n is number => typeof n === 'number'),
    errorCode: r.errorCode,
    errorMessage: r.errorRedacted,
    mappingVersion: r.mappingVersion,
  }));
  const latest = runs[0];
  const drift =
    latest && latest.status === 'BLOCKED' && active && latest.mappingVersion === active.version ? { added: strings(record(latest.detail).added), removed: strings(record(latest.detail).removed) } : null;

  return {
    ...base,
    serviceAccount,
    sheetName,
    mapping: active ? { version: active.version, columns: active.headerColumns, fieldMap: active.fieldMap, submittedAtColumn: active.submittedAtColumn, consent: active.consent ? { column: active.consent.column, truthyValues: active.consent.truthyValues, channel: active.consent.channel, purpose: active.consent.purpose, noticeText: active.consent.noticeText, ...(active.consent.noticeVersion ? { noticeVersion: active.consent.noticeVersion } : {}) } : null } : null,
    appsScript: { ...base.appsScript, keyId, secretIssuedAt, script },
    sync: { runs: runViews, cursorRow: await lastCursorRow(ctx, row.id), open: runs.some((r) => r.status === 'QUEUED' || r.status === 'RUNNING'), drift },
  };
}

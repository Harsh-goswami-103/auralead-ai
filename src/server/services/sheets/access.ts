/**
 * Live access to a workspace's Google Sheet (T34; P14, ADR-16): decrypt the service account key
 * (outside any transaction), build the client through the adapter registry, read the tab list and
 * time zone, row 1 and data rows, and turn every failure into a stable code with guidance a person
 * can act on. The connection test (`sheetsTester`, registered in LIVE_CONNECTION_TESTERS) is the
 * header read: CONNECTED only when Google answered with the Sheet's row 1; a 403 is "not shared
 * with the service account" and names the address to share with; throttling or no answer never
 * passes and never fails the credentials (ADR-99 rule).
 */
import { AppError, DomainRuleError, ProviderUnavailableError } from '@/lib/errors';
import type { IntegrationStatus } from '@/lib/domain/enums';
import { sheetsReadClient, type SheetsSeams } from '@/server/adapters/registry';
import { a1Rows, type GoogleSheetsClient, type SheetsCall } from '@/server/adapters/sheets/google';
import type { AppCtx } from '@/server/auth/context';
import type { KeyRing } from '@/server/security/secrets';
import { loadIntegrationForUse } from '@/server/services/integrations/credentials';
import type { LiveConnectionTester, LiveTestOutcome } from '@/server/services/integrations/types';
import { CREDENTIAL_UNREADABLE_CODE, CREDENTIAL_UNREADABLE_MESSAGE } from '@/server/services/integrations/types';
import { analyzeHeader, type HeaderInfo } from './header';

export type SheetsDeps = { keyRing: KeyRing | null; sheets?: SheetsSeams };

export type SheetsFailureCode =
  | 'SHEETS_LIVE_ONLY'
  | 'INTEGRATION_NOT_CONFIGURED'
  | 'CREDENTIAL_UNREADABLE'
  | 'SHEET_NOT_SHARED'
  | 'SHEETS_API_DISABLED'
  | 'CONFIG_INVALID'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_UNREACHABLE'
  | 'PROVIDER_REJECTED';

export type SheetsFailure = { code: SheetsFailureCode; message: string; transient: boolean };

export type Result<T> = { ok: true; value: T } | { ok: false; failure: SheetsFailure };

export type OpenedSheets = {
  integration: { id: string; workspaceId: string; status: IntegrationStatus; config: Readonly<Record<string, unknown>> };
  client: GoogleSheetsClient;
  sheetName: string | null;
};

export type SheetHeaderRead = { tab: string; timeZone: string | null; header: HeaderInfo };

/** Throttling or no answer says nothing about the credentials (same rule as live-testers.ts). */
function inconclusive(previous: IntegrationStatus): LiveTestOutcome['status'] {
  return previous === 'CONNECTED' || previous === 'DEGRADED' ? 'DEGRADED' : 'CONFIGURED_UNVERIFIED';
}

const fail = (code: SheetsFailureCode, message: string, transient = false): { ok: false; failure: SheetsFailure } => ({ ok: false, failure: { code, message, transient } });

/** The guidance for "not shared": who to share with and how. */
export function notSharedGuidance(serviceAccountEmail: string): string {
  return `Google refused access: the Sheet is not shared with the service account. Open the Sheet, choose Share, add ${serviceAccountEmail} as a Viewer (untick "Notify people"), then try again. A Sheet URL alone grants no access.`;
}

function callFailure(call: Extract<SheetsCall<unknown>, { ok: false }>, client: GoogleSheetsClient, tab: string | null): { ok: false; failure: SheetsFailure } {
  const detail = call.status ? ` (HTTP ${call.status}: ${call.message})` : ` (${call.message})`;
  switch (call.kind) {
    case 'not-shared':
      return fail('SHEET_NOT_SHARED', notSharedGuidance(client.serviceAccountEmail));
    case 'api-disabled':
      return fail('SHEETS_API_DISABLED', `The Google Sheets API is not enabled in the service account's Cloud project. Enable it in Google Cloud console > APIs & Services, wait a few minutes, then try again.${detail}`);
    case 'not-found':
      return fail('CONFIG_INVALID', `Google has no spreadsheet with the ID ${client.spreadsheetId}. Check the spreadsheet ID in the setup.${detail}`);
    case 'bad-range':
      return fail('CONFIG_INVALID', `The tab ${JSON.stringify(tab ?? '')} is not in the spreadsheet. Check the tab name in the setup.${detail}`);
    case 'auth':
      return fail('PROVIDER_AUTH', `Google rejected the service account key (deleted, disabled or revoked). Create a new JSON key and save it in the setup.${detail}`);
    case 'rate-limited':
      return fail('PROVIDER_RATE_LIMITED', `Google is throttling requests; try again later.${detail}`, true);
    case 'unavailable':
      return fail('PROVIDER_UNAVAILABLE', `Google Sheets is not answering normally; try again later.${detail}`, true);
    case 'unreachable':
      return fail('PROVIDER_UNREACHABLE', `Google could not be reached; try again later.${detail}`, true);
    case 'rejected':
      return fail('PROVIDER_REJECTED', `Google refused the request.${detail}`);
  }
}

export async function openSheets(ctx: AppCtx, deps: SheetsDeps): Promise<Result<OpenedSheets>> {
  if (ctx.mode !== 'live') return fail('SHEETS_LIVE_ONLY', 'DEMO never contacts Google. Form rows come from the simulator on this page; reading a real Sheet happens in a LIVE install.');
  const use = await loadIntegrationForUse(ctx.db, 'GOOGLE_SHEETS', deps.keyRing);
  const built = sheetsReadClient({ mode: ctx.mode, integration: use, clock: ctx.clock, ...(deps.sheets ? { sheets: deps.sheets } : {}) });
  if (!built.ok) {
    if (built.code === 'CREDENTIAL_UNREADABLE') return fail('CREDENTIAL_UNREADABLE', `${CREDENTIAL_UNREADABLE_MESSAGE} (the service account key).`);
    return fail('INTEGRATION_NOT_CONFIGURED', `Google Sheets is not ready: ${built.reason}. Save the service account key and spreadsheet ID in the setup first.`);
  }
  const sheetName = typeof use!.config.sheetName === 'string' && use!.config.sheetName.trim() !== '' ? use!.config.sheetName.trim() : null;
  return { ok: true, value: { integration: { id: use!.id, workspaceId: ctx.workspaceId!, status: use!.status, config: use!.config }, client: built.value, sheetName } };
}

/** The tabs and time zone, then row 1 of the configured tab (or the first tab). */
export async function readSheetHeader(opened: OpenedSheets): Promise<Result<SheetHeaderRead>> {
  const meta = await opened.client.getMeta();
  if (!meta.ok) return callFailure(meta, opened.client, opened.sheetName);
  const tab = opened.sheetName ?? meta.data.tabs[0] ?? null;
  if (tab === null) return fail('CONFIG_INVALID', 'The spreadsheet has no tabs.');
  if (!meta.data.tabs.includes(tab)) return fail('CONFIG_INVALID', `The tab ${JSON.stringify(tab)} is not in the spreadsheet (tabs: ${meta.data.tabs.slice(0, 10).join(', ')}). Check the tab name in the setup.`);
  const row = await opened.client.getValues(a1Rows(tab, 1, 1), 'formatted');
  if (!row.ok) return callFailure(row, opened.client, tab);
  return { ok: true, value: { tab, timeZone: meta.data.timeZone, header: analyzeHeader(row.data.values[0] ?? []) } };
}

/** Data rows `from..to` of the tab, unformatted (numbers stay numbers, dates are serials). */
export async function readSheetRows(opened: OpenedSheets, tab: string, from: number, to: number): Promise<Result<unknown[][]>> {
  const rows = await opened.client.getValues(a1Rows(tab, from, to), 'unformatted');
  if (!rows.ok) return callFailure(rows, opened.client, tab);
  return { ok: true, value: rows.data.values };
}

/** A failure as the HTTP error of a person's request: transient ones are 503, the rest 422 with the guidance. */
export function failureError(failure: SheetsFailure): AppError {
  if (failure.transient) return new ProviderUnavailableError({ code: failure.code, userMessage: failure.message, retryAfterSeconds: 30 });
  return new DomainRuleError({ code: failure.code, userMessage: failure.message });
}

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw failureError(result.failure);
  return result.value;
}

export function failureOutcome(failure: SheetsFailure, previous: IntegrationStatus): LiveTestOutcome {
  if (failure.code === 'CREDENTIAL_UNREADABLE') return { status: 'ERROR', errorCode: CREDENTIAL_UNREADABLE_CODE, errorMessage: CREDENTIAL_UNREADABLE_MESSAGE };
  if (failure.code === 'INTEGRATION_NOT_CONFIGURED' || failure.code === 'SHEETS_LIVE_ONLY') return { status: previous === 'ERROR' ? 'ERROR' : 'CONFIGURED_UNVERIFIED', errorCode: 'INTEGRATION_NOT_CONFIGURED', errorMessage: failure.message };
  if (failure.transient) return { status: inconclusive(previous), errorCode: failure.code, errorMessage: failure.message };
  return { status: 'ERROR', errorCode: failure.code, errorMessage: failure.message };
}

/** The live connection test: the header read, CONNECTED only on Google's answer with row 1. */
export function sheetsTester(deps: SheetsDeps): LiveConnectionTester {
  return async (ctx, integration) => {
    const opened = await openSheets(ctx, deps);
    if (!opened.ok) return failureOutcome(opened.failure, integration.status);
    const header = await readSheetHeader(opened.value);
    if (!header.ok) return failureOutcome(header.failure, integration.status);
    return { status: 'CONNECTED' };
  };
}

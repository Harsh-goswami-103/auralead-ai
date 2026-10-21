/**
 * Google Sheets API adapter (T34; plan §5.6, P14, ADR-16, ADR-103). LIVE only: built by
 * `adapters/registry.ts` from a workspace's integration, never in DEMO.
 *
 * Access is a service account the workspace shares its Sheet with (read-only scope
 * `spreadsheets.readonly`); a Sheet URL alone grants nothing. The OAuth token is obtained with
 * google-auth-library's JWT client (it signs the assertion with the key from the stored JSON), and
 * its HTTP transport is replaced by `fetchImplementation` over our own seam: every request, the
 * token exchange included, goes through `adapters/http/outbound.ts` (which refuses every host in
 * DEMO), only to the two Google hosts below, with library retries off (failures are reported, not
 * hidden behind retries). Reads:
 *  - `GET /v4/spreadsheets/{id}?fields=properties.timeZone,sheets.properties.title` (tabs and the
 *    time zone serial dates are in);
 *  - `GET /v4/spreadsheets/{id}/values/{range}` with `majorDimension=ROWS` and either
 *    FORMATTED_VALUE (the header) or UNFORMATTED_VALUE + SERIAL_NUMBER (rows: phone numbers stay
 *    numbers, dates are serials).
 * Failures are classified from the HTTP status and Google's error body: 403 PERMISSION_DENIED is
 * "not shared with the service account", a 403 naming SERVICE_DISABLED / accessNotConfigured / "has
 * not been used in project" is "Sheets API not enabled", 404 an unknown spreadsheet, 400 "Unable to
 * parse range" a wrong tab, 401 and token-endpoint `invalid_grant` a rejected key, 429 throttling,
 * 5xx unavailable, a thrown request unreachable. The access token and the private key never reach
 * an error text. Shapes are UNVERIFIED (docs/integrations.md: developers.google.com was not
 * reachable; fixtures in tests/fixtures/sheets/documented-shape).
 */
import { JWT } from 'google-auth-library';
import type { Clock } from '@/lib/clock';
import { outboundFailureLabel, outboundRequest, type OutboundMode, type OutboundRequest, type OutboundResponse } from '../http/outbound';

export const SHEETS_API_BASE_URL = 'https://sheets.googleapis.com';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
export const SHEETS_CHECKED_ON = '2026-10-20';
const TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
const MESSAGE_MAX = 300;

export type SheetsHttp = (url: string, init: OutboundRequest) => Promise<OutboundResponse>;

export type ServiceAccountKey = { clientEmail: string; privateKey: string; projectId: string | null; privateKeyId: string | null };

/** The fields of a service account key file the adapter uses, or null when it is not one. */
export function parseServiceAccountKey(json: string): ServiceAccountKey | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (o.type !== 'service_account' || typeof o.client_email !== 'string' || typeof o.private_key !== 'string' || !o.private_key.includes('PRIVATE KEY')) return null;
  return {
    clientEmail: o.client_email,
    privateKey: o.private_key,
    projectId: typeof o.project_id === 'string' ? o.project_id : null,
    privateKeyId: typeof o.private_key_id === 'string' ? o.private_key_id : null,
  };
}

export type SheetsFailureKind = 'not-shared' | 'api-disabled' | 'not-found' | 'bad-range' | 'auth' | 'rate-limited' | 'unavailable' | 'unreachable' | 'rejected';

export type SheetsCall<T> = { ok: true; data: T } | { ok: false; kind: SheetsFailureKind; status: number | null; message: string; retryAfterMs?: number };

export type SpreadsheetMeta = { timeZone: string | null; tabs: string[] };
export type SheetValues = { range: string | null; values: unknown[][] };

export type GoogleSheetsClient = {
  readonly spreadsheetId: string;
  readonly serviceAccountEmail: string;
  getMeta(): Promise<SheetsCall<SpreadsheetMeta>>;
  getValues(range: string, render: 'formatted' | 'unformatted'): Promise<SheetsCall<SheetValues>>;
};

export type GoogleSheetsOptions = {
  mode: OutboundMode;
  serviceAccount: ServiceAccountKey;
  spreadsheetId: string;
  clock: Clock;
  /** Test seam (scripted answers); production uses outbound.ts. */
  http?: SheetsHttp;
  timeoutMs?: number;
};

/** A1 notation for whole rows of a tab: `'Form Responses 1'!2:201` (quotes doubled inside the name). */
export function a1Rows(tab: string, from: number, to: number): string {
  return `'${tab.replace(/'/g, "''")}'!${from}:${to}`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function headerValue(headers: OutboundResponse['headers'], name: string): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === 'string' ? v : null;
}

function retryAfter(headers: OutboundResponse['headers'], now: Date): number | undefined {
  const raw = headerValue(headers, 'retry-after');
  if (raw === null || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - now.getTime();
  if (Number.isNaN(ms)) return undefined;
  return Math.min(Math.max(0, Math.ceil(ms)), MAX_RETRY_AFTER_MS);
}

/** Classifies a Google API error answer (exported for the token path and the tests). */
export function classifySheetsError(status: number, body: string): { kind: SheetsFailureKind; message: string } {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = record(JSON.parse(body));
  } catch {
    parsed = {};
  }
  const error = record(parsed.error);
  const message = typeof error.message === 'string' ? error.message : typeof parsed.error_description === 'string' ? parsed.error_description : `HTTP ${status}`;
  const reasons = [
    ...(Array.isArray(error.details) ? error.details.map((d) => String(record(d).reason ?? '')) : []),
    ...(Array.isArray(error.errors) ? error.errors.map((d) => String(record(d).reason ?? '')) : []),
  ];
  const tokenError = typeof parsed.error === 'string' ? parsed.error : '';
  let kind: SheetsFailureKind;
  if (tokenError === 'invalid_grant' || tokenError === 'invalid_client' || tokenError === 'unauthorized_client' || status === 401) kind = 'auth';
  else if (status === 403 && (reasons.includes('SERVICE_DISABLED') || reasons.includes('accessNotConfigured') || /has not been used in project|is disabled/i.test(message))) kind = 'api-disabled';
  else if (status === 403) kind = 'not-shared';
  else if (status === 404) kind = 'not-found';
  else if (status === 400 && /parse range/i.test(message)) kind = 'bad-range';
  else if (status === 429) kind = 'rate-limited';
  else if (status >= 500) kind = 'unavailable';
  else kind = 'rejected';
  return { kind, message: message.slice(0, MESSAGE_MAX) };
}

function scrubber(secrets: readonly string[]): (text: string) => string {
  return (text) => secrets.reduce((t, s) => (s.length >= 8 ? t.split(s).join('[REDACTED]') : t), text);
}

function headersToRecord(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers instanceof Headers) headers.forEach((v, k) => (out[k.toLowerCase()] = v));
  else for (const [k, v] of Object.entries(record(headers))) if (typeof v === 'string') out[k.toLowerCase()] = v;
  return out;
}

function flatHeaders(headers: OutboundResponse['headers']): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) for (const x of v) out.append(k, x);
    else if (typeof v === 'string') out.set(k, v);
  }
  return out;
}

const ALLOWED_TOKEN_URL = new URL(GOOGLE_TOKEN_URL);

export function createGoogleSheetsClient(options: GoogleSheetsOptions): GoogleSheetsClient {
  const http: SheetsHttp = options.http ?? ((url, init) => outboundRequest(options.mode, url, init, options.clock.now()));
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const spreadsheetId = options.spreadsheetId;
  let accessToken = '';
  const scrub = () => scrubber([accessToken, options.serviceAccount.privateKey]);

  // google-auth-library's token request, carried by our seam. Only Google's token endpoint is reachable from here.
  const fetchImplementation = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.origin !== ALLOWED_TOKEN_URL.origin || url.pathname !== ALLOWED_TOKEN_URL.pathname) throw new Error(`token request to an unexpected host ${url.host}`);
    const headers = headersToRecord(init?.headers);
    let body: string | undefined;
    if (init?.body instanceof URLSearchParams) {
      body = init.body.toString();
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
    } else if (typeof init?.body === 'string') body = init.body;
    const res = await http(url.toString(), { method: 'POST', headers, ...(body !== undefined ? { body } : {}), headersTimeoutMs: timeoutMs, bodyTimeoutMs: timeoutMs });
    return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode, headers: flatHeaders(res.headers) });
  };
  const jwt = new JWT({
    email: options.serviceAccount.clientEmail,
    key: options.serviceAccount.privateKey,
    scopes: [SHEETS_READONLY_SCOPE],
    transporterOptions: { fetchImplementation: fetchImplementation as typeof fetch, retryConfig: { retry: 0, noResponseRetries: 0 }, noProxy: [/.*/] },
  });

  async function token(): Promise<{ ok: true } | Extract<SheetsCall<never>, { ok: false }>> {
    if (accessToken) return { ok: true };
    try {
      const got = await jwt.getAccessToken();
      if (!got.token) return { ok: false, kind: 'auth', status: null, message: 'Google returned no access token for the service account.' };
      accessToken = got.token;
      return { ok: true };
    } catch (error) {
      const response = (error as { response?: { status?: number; data?: unknown } }).response;
      if (response && typeof response.status === 'number') {
        const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? {});
        const c = classifySheetsError(response.status, body);
        return { ok: false, kind: c.kind === 'rejected' ? 'auth' : c.kind, status: response.status, message: scrub()(c.message) };
      }
      const label = outboundFailureLabel((error as { cause?: unknown }).cause ?? error);
      // A key that cannot sign never reached the network.
      if (/key|PEM|DECODER|asn1/i.test(String((error as Error).message ?? ''))) return { ok: false, kind: 'auth', status: null, message: 'The private key in the service account file cannot be used to sign; download a new key.' };
      return { ok: false, kind: 'unreachable', status: null, message: `Google could not be reached (${label}).` };
    }
  }

  async function get<T>(path: string, query: Record<string, string>, parse: (body: Record<string, unknown>) => T): Promise<SheetsCall<T>> {
    const t = await token();
    if (!t.ok) return t;
    const url = new URL(`${SHEETS_API_BASE_URL}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res: OutboundResponse;
    try {
      res = await http(url.toString(), { method: 'GET', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, headersTimeoutMs: timeoutMs, bodyTimeoutMs: timeoutMs });
    } catch (error) {
      return { ok: false, kind: 'unreachable', status: null, message: `Google could not be reached (${outboundFailureLabel(error)}).` };
    }
    if (res.statusCode >= 200 && res.statusCode < 300) {
      try {
        return { ok: true, data: parse(record(JSON.parse(res.body))) };
      } catch {
        return { ok: false, kind: 'rejected', status: res.statusCode, message: 'Google answered with a body that is not JSON.' };
      }
    }
    const c = classifySheetsError(res.statusCode, res.body);
    const after = retryAfter(res.headers, options.clock.now());
    return { ok: false, kind: c.kind, status: res.statusCode, message: scrub()(c.message), ...(after !== undefined ? { retryAfterMs: after } : {}) };
  }

  const base = `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
  return {
    spreadsheetId,
    serviceAccountEmail: options.serviceAccount.clientEmail,
    getMeta: () =>
      get(base, { fields: 'properties.timeZone,sheets.properties.title' }, (body) => ({
        timeZone: typeof record(body.properties).timeZone === 'string' ? (record(body.properties).timeZone as string) : null,
        tabs: (Array.isArray(body.sheets) ? body.sheets : []).map((s) => record(record(s).properties).title).filter((t): t is string => typeof t === 'string'),
      })),
    getValues: (range, render) =>
      get(
        `${base}/values/${encodeURIComponent(range)}`,
        render === 'formatted' ? { majorDimension: 'ROWS', valueRenderOption: 'FORMATTED_VALUE' } : { majorDimension: 'ROWS', valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' },
        (body) => ({ range: typeof body.range === 'string' ? body.range : null, values: (Array.isArray(body.values) ? body.values : []).map((r) => (Array.isArray(r) ? (r as unknown[]) : [])) }),
      ),
  };
}

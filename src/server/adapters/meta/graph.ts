/**
 * Meta Graph API and Marketing API adapter (T35; plan §4.4, §9, §13, P1, P6, AT14). LIVE only: the
 * clients are built by `adapters/registry.ts` from a workspace's integration, and every request
 * goes through `adapters/http/outbound.ts` (which blocks every host in DEMO, so a mis-wired DEMO
 * process still makes zero outbound calls).
 *
 * Two clients, two versions (plan §11 T35, §13: "META_GRAPH_VERSION and META_MARKETING_VERSION
 * separate"; Meta documents a two-year lifetime for Graph versions and a shorter, 90-day overlap
 * for Marketing API versions, UNVERIFIED):
 *  - `createMetaLeadsClient` (META_GRAPH_VERSION): the Page (connection test), one lead by its
 *    leadgen id (`meta.lead.fetch`), and a form's leads created after a time (the backfill);
 *  - `createMetaMarketingClient` (META_MARKETING_VERSION): the ad account (currency, connection
 *    test), its campaigns, campaign-level insights, one campaign's status (read-back) and the
 *    status change (pause / resume).
 * Ids are validated as digits before they reach a URL, the access token travels only in the
 * Authorization header and is scrubbed from every provider text, and errors are bounded and
 * redacted. Failures are classified by `classifyMetaFailure`, which names the permission the
 * operation needs (leads_retrieval, ads_read, ads_management, ...) when Meta refuses one.
 *
 * Request and response shapes follow Meta's published references (developers.facebook.com, read
 * through search snippets only on 2026-10-20; the documentation host is blocked in the build
 * environment) and are UNVERIFIED until a live check; see docs/integrations.md.
 */
import type { Clock } from '@/lib/clock';
import { redactText } from '@/lib/redact';
import { outboundFailureLabel, outboundFailurePhase, outboundRequest, type OutboundMode, type OutboundResponse } from '../http/outbound';
import { GRAPH_DEFAULT_BASE_URL, GRAPH_ID_RE, GRAPH_VERSION_RE, retryAfterMs, type GraphCall, type GraphErrorInfo, type GraphHttp } from '../whatsapp/cloud-api';
import type { CampaignStatusRead, FetchedAdAccount, FetchedCampaign, FetchedInsight } from './port';

export const META_CHECKED_ON = '2026-10-20';
export const META_PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ERROR = 500;
const MAX_RAW = 64;

/** Lead fields read by id and by form (custom disclaimer answers carry consent checkboxes, UNVERIFIED). */
export const LEAD_FIELDS = ['id', 'created_time', 'ad_id', 'form_id', 'campaign_id', 'field_data', 'custom_disclaimer_responses'] as const;
export const CAMPAIGN_FIELDS = ['id', 'name', 'status', 'configured_status', 'effective_status'] as const;
export const AD_ACCOUNT_FIELDS = ['id', 'account_id', 'name', 'currency', 'timezone_name', 'account_status'] as const;
export const INSIGHT_FIELDS = ['campaign_id', 'campaign_name', 'spend', 'actions', 'cost_per_action_type', 'date_start', 'date_stop', 'attribution_setting'] as const;
/** Action types counted as leads, in order of preference (UNVERIFIED: Meta's action type list). */
export const LEAD_ACTION_TYPES = ['lead', 'onsite_conversion.lead_grouped', 'leadgen_grouped'] as const;
export const INSIGHTS_DATE_PRESET = 'last_7d';

export type MetaClientOptions = {
  /** The process mode; outbound.ts refuses every host in DEMO. */
  mode: OutboundMode;
  /** META_GRAPH_VERSION for the leads client, META_MARKETING_VERSION for the marketing client. */
  version: string;
  accessToken: string;
  clock: Clock;
  /** Test seam (a local fake server); production uses graph.facebook.com. */
  baseUrl?: string;
  /** Test seam (scripted answers); production uses outbound.ts. */
  http?: GraphHttp;
  timeoutMs?: number;
};

export type GraphPage = { data: unknown[]; after: string | null };

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function bounded(text: string): string {
  return redactText(text).slice(0, MAX_ERROR);
}

function parseError(body: string, scrub: (t: string) => string): GraphErrorInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { code: null, subcode: null, type: null, message: 'the provider answered with a body that is not JSON' };
  }
  const e = record(record(parsed).error);
  const userMsg = typeof e.error_user_msg === 'string' && e.error_user_msg.length > 0 ? ` (${e.error_user_msg})` : '';
  const message = `${typeof e.message === 'string' ? e.message : 'no error message'}${userMsg}`;
  const code = typeof e.code === 'number' || typeof e.code === 'string' ? String(e.code) : null;
  const subcode = typeof e.error_subcode === 'number' || typeof e.error_subcode === 'string' ? String(e.error_subcode) : null;
  return { code, subcode, type: typeof e.type === 'string' ? e.type : null, message: bounded(scrub(message)) };
}

type Body = { contentType: string; payload: string };

function graphCaller(opts: MetaClientOptions) {
  if (!GRAPH_VERSION_RE.test(opts.version)) throw new RangeError('Meta API version must look like v24.0');
  if (opts.accessToken.length === 0) throw new RangeError('Meta access token is empty');
  const base = (opts.baseUrl ?? GRAPH_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const http: GraphHttp = opts.http ?? ((url, init) => outboundRequest(opts.mode, url, init, opts.clock.now()));
  const secret = opts.accessToken;
  const scrub = (text: string) => text.split(secret).join('[REDACTED]');
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function call<T>(method: 'GET' | 'POST', path: string, query: URLSearchParams | null, body: Body | null, read: (json: unknown) => T | null): Promise<GraphCall<T>> {
    const headers: Record<string, string> = { authorization: `Bearer ${secret}`, accept: 'application/json' };
    if (body) headers['content-type'] = body.contentType;
    const qs = query && [...query.keys()].length > 0 ? `?${query.toString()}` : '';
    let res: OutboundResponse;
    try {
      res = await http(`${base}/${opts.version}${path}${qs}`, { method, headers, body: body?.payload, headersTimeoutMs: timeout, bodyTimeoutMs: timeout });
    } catch (error) {
      return { ok: false, phase: outboundFailurePhase(error), status: null, error: { code: null, subcode: null, type: null, message: bounded(scrub(outboundFailureLabel(error))) } };
    }
    if (res.statusCode >= 200 && res.statusCode < 300) {
      let json: unknown = null;
      try {
        json = JSON.parse(res.body);
      } catch {
        json = null;
      }
      const data = read(json);
      if (data !== null) return { ok: true, status: res.statusCode, data };
      return { ok: false, phase: 'response', status: res.statusCode, error: { code: null, subcode: null, type: null, message: 'the provider answer did not have the documented shape' } };
    }
    const after = retryAfterMs(res.headers, opts.clock.now());
    return { ok: false, phase: 'response', status: res.statusCode, error: parseError(res.body, scrub), ...(after !== undefined ? { retryAfterMs: after } : {}) };
  };
}

const asRecord = (json: unknown) => (typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : null);

/** A list answer: `data` plus the `after` cursor only when the answer says a next page exists (its URL is never followed). */
function asPage(json: unknown): GraphPage | null {
  const o = asRecord(json);
  if (!o || !Array.isArray(o.data)) return null;
  const paging = record(o.paging);
  const after = record(paging.cursors).after;
  const hasNext = typeof paging.next === 'string';
  return { data: o.data, after: hasNext && typeof after === 'string' && after.length > 0 ? after : null };
}

function digits(id: string, what: string): string {
  if (!GRAPH_ID_RE.test(id)) throw new RangeError(`${what} must be digits`);
  return id;
}

/** `act_123` or `123` -> `123`. */
export function adAccountDigits(value: string): string | null {
  const v = value.trim().replace(/^act_/, '');
  return GRAPH_ID_RE.test(v) ? v : null;
}

// ---- Leads client (META_GRAPH_VERSION) -----------------------------------------------------------------

export type MetaLeadsClient = {
  readonly version: string;
  getPage(pageId: string): Promise<GraphCall<Record<string, unknown>>>;
  getLead(leadgenId: string): Promise<GraphCall<Record<string, unknown>>>;
  /** Leads of one form created after `sinceUnix` (seconds), newest pages first as Meta returns them. */
  listFormLeads(formId: string, opts: { sinceUnix: number; after: string | null; limit?: number }): Promise<GraphCall<GraphPage>>;
};

export function createMetaLeadsClient(opts: MetaClientOptions): MetaLeadsClient {
  const call = graphCaller(opts);
  return {
    version: opts.version,
    getPage: (pageId) => call('GET', `/${digits(pageId, 'page id')}`, new URLSearchParams({ fields: 'id,name' }), null, asRecord),
    getLead: (leadgenId) => call('GET', `/${digits(leadgenId, 'leadgen id')}`, new URLSearchParams({ fields: LEAD_FIELDS.join(',') }), null, asRecord),
    listFormLeads: (formId, { sinceUnix, after, limit }) => {
      if (!Number.isInteger(sinceUnix) || sinceUnix < 0) throw new RangeError('sinceUnix must be a non-negative integer');
      const q = new URLSearchParams({
        fields: LEAD_FIELDS.join(','),
        limit: String(Math.max(1, Math.min(limit ?? META_PAGE_SIZE, META_PAGE_SIZE))),
        filtering: JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: sinceUnix }]),
      });
      if (after) q.set('after', after);
      return call('GET', `/${digits(formId, 'form id')}/leads`, q, null, asPage);
    },
  };
}

// ---- Marketing client (META_MARKETING_VERSION) ---------------------------------------------------------

export type MetaMarketingClient = {
  readonly version: string;
  /** Digits only (the `act_` prefix is added to paths). */
  readonly adAccountId: string;
  getAdAccount(): Promise<GraphCall<Record<string, unknown>>>;
  listCampaigns(opts: { after: string | null; limit?: number }): Promise<GraphCall<GraphPage>>;
  listCampaignInsights(opts: { datePreset: string; after: string | null; limit?: number }): Promise<GraphCall<GraphPage>>;
  getCampaign(campaignId: string): Promise<GraphCall<Record<string, unknown>>>;
  /** `POST /<campaign id>` with `status`; a write (the caller follows the outbox rule, plan §4.4). */
  setCampaignStatus(campaignId: string, status: 'PAUSED' | 'ACTIVE'): Promise<GraphCall<Record<string, unknown>>>;
};

export function createMetaMarketingClient(opts: MetaClientOptions & { adAccountId: string }): MetaMarketingClient {
  const account = adAccountDigits(opts.adAccountId);
  if (account === null) throw new RangeError('ad account id must be digits, optionally prefixed act_');
  const call = graphCaller(opts);
  const limitOf = (limit?: number) => String(Math.max(1, Math.min(limit ?? META_PAGE_SIZE, META_PAGE_SIZE)));
  return {
    version: opts.version,
    adAccountId: account,
    getAdAccount: () => call('GET', `/act_${account}`, new URLSearchParams({ fields: AD_ACCOUNT_FIELDS.join(',') }), null, asRecord),
    listCampaigns: ({ after, limit }) => {
      const q = new URLSearchParams({ fields: CAMPAIGN_FIELDS.join(','), limit: limitOf(limit) });
      if (after) q.set('after', after);
      return call('GET', `/act_${account}/campaigns`, q, null, asPage);
    },
    listCampaignInsights: ({ datePreset, after, limit }) => {
      if (!/^[a-z0-9_]{3,40}$/.test(datePreset)) throw new RangeError('date preset has an invalid format');
      const q = new URLSearchParams({ level: 'campaign', date_preset: datePreset, fields: INSIGHT_FIELDS.join(','), use_unified_attribution_setting: 'true', limit: limitOf(limit) });
      if (after) q.set('after', after);
      return call('GET', `/act_${account}/insights`, q, null, asPage);
    },
    getCampaign: (campaignId) => call('GET', `/${digits(campaignId, 'campaign id')}`, new URLSearchParams({ fields: CAMPAIGN_FIELDS.join(',') }), null, asRecord),
    setCampaignStatus: (campaignId, status) =>
      call('POST', `/${digits(campaignId, 'campaign id')}`, null, { contentType: 'application/x-www-form-urlencoded', payload: new URLSearchParams({ status }).toString() }, asRecord),
  };
}

// ---- Parsers (pure) -------------------------------------------------------------------------------------

const raw = (v: unknown, max = MAX_RAW) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null);
const idOf = (v: unknown) => {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : raw(v);
  return s !== null && GRAPH_ID_RE.test(s) ? s : null;
};

export type GraphLead = {
  id: string;
  created_time: string;
  form_id?: string;
  ad_id?: string;
  campaign_id?: string;
  field_data: Array<{ name: string; values: string[] }>;
};

/**
 * A Graph lead as the ingestion payload (`metaLeadSchema`): `field_data` as returned (values as
 * strings, bounded), plus each custom disclaimer checkbox as one more answer keyed by its
 * `checkbox_key` with the `is_checked` value, so a consent checkbox can be mapped like a question.
 */
export function parseGraphLead(value: unknown): GraphLead | null {
  const o = record(value);
  const id = idOf(o.id);
  const created = raw(o.created_time, 40);
  if (id === null || created === null || created.length < 10) return null;
  const fieldData: GraphLead['field_data'] = [];
  for (const f of Array.isArray(o.field_data) ? o.field_data : []) {
    const name = raw(record(f).name, 200);
    if (name === null) continue;
    const values = (Array.isArray(record(f).values) ? (record(f).values as unknown[]) : [])
      .map((v) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v).slice(0, 2000) : null))
      .filter((v): v is string => v !== null)
      .slice(0, 20);
    fieldData.push({ name, values });
  }
  for (const d of Array.isArray(o.custom_disclaimer_responses) ? o.custom_disclaimer_responses : []) {
    const key = raw(record(d).checkbox_key, 200);
    const checked = record(d).is_checked;
    if (key === null || (typeof checked !== 'string' && typeof checked !== 'boolean' && typeof checked !== 'number')) continue;
    fieldData.push({ name: key, values: [String(checked)] });
  }
  const lead: GraphLead = { id, created_time: created, field_data: fieldData.slice(0, 100) };
  const form = idOf(o.form_id);
  const ad = idOf(o.ad_id);
  const campaign = idOf(o.campaign_id);
  if (form) lead.form_id = form;
  if (ad) lead.ad_id = ad;
  if (campaign) lead.campaign_id = campaign;
  return lead;
}

export function parseAdAccount(value: unknown): FetchedAdAccount | null {
  const o = record(value);
  const accountId = idOf(o.account_id) ?? (typeof o.id === 'string' ? adAccountDigits(o.id) : null);
  const currency = raw(o.currency, 8);
  if (accountId === null || currency === null || !/^[A-Z]{3}$/.test(currency)) return null;
  return { accountId, name: raw(o.name, 200), currency, timezone: raw(o.timezone_name, 64) };
}

export function parseCampaign(value: unknown): FetchedCampaign | null {
  const o = record(value);
  const id = idOf(o.id);
  const name = raw(o.name, 300);
  const configured = raw(o.configured_status) ?? raw(o.status);
  const effective = raw(o.effective_status);
  if (id === null || name === null || configured === null || effective === null) return null;
  return { providerCampaignId: id, name, configuredStatus: configured, effectiveStatus: effective };
}

export function parseCampaignStatus(value: unknown): CampaignStatusRead | null {
  const o = record(value);
  const id = idOf(o.id);
  const configured = raw(o.configured_status) ?? raw(o.status);
  const effective = raw(o.effective_status);
  if (id === null || configured === null || effective === null) return null;
  return { providerCampaignId: id, configuredStatus: configured, effectiveStatus: effective };
}

const DECIMAL_RE = /^\d{1,15}(?:\.\d{1,6})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function actionValue(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  for (const type of LEAD_ACTION_TYPES) {
    const hit = list.find((a) => record(a).action_type === type);
    if (hit) {
      const v = record(hit).value;
      const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : null;
      if (s !== null && DECIMAL_RE.test(s)) return s;
    }
  }
  return null;
}

export function parseInsight(value: unknown): FetchedInsight | null {
  const o = record(value);
  const id = idOf(o.campaign_id);
  const start = raw(o.date_start, 10);
  const stop = raw(o.date_stop, 10);
  const spend = typeof o.spend === 'number' ? String(o.spend) : raw(o.spend, 32);
  if (id === null || start === null || stop === null || !DATE_RE.test(start) || !DATE_RE.test(stop) || spend === null || !DECIMAL_RE.test(spend)) return null;
  const leadsRaw = actionValue(o.actions);
  const leads = leadsRaw === null ? 0 : Math.trunc(Number(leadsRaw));
  return {
    providerCampaignId: id,
    dateStart: start,
    dateStop: stop,
    spend,
    leads: Number.isSafeInteger(leads) && leads >= 0 ? leads : 0,
    costPerLead: actionValue(o.cost_per_action_type),
    attributionSetting: raw(o.attribution_setting, 120),
  };
}

// ---- Failures -------------------------------------------------------------------------------------------

/** Throttling (application, user, page and ads business-use-case limits; UNVERIFIED, docs/integrations.md). */
export const META_RATE_LIMIT_CODES: ReadonlySet<string> = new Set(['4', '17', '32', '613', '80000', '80001', '80002', '80003', '80004', '80005', '80006', '80008', '80009', '80014']);
/** Permission codes: 3, 10, 200-299 (UNVERIFIED). */
export function isPermissionCode(code: string | null): boolean {
  if (code === null) return false;
  if (code === '3' || code === '10') return true;
  const n = Number(code);
  return Number.isInteger(n) && n >= 200 && n <= 299;
}

const KNOWN_PERMISSIONS = ['leads_retrieval', 'pages_manage_ads', 'pages_manage_metadata', 'pages_read_engagement', 'pages_show_list', 'ads_management', 'ads_read', 'business_management'] as const;

export type MetaFailureCode = 'PROVIDER_AUTH' | 'PERMISSION_MISSING' | 'NOT_FOUND' | 'PROVIDER_RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_UNREACHABLE' | 'PROVIDER_REJECTED';

export type MetaFailure = {
  code: MetaFailureCode;
  /** The permission Meta named, or the one the operation needs, for PERMISSION_MISSING. */
  permission: string | null;
  /** One user-facing line without any token or contact value. */
  message: string;
  phase: 'before-write' | 'after-write' | 'response';
  httpStatus: number | null;
  providerCode: string | null;
  retryAfterMs?: number;
};

function detailOf(call: Extract<GraphCall<unknown>, { ok: false }>): string {
  if (call.phase !== 'response') return `no answer from Meta (${call.error.message})`;
  return `HTTP ${call.status}${call.error.code ? ` code ${call.error.code}` : ''}${call.error.subcode ? `/${call.error.subcode}` : ''}: ${call.error.message}`;
}

/**
 * What a failed call means. `required` is the permission the operation needs (named when Meta
 * refuses a permission without saying which). A thrown request error is PROVIDER_UNREACHABLE with
 * its phase, so a write can tell "not sent" from "may have been applied".
 */
export function classifyMetaFailure(call: Extract<GraphCall<unknown>, { ok: false }>, required: string): MetaFailure {
  const detail = detailOf(call);
  const base = { phase: call.phase, httpStatus: call.status, providerCode: call.error.code, ...(call.retryAfterMs !== undefined ? { retryAfterMs: call.retryAfterMs } : {}) };
  if (call.phase !== 'response') return { ...base, code: 'PROVIDER_UNREACHABLE', permission: null, message: detail };
  const code = call.error.code;
  if (code === '190' || call.status === 401) {
    return { ...base, code: 'PROVIDER_AUTH', permission: null, message: `Meta rejected the access token (expired, revoked or invalid); enter a new token and test the connection again. ${detail}` };
  }
  if ((code !== null && META_RATE_LIMIT_CODES.has(code)) || call.status === 429) return { ...base, code: 'PROVIDER_RATE_LIMITED', permission: null, message: `Meta is rate limiting these requests. ${detail}` };
  if (isPermissionCode(code) || call.status === 403) {
    const named = KNOWN_PERMISSIONS.find((p) => call.error.message.includes(p)) ?? required;
    const hint = named === 'leads_retrieval' ? ' (the app also needs access to the form in Leads Access Manager)' : '';
    return { ...base, code: 'PERMISSION_MISSING', permission: named, message: `Missing permission: ${named}${hint}. ${detail}` };
  }
  if (code === '100' || call.status === 404) return { ...base, code: 'NOT_FOUND', permission: null, message: `Meta did not find the object, or this token cannot read it. ${detail}` };
  if (call.status >= 500) return { ...base, code: 'PROVIDER_UNAVAILABLE', permission: null, message: `Meta answered with a server error. ${detail}` };
  return { ...base, code: 'PROVIDER_REJECTED', permission: null, message: `Meta rejected the request. ${detail}` };
}

/**
 * WhatsApp template administration (ADR-123, slice F4): the port for writing templates to Meta and
 * its LIVE Graph implementation. It is a port of its own, not part of `WhatsAppTransport` (sends):
 * `template-admin-demo.ts` plays WhatsApp Manager in DEMO, and `adapters/registry.ts`
 * (`whatsAppTemplateAdmin`) is the only place that picks one. LIVE never reaches the demo module.
 *
 * Graph calls (developers.facebook.com: "Message templates" on the WhatsApp Business Account and
 * "Resumable Upload API", read through search snippets only on TEMPLATE_ADMIN_CHECKED_ON; request
 * and response shapes are UNVERIFIED until a live check, docs/integrations.md):
 *  - create: `POST /<version>/<WABA_ID>/message_templates` with `{name, language, category,
 *    components}` (JSON); answer `{id, status, category}`;
 *  - delete: `DELETE /<version>/<WABA_ID>/message_templates?name=<name>`; answer `{success: true}`;
 *  - document header sample (resumable upload, needs the Meta app ID, WHATSAPP_CLOUD config
 *    `appId`): `POST /<version>/<APP_ID>/uploads?file_name&file_length&file_type` answers
 *    `{id: "upload:<session>"}`, then `POST /<version>/upload:<session>` with the bytes, the header
 *    `file_offset: 0` and `Authorization: OAuth <token>` answers `{h: "<handle>"}`; the handle goes
 *    into the DOCUMENT header's `example.header_handle`.
 * Every request goes through `adapters/http/outbound.ts` (DEMO is refused before any socket); the
 * access token travels only in the Authorization header (never in a URL) and is scrubbed from
 * every provider text.
 *
 * Failure classification for a create (`classifyTemplateCreateFailure`): a request that was never
 * written is NOT_SENT; a timeout or reset after the write, a 5xx, or a 2xx without an id may have
 * created the template and is AMBIGUOUS (resolved by a sync by name and language, never by a blind
 * retry); "name already exists" is NAME_TAKEN (also resolved by a sync: it may be our own earlier
 * submission); everything else is a definite refusal with Meta's message.
 */
import type { Clock } from '@/lib/clock';
import { outboundFailureLabel, outboundFailurePhase, outboundRequest, type OutboundMode, type OutboundResponse } from '../http/outbound';
import { classifyGraphReadFailure, describeGraphFailure, GRAPH_DEFAULT_BASE_URL, GRAPH_ID_RE, GRAPH_VERSION_RE, retryAfterMs, type GraphCall, type GraphErrorInfo, type GraphHttp } from './cloud-api';
import { boundedError } from './error-map';

export const TEMPLATE_ADMIN_CHECKED_ON = '2026-10-23';
/** Header sample documents (the studio's own cap; Meta's own limit for a document header sample is UNVERIFIED). */
export const HEADER_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;
/** "Content in this language already exists" (UNVERIFIED subcode). */
export const TEMPLATE_NAME_TAKEN_SUBCODES: ReadonlySet<string> = new Set(['2388024']);
const ADMIN_TIMEOUT_MS = 20_000;

export type TemplateCreateRequest = { name: string; language: string; category: string; components: ReadonlyArray<Record<string, unknown>> };
export type TemplateCreated = { id: string; status: string | null; category: string | null };
export type HeaderDocument = { fileName: string; mimeType: 'application/pdf'; bytes: Buffer };

/** What every template admin offers (Graph in LIVE, the simulated WhatsApp Manager in DEMO). */
export interface TemplateAdminPort {
  readonly label: 'graph' | 'demo';
  readonly simulated: boolean;
  createTemplate(req: TemplateCreateRequest): Promise<GraphCall<TemplateCreated>>;
  /**
   * Deletes one template. Meta deletes every language of a name unless `hsm_id` names one, so the
   * provider's template id is sent with the name whenever it is known (null: all languages).
   */
  deleteTemplate(name: string, providerTemplateId: string | null): Promise<GraphCall<{ deleted: true }>>;
  /** A header sample handle for a DOCUMENT header (resumable upload). */
  uploadHeaderDocument(doc: HeaderDocument): Promise<GraphCall<{ handle: string }>>;
}

export type GraphTemplateAdmin = TemplateAdminPort & { readonly label: 'graph'; readonly simulated: false; readonly wabaId: string; /** Null: a document header cannot be uploaded. */ readonly appId: string | null };

export type GraphTemplateAdminOptions = {
  mode: OutboundMode;
  graphVersion: string;
  wabaId: string;
  /** The Meta app ID for the resumable upload (WHATSAPP_CLOUD config `appId`); null when not set. */
  appId: string | null;
  accessToken: string;
  clock: Clock;
  baseUrl?: string;
  http?: GraphHttp;
  timeoutMs?: number;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function scrubber(secret: string): (text: string) => string {
  return (text) => (secret.length > 0 ? text.split(secret).join('[REDACTED]') : text);
}

function parseError(body: string, scrub: (t: string) => string): GraphErrorInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { code: null, subcode: null, type: null, message: 'the provider answered with a body that is not JSON' };
  }
  const e = record(record(parsed).error);
  const user = typeof e.error_user_msg === 'string' && e.error_user_msg.length > 0 ? e.error_user_msg : null;
  const message = [typeof e.message === 'string' ? e.message : 'no error message', user ? `(${user})` : ''].filter(Boolean).join(' ');
  const code = typeof e.code === 'number' || typeof e.code === 'string' ? String(e.code) : null;
  const subcode = typeof e.error_subcode === 'number' || typeof e.error_subcode === 'string' ? String(e.error_subcode) : null;
  return { code, subcode, type: typeof e.type === 'string' ? e.type : null, message: boundedError(scrub(message)) };
}

function localFailure<T>(message: string): GraphCall<T> {
  return { ok: false, phase: 'before-write', status: null, error: { code: 'LOCAL', subcode: null, type: null, message } };
}

export function createGraphTemplateAdmin(opts: GraphTemplateAdminOptions): GraphTemplateAdmin {
  if (!GRAPH_VERSION_RE.test(opts.graphVersion)) throw new RangeError('graph version must look like v24.0');
  if (!GRAPH_ID_RE.test(opts.wabaId)) throw new RangeError('WhatsApp Business Account id must be digits');
  if (opts.appId !== null && !GRAPH_ID_RE.test(opts.appId)) throw new RangeError('app id must be digits');
  const base = (opts.baseUrl ?? GRAPH_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const http: GraphHttp = opts.http ?? ((url, init) => outboundRequest(opts.mode, url, init, opts.clock.now()));
  const scrub = scrubber(opts.accessToken);
  const timeout = opts.timeoutMs ?? ADMIN_TIMEOUT_MS;

  async function call<T>(
    method: 'POST' | 'DELETE',
    path: string,
    body: { contentType: string; payload: string | Buffer } | null,
    read: (json: unknown) => T | null,
    extraHeaders: Record<string, string> = {},
    scheme: 'Bearer' | 'OAuth' = 'Bearer',
  ): Promise<GraphCall<T>> {
    const headers: Record<string, string> = { authorization: `${scheme} ${opts.accessToken}`, accept: 'application/json', ...extraHeaders };
    if (body) headers['content-type'] = body.contentType;
    let res: OutboundResponse;
    try {
      res = await http(`${base}/${opts.graphVersion}${path}`, { method, headers, body: body?.payload, headersTimeoutMs: timeout, bodyTimeoutMs: timeout });
    } catch (error) {
      return { ok: false, phase: outboundFailurePhase(error), status: null, error: { code: null, subcode: null, type: null, message: boundedError(scrub(outboundFailureLabel(error))) } };
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
  }

  return {
    label: 'graph',
    simulated: false,
    wabaId: opts.wabaId,
    appId: opts.appId,
    createTemplate: (req) =>
      call('POST', `/${opts.wabaId}/message_templates`, { contentType: 'application/json', payload: JSON.stringify({ name: req.name, language: req.language, category: req.category, components: req.components }) }, (json) => {
        const o = record(json);
        if (typeof o.id !== 'string' || o.id.length === 0) return null;
        return { id: o.id, status: typeof o.status === 'string' ? o.status.slice(0, 64) : null, category: typeof o.category === 'string' ? o.category.slice(0, 64) : null };
      }),
    deleteTemplate: (name, providerTemplateId) => call('DELETE', `/${opts.wabaId}/message_templates?${providerTemplateId ? `hsm_id=${encodeURIComponent(providerTemplateId)}&` : ''}name=${encodeURIComponent(name)}`, null, (json) => (record(json).success === true ? { deleted: true as const } : null)),
    async uploadHeaderDocument(doc) {
      if (opts.appId === null) return localFailure('the Meta app ID is not set in the WhatsApp setup, so a document header cannot be uploaded');
      if (doc.bytes.length === 0 || doc.bytes.length > HEADER_DOCUMENT_MAX_BYTES) return localFailure('the document is empty or larger than 5 MB');
      const query = `?file_name=${encodeURIComponent(doc.fileName)}&file_length=${doc.bytes.length}&file_type=${encodeURIComponent(doc.mimeType)}`;
      const session = await call('POST', `/${opts.appId}/uploads${query}`, null, (json) => {
        const id = record(json).id;
        return typeof id === 'string' && /^upload:[A-Za-z0-9_=:-]+$/.test(id) ? { id } : null;
      }, {}, 'OAuth');
      if (!session.ok) return session;
      return call('POST', `/${session.data.id}`, { contentType: 'application/octet-stream', payload: doc.bytes }, (json) => {
        const h = record(json).h;
        return typeof h === 'string' && h.length > 0 ? { handle: h } : null;
      }, { file_offset: '0' }, 'OAuth');
    },
  };
}

// ---- Classification ----------------------------------------------------------------------------

export type TemplateCreateFailure =
  /** Never written: definitely not created. */
  | { kind: 'not-sent'; code: 'PROVIDER_UNREACHABLE' | 'APP_ID_MISSING' | 'DOCUMENT_INVALID'; message: string }
  /** May have been created: resolve by a sync by name and language, never by a blind retry. */
  | { kind: 'ambiguous'; code: 'WRITE_TIMEOUT' | 'PROVIDER_UNAVAILABLE' | 'UNCONFIRMED'; message: string }
  /** The name and language exist at Meta (maybe our own earlier submission): resolve by a sync. */
  | { kind: 'name-taken'; code: 'TEMPLATE_NAME_TAKEN'; message: string }
  /** A definite refusal: nothing was created. */
  | { kind: 'refused'; code: 'PROVIDER_AUTH' | 'PERMISSION_MISSING' | 'PROVIDER_RATE_LIMITED' | 'CONFIG_INVALID' | 'TEMPLATE_REJECTED_BY_PROVIDER'; message: string };

export function classifyTemplateCreateFailure(call: Extract<GraphCall<unknown>, { ok: false }>): TemplateCreateFailure {
  const message = describeGraphFailure(call);
  if (call.phase === 'before-write') {
    if (call.error.code === 'LOCAL') return { kind: 'not-sent', code: /app ID/.test(call.error.message) ? 'APP_ID_MISSING' : 'DOCUMENT_INVALID', message: call.error.message };
    return { kind: 'not-sent', code: 'PROVIDER_UNREACHABLE', message };
  }
  if (call.phase !== 'response') return { kind: 'ambiguous', code: 'WRITE_TIMEOUT', message };
  if (call.status < 300) return { kind: 'ambiguous', code: 'UNCONFIRMED', message };
  if (call.error.subcode !== null && TEMPLATE_NAME_TAKEN_SUBCODES.has(call.error.subcode)) return { kind: 'name-taken', code: 'TEMPLATE_NAME_TAKEN', message };
  switch (classifyGraphReadFailure(call)) {
    case 'auth':
      return { kind: 'refused', code: 'PROVIDER_AUTH', message };
    case 'permission':
      return { kind: 'refused', code: 'PERMISSION_MISSING', message };
    case 'rate-limited':
      return { kind: 'refused', code: 'PROVIDER_RATE_LIMITED', message };
    case 'unavailable':
      return { kind: 'ambiguous', code: 'PROVIDER_UNAVAILABLE', message };
    case 'not-found':
      // Code 100 is also Meta's "invalid parameter" for a template it refuses; a 404 is an unknown WABA.
      return call.status === 404 ? { kind: 'refused', code: 'CONFIG_INVALID', message } : { kind: 'refused', code: 'TEMPLATE_REJECTED_BY_PROVIDER', message };
    default:
      return { kind: 'refused', code: 'TEMPLATE_REJECTED_BY_PROVIDER', message };
  }
}

/** A user-facing sentence for a definite refusal or a failure before the write. */
export const TEMPLATE_SUBMIT_FAILURE_LABELS: Readonly<Record<string, string>> = {
  PROVIDER_UNREACHABLE: 'Meta could not be reached, so nothing was submitted. Submit again.',
  APP_ID_MISSING: 'The Meta app ID is not set in the WhatsApp setup, so the brochure could not be uploaded. Add it and submit again.',
  DOCUMENT_INVALID: 'The brochure could not be read for upload. Choose it again and submit.',
  PROVIDER_AUTH: 'Meta rejected the WhatsApp access token. Enter a new one in the WhatsApp setup, then submit again.',
  PERMISSION_MISSING: 'The access token lacks the whatsapp_business_management permission. Fix it in Meta, then submit again.',
  PROVIDER_RATE_LIMITED: 'Meta is throttling template requests. Nothing was submitted; try again in a few minutes.',
  CONFIG_INVALID: 'Meta did not accept the WhatsApp Business Account ID. Check the WhatsApp setup.',
  TEMPLATE_REJECTED_BY_PROVIDER: 'Meta refused the template.',
  NOT_FOUND_AFTER_SUBMIT: 'Meta does not list this template after the submission, so it was not created. Submit again.',
  INTEGRATION_NOT_CONFIGURED: 'WhatsApp is not connected and verified, so nothing was submitted.',
  CREDENTIAL_UNREADABLE: 'The stored WhatsApp access token could not be read. Re-enter it in the WhatsApp setup.',
  MEDIA_MISSING: 'The brochure file is missing or changed on disk. Upload it again and choose it for the header.',
  MEDIA_UPLOAD_FAILED: 'The brochure could not be uploaded to Meta, so nothing was submitted. Submit again.',
};

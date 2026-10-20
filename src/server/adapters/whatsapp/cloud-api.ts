/**
 * WhatsApp Cloud API adapter (T32; plan §4.4, §6.3, P2, ADR-41, ADR-62). LIVE only: it is built by
 * `adapters/registry.ts` from a workspace's verified integration, and every request goes through
 * `adapters/http/outbound.ts` (which blocks every host in DEMO, so a mis-wired DEMO process still
 * makes zero outbound calls).
 *
 * The transport implements the `WhatsAppTransport` port:
 *  - template sends: `template.language.code`, positional body parameters from the message's
 *    variables, the quotation PDF as a DOCUMENT header parameter (by media id) when the template
 *    has one, and a `quick_reply` button component per mapped button carrying the stable payload id
 *    set for this send (ADR-62: AL_QR_QUOTE_V1, AL_QR_CALL_V1, AL_QR_STOP_V1);
 *  - free-form text (`text.body`, previews off) and free-form documents (`document.id` + filename,
 *    the body as caption);
 *  - `biz_opaque_callback_data = attemptId`, so a status webhook can resolve an AMBIGUOUS attempt;
 *  - documents are uploaded first (media.ts); an upload failure means the message was never sent
 *    (PRE_SEND / RETRYABLE / PERMANENT, never AMBIGUOUS).
 * Outcomes are classified only through the dated error map (error-map.ts): a mapped provider code
 * wins, then the HTTP status; a failure before the request was written is PRE_SEND; a timeout or a
 * reset after it was written is AMBIGUOUS and is never retried blindly. `Retry-After` is honoured.
 * Checks that can be decided locally (template not sendable, wrong variable count, a document the
 * template cannot carry) fail PERMANENT before any request.
 *
 * Errors are bounded and redacted (`boundedError`), and the access token is scrubbed from every
 * provider text before that: it never reaches a log, an error, a URL or the database.
 *
 * Request and response shapes follow Meta's published Cloud API reference (developers.facebook.com,
 * read through search snippets only on 2026-10-20) and are UNVERIFIED until a live check; see
 * docs/integrations.md. The Graph version comes from `META_GRAPH_VERSION`; there is no default.
 */
import type { Clock } from '@/lib/clock';
import { templateShape } from '@/lib/domain/whatsapp-templates';
import { outboundFailureLabel, outboundFailurePhase, outboundRequest, type OutboundMode, type OutboundRequest, type OutboundResponse } from '../http/outbound';
import { boundedError, classifyWhatsAppFailure } from './error-map';
import { mediaUploadBody, safeDocumentFilename, WA_DOCUMENT_MAX_BYTES } from './media';
import type { AmbiguousOutcome, FailedOutcome, SendOutcome, WaDocument, WaSendRequest, WhatsAppTransport } from './port';

export const GRAPH_DEFAULT_BASE_URL = 'https://graph.facebook.com';
export const CLOUD_API_CHECKED_ON = '2026-10-20';
export const GRAPH_VERSION_RE = /^v\d+\.\d+$/;
export const GRAPH_ID_RE = /^\d{5,32}$/;
/** Free-form text body limit (UNVERIFIED: 4096 characters per the reference). */
export const WA_TEXT_MAX_CHARS = 4096;
/** Document caption limit (UNVERIFIED: 1024 characters). */
export const WA_CAPTION_MAX_CHARS = 1024;
const SEND_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

export type GraphHttp = (url: string, init: OutboundRequest) => Promise<OutboundResponse>;

export type CloudApiOptions = {
  /** The process mode; outbound.ts refuses every host in DEMO. */
  mode: OutboundMode;
  graphVersion: string;
  phoneNumberId: string;
  wabaId: string | null;
  accessToken: string;
  clock: Clock;
  /** Test seam (a local fake server); production uses graph.facebook.com. */
  baseUrl?: string;
  /** Test seam (scripted answers); production uses outbound.ts. */
  http?: GraphHttp;
  timeoutMs?: number;
};

export type GraphErrorInfo = { code: string | null; subcode: string | null; type: string | null; message: string };

export type GraphCall<T> =
  | { ok: true; status: number; data: T }
  /** A thrown request error: before or after the request was written. */
  | { ok: false; phase: 'before-write' | 'after-write'; status: null; error: GraphErrorInfo; retryAfterMs?: undefined }
  /** An HTTP answer that is not a success. */
  | { ok: false; phase: 'response'; status: number; error: GraphErrorInfo; retryAfterMs?: number };

export type GraphTemplatePage = { data: unknown[]; after: string | null };

export type CloudApiClient = {
  readonly phoneNumberId: string;
  readonly wabaId: string | null;
  getPhoneNumber(fields: readonly string[]): Promise<GraphCall<Record<string, unknown>>>;
  getWaba(fields: readonly string[]): Promise<GraphCall<Record<string, unknown>>>;
  listTemplates(opts: { after: string | null; limit: number }): Promise<GraphCall<GraphTemplatePage>>;
  uploadMedia(doc: WaDocument): Promise<GraphCall<{ id: string }>>;
  sendMessage(body: Record<string, unknown>): Promise<GraphCall<Record<string, unknown>>>;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function headerValue(headers: OutboundResponse['headers'], name: string): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === 'string' ? v : null;
}

/** `Retry-After` in seconds or as an HTTP date, capped at one hour. */
export function retryAfterMs(headers: OutboundResponse['headers'], now: Date): number | undefined {
  const raw = headerValue(headers, 'retry-after');
  if (raw === null || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  let ms: number;
  if (Number.isFinite(seconds)) ms = seconds * 1000;
  else {
    const at = Date.parse(raw);
    if (Number.isNaN(at)) return undefined;
    ms = at - now.getTime();
  }
  if (ms < 0) return 0;
  return Math.min(Math.ceil(ms), MAX_RETRY_AFTER_MS);
}

function scrubber(secret: string): (text: string) => string {
  return (text) => (secret.length > 0 ? text.split(secret).join('[REDACTED]') : text);
}

function parseGraphError(body: string, scrub: (t: string) => string): GraphErrorInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { code: null, subcode: null, type: null, message: 'the provider answered with a body that is not JSON' };
  }
  const e = record(record(parsed).error);
  const details = record(e.error_data).details;
  const message = [typeof e.message === 'string' ? e.message : 'no error message', typeof details === 'string' && details.length > 0 ? `(${details})` : ''].filter(Boolean).join(' ');
  const code = typeof e.code === 'number' || typeof e.code === 'string' ? String(e.code) : null;
  const subcode = typeof e.error_subcode === 'number' || typeof e.error_subcode === 'string' ? String(e.error_subcode) : null;
  return { code, subcode, type: typeof e.type === 'string' ? e.type : null, message: boundedError(scrub(message)) };
}

/** A user-facing, value-free line for a failed Graph call (used for stored errors and outcomes). */
export function describeGraphFailure(call: Extract<GraphCall<unknown>, { ok: false }>): string {
  if (call.phase !== 'response') return `no answer from the provider (${call.error.message})`;
  return `HTTP ${call.status}${call.error.code ? ` code ${call.error.code}` : ''}${call.error.subcode ? `/${call.error.subcode}` : ''}: ${call.error.message}`;
}

/** Graph throttling codes (application, account and WhatsApp rate limits; UNVERIFIED, error-map.ts date). */
export const GRAPH_RATE_LIMIT_CODES: ReadonlySet<string> = new Set(['4', '17', '32', '613', '80007', '80008', '130429']);
/** Graph permission codes (UNVERIFIED). */
export const GRAPH_PERMISSION_CODES: ReadonlySet<string> = new Set(['3', '10', '200', '294']);

export type GraphReadFailure = 'unreachable' | 'auth' | 'permission' | 'not-found' | 'rate-limited' | 'unavailable' | 'rejected';

/**
 * What a failed read (connection test, template list, quality fields) means. Reads have no side
 * effect, so a timeout is simply "unreachable"; only sends distinguish before and after the write.
 */
export function classifyGraphReadFailure(call: Extract<GraphCall<unknown>, { ok: false }>): GraphReadFailure {
  if (call.phase !== 'response') return 'unreachable';
  const code = call.error.code;
  if (code === '190' || call.status === 401) return 'auth';
  if ((code !== null && GRAPH_RATE_LIMIT_CODES.has(code)) || call.status === 429) return 'rate-limited';
  if ((code !== null && GRAPH_PERMISSION_CODES.has(code)) || call.status === 403) return 'permission';
  if (code === '100' || call.status === 404) return 'not-found';
  if (call.status >= 500) return 'unavailable';
  return 'rejected';
}

export function createCloudApiClient(opts: CloudApiOptions): CloudApiClient {
  if (!GRAPH_VERSION_RE.test(opts.graphVersion)) throw new RangeError('graph version must look like v24.0');
  if (!GRAPH_ID_RE.test(opts.phoneNumberId)) throw new RangeError('phone number id must be digits');
  if (opts.wabaId !== null && !GRAPH_ID_RE.test(opts.wabaId)) throw new RangeError('WhatsApp Business Account id must be digits');
  const base = (opts.baseUrl ?? GRAPH_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const http: GraphHttp = opts.http ?? ((url, init) => outboundRequest(opts.mode, url, init, opts.clock.now()));
  const scrub = scrubber(opts.accessToken);
  const timeout = opts.timeoutMs ?? SEND_TIMEOUT_MS;

  async function call<T>(method: 'GET' | 'POST', path: string, body: { contentType: string; payload: string | Buffer } | null, read: (json: unknown) => T | null): Promise<GraphCall<T>> {
    const headers: Record<string, string> = { authorization: `Bearer ${opts.accessToken}`, accept: 'application/json' };
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
    return { ok: false, phase: 'response', status: res.statusCode, error: parseGraphError(res.body, scrub), ...(after !== undefined ? { retryAfterMs: after } : {}) };
  }

  const fieldsQuery = (fields: readonly string[]) => `?fields=${fields.map(encodeURIComponent).join(',')}`;
  const asRecord = (json: unknown) => (typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : null);

  return {
    phoneNumberId: opts.phoneNumberId,
    wabaId: opts.wabaId,
    getPhoneNumber: (fields) => call('GET', `/${opts.phoneNumberId}${fieldsQuery(fields)}`, null, asRecord),
    getWaba: (fields) => {
      if (opts.wabaId === null) throw new RangeError('no WhatsApp Business Account id configured');
      return call('GET', `/${opts.wabaId}${fieldsQuery(fields)}`, null, asRecord);
    },
    listTemplates: ({ after, limit }) => {
      if (opts.wabaId === null) throw new RangeError('no WhatsApp Business Account id configured');
      const query = `${fieldsQuery(['id', 'name', 'language', 'status', 'category', 'components'])}&limit=${Math.max(1, Math.min(limit, 100))}${after ? `&after=${encodeURIComponent(after)}` : ''}`;
      return call('GET', `/${opts.wabaId}/message_templates${query}`, null, (json) => {
        const o = asRecord(json);
        if (!o || !Array.isArray(o.data)) return null;
        const next = record(record(record(o.paging).cursors)).after;
        // A next page exists only when the answer says so (`paging.next`); its URL is never followed.
        const hasNext = typeof record(o.paging).next === 'string';
        return { data: o.data, after: hasNext && typeof next === 'string' && next.length > 0 ? next : null };
      });
    },
    uploadMedia: (doc) => {
      const { body, contentType } = mediaUploadBody(doc);
      return call('POST', `/${opts.phoneNumberId}/media`, { contentType, payload: body }, (json) => {
        const id = asRecord(json)?.id;
        return typeof id === 'string' && id.length > 0 ? { id } : null;
      });
    },
    sendMessage: (payload) => call('POST', `/${opts.phoneNumberId}/messages`, { contentType: 'application/json', payload: JSON.stringify(payload) }, asRecord),
  };
}

// ---- Message bodies (pure) ------------------------------------------------------------------------

function localFailure(reasonCode: string, error: string): FailedOutcome {
  return { status: 'failed', failureClass: 'PERMANENT', reasonCode, error: boundedError(error), suppress: false, manualRetryAfterMs: null, throttleScope: null };
}

/** E.164 without the plus, as in the reference's examples. */
export function cloudRecipient(e164: string): string | null {
  const digits = e164.replace(/^\+/, '');
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

/**
 * The JSON body of one send. `mediaId` is the uploaded document's id (or a placeholder when only
 * validating before the upload). Returns a PERMANENT failure for anything that cannot be sent.
 */
export function buildSendBody(req: WaSendRequest, mediaId: string | null): { ok: true; body: Record<string, unknown> } | { ok: false; outcome: FailedOutcome } {
  const to = cloudRecipient(req.to);
  if (to === null) return { ok: false, outcome: localFailure('INVALID_RECIPIENT', 'the recipient is not an E.164 phone number') };
  const base: Record<string, unknown> = { messaging_product: 'whatsapp', recipient_type: 'individual', to, biz_opaque_callback_data: req.attemptId };

  if (req.kind === 'template') {
    const t = req.template;
    if (!t) return { ok: false, outcome: localFailure('TEMPLATE_MISSING', 'a template send without a template') };
    const shape = t.components !== undefined ? templateShape(t.components) : null;
    if (shape && !shape.sendable.ok) return { ok: false, outcome: localFailure('TEMPLATE_UNSUPPORTED', `template ${t.name} cannot be sent from this app (${shape.sendable.reason})`) };
    if (req.document && !shape?.documentHeader) {
      return { ok: false, outcome: localFailure('TEMPLATE_CANNOT_CARRY_DOCUMENT', `template ${t.name} has no document header, so it cannot carry the quotation PDF`) };
    }
    if (shape?.documentHeader && !req.document) return { ok: false, outcome: localFailure('TEMPLATE_NEEDS_DOCUMENT', `template ${t.name} has a document header but the send has no document`) };
    const positions = Object.keys(t.variables)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    if (shape && (positions.length !== shape.bodyVariables.length || positions.some((p, i) => String(Number(p)) !== shape.bodyVariables[i]))) {
      return { ok: false, outcome: localFailure('TEMPLATE_PARAMS_MISMATCH', `template ${t.name} expects ${shape.bodyVariables.length} variables, the message has ${positions.length}`) };
    }
    const components: Array<Record<string, unknown>> = [];
    if (req.document && mediaId !== null) {
      components.push({ type: 'header', parameters: [{ type: 'document', document: { id: mediaId, filename: safeDocumentFilename(req.document.filename) } }] });
    }
    if (positions.length > 0) components.push({ type: 'body', parameters: positions.map((p) => ({ type: 'text', text: t.variables[p] ?? '' })) });
    const quickIndexes = shape ? new Set(shape.quickReplies.map((q) => q.index)) : null;
    for (const q of [...(t.quickReplies ?? [])].sort((a, b) => a.index - b.index)) {
      if (quickIndexes && !quickIndexes.has(q.index)) continue;
      components.push({ type: 'button', sub_type: 'quick_reply', index: String(q.index), parameters: [{ type: 'payload', payload: q.payload }] });
    }
    return { ok: true, body: { ...base, type: 'template', template: { name: t.name, language: { code: t.language }, ...(components.length > 0 ? { components } : {}) } } };
  }

  if (req.document) {
    if (mediaId === null) return { ok: false, outcome: localFailure('MEDIA_MISSING', 'a document send without an uploaded document') };
    const caption = (req.body ?? '').trim();
    if (caption.length > WA_CAPTION_MAX_CHARS) return { ok: false, outcome: localFailure('CAPTION_TOO_LONG', `the caption is longer than ${WA_CAPTION_MAX_CHARS} characters`) };
    return { ok: true, body: { ...base, type: 'document', document: { id: mediaId, filename: safeDocumentFilename(req.document.filename), ...(caption ? { caption } : {}) } } };
  }
  const text = (req.body ?? '').trim();
  if (text === '') return { ok: false, outcome: localFailure('EMPTY_BODY', 'a free-form message without text') };
  if (text.length > WA_TEXT_MAX_CHARS) return { ok: false, outcome: localFailure('TEXT_TOO_LONG', `the text is longer than ${WA_TEXT_MAX_CHARS} characters`) };
  return { ok: true, body: { ...base, type: 'text', text: { preview_url: false, body: text } } };
}

// ---- Transport ------------------------------------------------------------------------------------

function uploadFailure(up: Extract<GraphCall<unknown>, { ok: false }>): FailedOutcome {
  const message = `media upload failed: ${describeGraphFailure(up)}`;
  if (up.phase !== 'response') return { status: 'failed', failureClass: 'PRE_SEND', reasonCode: 'MEDIA_UPLOAD_FAILED', error: boundedError(message), suppress: false, manualRetryAfterMs: null, throttleScope: null };
  const classified = classifyWhatsAppFailure({ phase: 'response', httpStatus: up.status, providerCode: up.error.code ?? undefined, retryAfterMs: up.retryAfterMs, message });
  if (classified.status === 'failed') return classified.reasonCode === 'PROVIDER_REJECTED' ? { ...classified, reasonCode: 'MEDIA_UPLOAD_REJECTED' } : classified;
  // The message itself was never sent, so an unconfirmed upload is a plain retryable failure.
  return {
    status: 'failed',
    failureClass: 'RETRYABLE',
    reasonCode: 'MEDIA_UPLOAD_UNAVAILABLE',
    error: boundedError(message),
    suppress: false,
    manualRetryAfterMs: null,
    throttleScope: null,
    ...(up.retryAfterMs !== undefined ? { retryAfterMs: up.retryAfterMs } : {}),
  };
}

function sendFailure(res: Extract<GraphCall<unknown>, { ok: false }>): FailedOutcome | AmbiguousOutcome {
  if (res.phase !== 'response') return classifyWhatsAppFailure({ phase: res.phase, message: describeGraphFailure(res) });
  return classifyWhatsAppFailure({ phase: 'response', httpStatus: res.status, providerCode: res.error.code ?? undefined, retryAfterMs: res.retryAfterMs, message: describeGraphFailure(res) });
}

export function createCloudApiTransport(opts: CloudApiOptions): WhatsAppTransport {
  const client = createCloudApiClient(opts);
  return {
    label: 'cloud-api',
    simulated: false,
    async send(req: WaSendRequest): Promise<SendOutcome> {
      if (req.document && req.document.bytes.length > WA_DOCUMENT_MAX_BYTES) return localFailure('DOCUMENT_TOO_LARGE', 'the document is larger than the provider accepts');
      // Everything decidable locally is checked before anything is uploaded or sent.
      const precheck = buildSendBody(req, req.document ? 'pending-upload' : null);
      if (!precheck.ok) return precheck.outcome;
      let mediaId: string | null = null;
      if (req.document) {
        const up = await client.uploadMedia(req.document);
        if (!up.ok) return uploadFailure(up);
        mediaId = up.data.id;
      }
      const built = buildSendBody(req, mediaId);
      if (!built.ok) return built.outcome;
      const res = await client.sendMessage(built.body);
      if (!res.ok) return sendFailure(res);
      const messages = res.data.messages;
      const id = Array.isArray(messages) ? record(messages[0]).id : undefined;
      if (typeof id === 'string' && id.length > 0) return { status: 'sent', providerMessageId: id, simulated: false };
      return classifyWhatsAppFailure({ phase: 'response', httpStatus: res.status, message: 'the provider accepted the request without a message id' });
    },
  };
}

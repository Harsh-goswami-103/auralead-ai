/**
 * Resend email adapter (T33; plan §4.4, §6.3, §7, §13, ADR-41, ADR-100). LIVE only: built by
 * `adapters/registry.ts` from a workspace's connected EMAIL_RESEND integration. Plain HTTP through
 * `adapters/http/outbound.ts` (no SDK), so the DEMO tripwire stands in front of every socket and the
 * contract tests drive it with zero network.
 *
 * Send: `POST /emails` with `from` (the workspace name and the configured from address; the
 * dispatch placeholder address is never used), `to`, `subject`, `text` (this app sends text/plain
 * only), `headers` (the List-Unsubscribe and List-Unsubscribe-Post headers the dispatch handler
 * built, RFC 8058), the quotation PDF as a base64 attachment, and a tag `auralead_attempt =
 * <attempt id>` that Resend echoes in its webhook events (UNVERIFIED), so a status event can
 * resolve an AMBIGUOUS attempt with positive evidence. No Reply-To is set: inbound email is not
 * processed (ADR-102), so replies go to the from mailbox.
 *
 * Idempotency (confirmed in Resend's docs and changelog through search snippets, 2026-10-20; the
 * semantics are UNVERIFIED until a live check): every send carries `Idempotency-Key = the
 * attempt's own key` (1 to 256 characters). Resend answers a repeat of the same key and body
 * within 24 hours with the original response and sends nothing. So when the outcome of a send is
 * unknown (a timeout or reset after the request was written, or a 5xx), the transport replays the
 * identical bytes with the same key exactly once, at once: a 2xx with an id is a confirmed send;
 * anything else stays AMBIGUOUS (no further retry, no new key: the outbox rules of plan §4.4
 * hold). A `concurrent_idempotent_requests` answer (the first request is still running) is
 * AMBIGUOUS without a replay. A failure before the request was written is PRE_SEND.
 *
 * Outcomes are classified only through the dated error map (`error-map.ts`); `Retry-After` is
 * honoured. Errors are bounded and redacted, and the API key is scrubbed from every provider text
 * first: it is only ever in the Authorization header, never in a URL, an error or a log.
 */
import type { Clock } from '@/lib/clock';
import { outboundFailureLabel, outboundFailurePhase, outboundRequest, type OutboundMode, type OutboundRequest, type OutboundResponse } from '../http/outbound';
import { boundedError } from '../whatsapp/error-map';
import { retryAfterMs } from '../whatsapp/cloud-api';
import { classifyEmailFailure } from './error-map';
import type { AmbiguousOutcome, EmailSendRequest, EmailTransport, FailedOutcome, SendOutcome } from './port';

export const RESEND_DEFAULT_BASE_URL = 'https://api.resend.com';
export const RESEND_CHECKED_ON = '2026-10-20';
/** The tag that carries the DispatchAttempt id (tag names and values: ASCII letters, digits, _ and -; UNVERIFIED). */
export const RESEND_ATTEMPT_TAG = 'auralead_attempt';
/** Resend's per-email size limit after base64 encoding (40 MB per the snippets; UNVERIFIED). */
export const RESEND_MAX_ENCODED_BYTES = 40 * 1024 * 1024;
const SEND_TIMEOUT_MS = 15_000;
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,256}$/;
const TAG_VALUE_RE = /^[A-Za-z0-9_-]{1,256}$/;
const EMAIL_RE = /^[^\s@<>",;]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,76}$/;
const CRLF_RE = /[\r\n\u0000]/;
const SUBJECT_MAX = 998;

export type ResendHttp = (url: string, init: OutboundRequest) => Promise<OutboundResponse>;

export type ResendClientOptions = {
  /** The process mode; outbound.ts refuses every host in DEMO. */
  mode: OutboundMode;
  apiKey: string;
  clock: Clock;
  /** Test seam (a local fake server); production uses api.resend.com. */
  baseUrl?: string;
  /** Test seam (scripted answers); production uses outbound.ts. */
  http?: ResendHttp;
  timeoutMs?: number;
};

export type ResendOptions = ResendClientOptions & {
  /** The configured from address (an address at the verified sending domain). */
  fromAddress: string;
};

export type ResendErrorInfo = { name: string | null; message: string };

export type ResendCall<T> =
  | { ok: true; status: number; data: T }
  /** A thrown request error: before or after the request was written. */
  | { ok: false; phase: 'before-write' | 'after-write'; status: null; error: ResendErrorInfo; retryAfterMs?: undefined }
  /** An HTTP answer that is not a success. */
  | { ok: false; phase: 'response'; status: number; error: ResendErrorInfo; retryAfterMs?: number };

export type ResendFailedCall = Extract<ResendCall<unknown>, { ok: false }>;

export type ResendDomain = { name: string; status: string };

export type ResendClient = {
  /** GET /domains: the domains of the account with their raw status. */
  listDomains(): Promise<ResendCall<{ domains: ResendDomain[]; hasMore: boolean }>>;
  /** POST /emails with the exact JSON bytes and the Idempotency-Key. */
  sendEmail(payload: string, idempotencyKey: string): Promise<ResendCall<{ id: string | null }>>;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function scrubber(secret: string): (text: string) => string {
  return (text) => (secret.length > 0 ? text.split(secret).join('[REDACTED]') : text);
}

function parseResendError(body: string, scrub: (t: string) => string): ResendErrorInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { name: null, message: 'the provider answered with a body that is not JSON' };
  }
  const o = record(parsed);
  const name = typeof o.name === 'string' && /^[a-z_]{1,64}$/.test(o.name) ? o.name : null;
  const message = typeof o.message === 'string' ? o.message : 'no error message';
  return { name, message: boundedError(scrub(message)) };
}

/** A value-free line for a failed call (stored errors, outcomes, test results). */
export function describeResendFailure(call: ResendFailedCall): string {
  if (call.phase !== 'response') return `no answer from the provider (${call.error.message})`;
  return `HTTP ${call.status}${call.error.name ? ` ${call.error.name}` : ''}: ${call.error.message}`;
}

export function createResendClient(opts: ResendClientOptions): ResendClient {
  const base = (opts.baseUrl ?? RESEND_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const http: ResendHttp = opts.http ?? ((url, init) => outboundRequest(opts.mode, url, init, opts.clock.now()));
  const scrub = scrubber(opts.apiKey);
  const timeout = opts.timeoutMs ?? SEND_TIMEOUT_MS;

  async function call<T>(method: 'GET' | 'POST', path: string, body: string | null, extraHeaders: Record<string, string>, read: (json: unknown) => T | null): Promise<ResendCall<T>> {
    const headers: Record<string, string> = { authorization: `Bearer ${opts.apiKey}`, accept: 'application/json', ...extraHeaders };
    if (body !== null) headers['content-type'] = 'application/json';
    let res: OutboundResponse;
    try {
      res = await http(`${base}${path}`, { method, headers, ...(body !== null ? { body } : {}), headersTimeoutMs: timeout, bodyTimeoutMs: timeout });
    } catch (error) {
      return { ok: false, phase: outboundFailurePhase(error), status: null, error: { name: null, message: boundedError(scrub(outboundFailureLabel(error))) } };
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
      return { ok: false, phase: 'response', status: res.statusCode, error: { name: null, message: 'the provider answer did not have the documented shape' } };
    }
    const after = retryAfterMs(res.headers, opts.clock.now());
    return { ok: false, phase: 'response', status: res.statusCode, error: parseResendError(res.body, scrub), ...(after !== undefined ? { retryAfterMs: after } : {}) };
  }

  return {
    listDomains: () =>
      call('GET', '/domains', null, {}, (json) => {
        const o = record(json);
        if (!Array.isArray(o.data)) return null;
        const domains = o.data
          .map((d) => record(d))
          .filter((d) => typeof d.name === 'string')
          .map((d) => ({ name: String(d.name), status: typeof d.status === 'string' ? d.status : '' }));
        return { domains, hasMore: o.has_more === true };
      }),
    sendEmail: (payload, idempotencyKey) =>
      call('POST', '/emails', payload, { 'idempotency-key': idempotencyKey }, (json) => {
        // A 2xx is accepted whatever its body; an id is what makes it a confirmed send.
        const id = record(json).id;
        return { id: typeof id === 'string' && id.length > 0 && id.length <= 256 ? id : null };
      }),
  };
}

// ---- Request body (pure) ----------------------------------------------------------------------------

function localFailure(reasonCode: string, error: string): FailedOutcome {
  return { status: 'failed', failureClass: 'PERMANENT', reasonCode, error: boundedError(error), suppress: false, manualRetryAfterMs: null, throttleScope: null };
}

/** `"Display Name" <address>`; the name loses quotes, backslashes, angle brackets and control characters. */
export function formatFromHeader(name: string, address: string): string {
  const clean = name
    .replace(/[\u0000-\u001f\u007f"\\<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return clean ? `"${clean}" <${address}>` : address;
}

/**
 * The JSON body of one send, or a PERMANENT failure for anything that cannot be sent (decided
 * locally, before any request).
 */
export function buildResendSendBody(req: EmailSendRequest, fromAddress: string): { ok: true; body: Record<string, unknown> } | { ok: false; outcome: FailedOutcome } {
  if (!EMAIL_RE.test(fromAddress)) return { ok: false, outcome: localFailure('EMAIL_FROM_INVALID', 'the configured from address is not an email address') };
  if (!EMAIL_RE.test(req.to)) return { ok: false, outcome: localFailure('INVALID_RECIPIENT', 'the recipient is not an email address') };
  const subject = req.subject.trim();
  if (subject === '' || subject.length > SUBJECT_MAX || CRLF_RE.test(subject)) return { ok: false, outcome: localFailure('EMAIL_SUBJECT_INVALID', 'the subject is empty, too long or has line breaks') };
  if (req.text.trim() === '') return { ok: false, outcome: localFailure('EMPTY_BODY', 'an email without text') };
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HEADER_NAME_RE.test(name) || CRLF_RE.test(value)) return { ok: false, outcome: localFailure('EMAIL_HEADER_INVALID', `the ${HEADER_NAME_RE.test(name) ? name : 'custom'} header is not a single line`) };
    headers[name] = value;
  }
  let encoded = 0;
  const attachments = req.attachments.map((a) => {
    const content = a.bytes.toString('base64');
    encoded += content.length;
    return { filename: a.filename.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 200), content };
  });
  if (encoded > RESEND_MAX_ENCODED_BYTES) return { ok: false, outcome: localFailure('ATTACHMENT_TOO_LARGE', 'the attachment is larger than the provider accepts') };
  const tags = TAG_VALUE_RE.test(req.attemptId) ? [{ name: RESEND_ATTEMPT_TAG, value: req.attemptId }] : [];
  return {
    ok: true,
    body: {
      from: formatFromHeader(req.from.name, fromAddress),
      to: [req.to],
      subject,
      text: req.text,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    },
  };
}

// ---- Transport ------------------------------------------------------------------------------------

function classifyCall(call: ResendFailedCall): FailedOutcome | AmbiguousOutcome {
  if (call.phase !== 'response') return classifyEmailFailure({ transport: 'http', phase: call.phase, message: describeResendFailure(call) });
  return classifyEmailFailure({ transport: 'http', phase: 'response', httpStatus: call.status, providerCode: call.error.name ?? undefined, retryAfterMs: call.retryAfterMs, message: describeResendFailure(call) });
}

/** The outcome is unknown and the same key may safely be replayed once: after the write, or a 5xx. */
function replayable(call: ResendFailedCall): boolean {
  return call.phase === 'after-write' || (call.phase === 'response' && call.status >= 500);
}

export function createResendTransport(opts: ResendOptions): EmailTransport {
  const client = createResendClient(opts);
  return {
    label: 'resend',
    simulated: false,
    async send(req: EmailSendRequest): Promise<SendOutcome> {
      const built = buildResendSendBody(req, opts.fromAddress);
      if (!built.ok) return built.outcome;
      if (!IDEMPOTENCY_KEY_RE.test(req.idempotencyKey)) return localFailure('IDEMPOTENCY_KEY_INVALID', 'the idempotency key must be 1 to 256 visible characters');
      // Serialized once: a replay sends exactly the same bytes under the same key.
      const payload = JSON.stringify(built.body);
      const first = await client.sendEmail(payload, req.idempotencyKey);
      if (first.ok) {
        if (first.data.id) return { status: 'sent', providerMessageId: first.data.id, simulated: false };
        return { status: 'ambiguous', reasonCode: 'NO_MESSAGE_ID', error: 'the provider accepted the request without a message id' };
      }
      const outcome = classifyCall(first);
      if (outcome.status !== 'ambiguous' || !replayable(first)) return outcome;
      const replay = await client.sendEmail(payload, req.idempotencyKey);
      if (replay.ok && replay.data.id) return { status: 'sent', providerMessageId: replay.data.id, simulated: false };
      const replayLine = replay.ok ? 'accepted without a message id' : describeResendFailure(replay);
      return { status: 'ambiguous', reasonCode: outcome.reasonCode, error: boundedError(`${outcome.error}; replay with the same Idempotency-Key: ${replayLine}`) };
    },
  };
}

// ---- Reads (connection test) --------------------------------------------------------------------------

export type ResendReadFailure = 'unreachable' | 'auth' | 'sending-only' | 'permission' | 'rate-limited' | 'unavailable' | 'rejected';

/**
 * What a failed read means. A sending-only key answers the domain list with 401
 * `restricted_api_key` (third-party reports; UNVERIFIED): the key is real but may only send.
 */
export function classifyResendReadFailure(call: ResendFailedCall): ResendReadFailure {
  if (call.phase !== 'response') return 'unreachable';
  const name = call.error.name;
  if (call.status === 401 && name === 'restricted_api_key') return 'sending-only';
  if (name === 'missing_api_key' || name === 'invalid_api_key' || call.status === 401 || call.status === 403) return 'auth';
  if (name === 'invalid_access') return 'permission';
  if (call.status === 429) return 'rate-limited';
  if (call.status >= 500) return 'unavailable';
  return 'rejected';
}

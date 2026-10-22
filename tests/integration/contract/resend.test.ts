// T33 (R27, E7, ADR-41, ADR-100, ADR-101; fixture-tested, not live-verified, plan §13): Resend.
// - Send shape: POST /emails with the documented body (from at the configured address, text only,
//   the unsubscribe headers, the PDF in base64, the attempt tag), the API key only in
//   Authorization, the attempt's own Idempotency-Key.
// - Every error fixture classified through the dated error map (401/403/409/422/429); Retry-After
//   honoured; a 5xx or a timeout after the write replays the same bytes under the same key once:
//   2xx is a confirmed send, anything else AMBIGUOUS; a failure before the write is PRE_SEND.
// - Webhook: Svix signature valid / invalid / stale / missing, routing by our key only, svix-id
//   dedupe scoped by integration, hard bounce and complaint suppress synchronously, out-of-order
//   events merge by rank, the attempt tag resolves an AMBIGUOUS attempt, non-delivery events and
//   inbound email are acknowledged and not stored.
// - Connection test: a verified sending domain is CONNECTED, never without a real answer.
// Zero outbound connections: a scripted Resend stand-in, or a server on 127.0.0.1.
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@/lib/clock';
import { EMAIL_ERROR_MAP_CHECKED_ON } from '@/server/adapters/email/error-map';
import type { EmailSendRequest } from '@/server/adapters/email/port';
import { createResendTransport, RESEND_ATTEMPT_TAG, type ResendOptions } from '@/server/adapters/email/resend';
import { outboundAttempts, resetOutboundAttempts } from '@/server/adapters/http/outbound';
import { svixSecretKey, verifySvixSignature } from '@/server/security/svix';
import { contactKey } from '@/server/security/contact-key';
import { testIntegrationConnection } from '@/server/services/integrations/connection-test';
import { liveAdapters } from '@/server/services/integrations/live-adapters';
import { POST as resendPost } from '@/app/api/webhooks/email/[provider]/[routingKey]/route';
import { createLiveHarness, PEPPER, type LiveHarness } from '../integrations/live-support';
import { emailLead, installLiveRuntime, queueEmail, RESEND_KEY, storeResend } from './email-live-support';
import { emailFixture, emailFixtureNames, FakeResend, newSigningSecret, resendAnswer, svixHeaders, svixSign } from './email-support';
import { networkError } from './whatsapp-support';

const clock = new FixedClock('2026-10-20T06:00:00.000Z');
const pdf = Buffer.from('%PDF-1.4\n% contract test quotation\n%%EOF\n');
const REQUEST = emailFixture<Record<string, unknown>>('request.send.json');
const ACCEPTED_ID = emailFixture<{ id: string }>('response.send-accepted.json').id;

const sendRequest = (over: Partial<EmailSendRequest> = {}): EmailSendRequest => ({
  attemptId: 'attcontract0001',
  idempotencyKey: 'dispatch-attempt:msg_1:1',
  workspaceId: 'ws_contract',
  // The dispatch handler's placeholder: the transport sends from its configured address instead.
  from: { name: 'Live Dental Co', address: 'quotes@live-dental-co.invalid' },
  to: 'lead@example.net',
  subject: REQUEST.subject as string,
  text: REQUEST.text as string,
  headers: REQUEST.headers as Record<string, string>,
  attachments: [{ filename: 'Q-0007-v2.pdf', contentType: 'application/pdf', bytes: pdf, sha256: createHash('sha256').update(pdf).digest('hex') }],
  ...over,
});

let api: FakeResend;
let servers: Server[] = [];
function transport(over: Partial<ResendOptions> = {}) {
  api = new FakeResend();
  return createResendTransport({ mode: 'live', apiKey: RESEND_KEY, fromAddress: 'quotes@example.com', clock, http: api.http, ...over });
}

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
  resetOutboundAttempts();
});

describe('send request shape (documented-shape fixtures)', () => {
  it('POST /emails with the documented body, the key only in Authorization and the attempt key as Idempotency-Key', async () => {
    const t = transport();
    api.on('POST', /^\/emails$/, resendAnswer('response.send-accepted.json'));
    expect(await t.send(sendRequest())).toEqual({ status: 'sent', providerMessageId: ACCEPTED_ID, simulated: false });
    expect(api.requests).toHaveLength(1);
    const req = api.requests[0]!;
    expect(req.url).toBe('https://api.resend.com/emails');
    expect(req.body).toEqual(REQUEST);
    expect(req.headers.authorization).toBe(`Bearer ${RESEND_KEY}`);
    expect(req.headers['idempotency-key']).toBe('dispatch-attempt:msg_1:1');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.url).not.toContain(RESEND_KEY);
    expect(JSON.stringify(req.body)).not.toContain('.invalid');
    expect(req.body).not.toHaveProperty('reply_to');
    expect(req.body).not.toHaveProperty('html');
    expect((req.body as { tags: Array<{ name: string }> }).tags[0]!.name).toBe(RESEND_ATTEMPT_TAG);
  });

  it('decides what it can locally, before any request (PERMANENT, nothing sent)', async () => {
    const t = transport();
    expect(await t.send(sendRequest({ to: 'not-an-address' }))).toMatchObject({ status: 'failed', failureClass: 'PERMANENT', reasonCode: 'INVALID_RECIPIENT' });
    expect(await t.send(sendRequest({ headers: { 'List-Unsubscribe': '<https://x>\r\nBcc: someone@example.net' } }))).toMatchObject({ failureClass: 'PERMANENT', reasonCode: 'EMAIL_HEADER_INVALID' });
    expect(await t.send(sendRequest({ subject: 'two\nlines' }))).toMatchObject({ failureClass: 'PERMANENT', reasonCode: 'EMAIL_SUBJECT_INVALID' });
    expect(await t.send(sendRequest({ text: '  ' }))).toMatchObject({ failureClass: 'PERMANENT', reasonCode: 'EMPTY_BODY' });
    expect(await t.send(sendRequest({ idempotencyKey: 'x'.repeat(257) }))).toMatchObject({ failureClass: 'PERMANENT', reasonCode: 'IDEMPOTENCY_KEY_INVALID' });
    expect(api.requests).toHaveLength(0);
  });
});

describe('error map mapping from the error fixtures', () => {
  const expected: Record<string, { status: string; failureClass?: string; reasonCode: string; throttleScope?: string | null }> = {
    'error.401.missing_api_key.json': { status: 'failed', failureClass: 'PERMANENT', reasonCode: 'PROVIDER_AUTH' },
    'error.401.restricted_api_key.json': { status: 'failed', failureClass: 'PERMANENT', reasonCode: 'PROVIDER_PERMISSION' },
    'error.403.invalid_api_key.json': { status: 'failed', failureClass: 'PERMANENT', reasonCode: 'PROVIDER_AUTH' },
    'error.403.validation_error.json': { status: 'failed', failureClass: 'PERMANENT', reasonCode: 'EMAIL_VALIDATION_FAILED' },
    'error.422.invalid_from_address.json': { status: 'failed', failureClass: 'PERMANENT', reasonCode: 'EMAIL_FROM_INVALID' },
    'error.422.missing_required_field.json': { status: 'failed', failureClass: 'PERMANENT', reasonCode: 'EMAIL_VALIDATION_FAILED' },
    'error.409.invalid_idempotent_request.json': { status: 'failed', failureClass: 'PERMANENT', reasonCode: 'IDEMPOTENCY_KEY_REUSED' },
    'error.409.concurrent_idempotent_requests.json': { status: 'ambiguous', reasonCode: 'IDEMPOTENT_REQUEST_IN_PROGRESS' },
    'error.429.rate_limit_exceeded.json': { status: 'failed', failureClass: 'RETRYABLE', reasonCode: 'RATE_LIMITED', throttleScope: 'workspace' },
    'error.429.daily_quota_exceeded.json': { status: 'failed', failureClass: 'RETRYABLE', reasonCode: 'PROVIDER_QUOTA', throttleScope: 'workspace' },
    'error.429.monthly_quota_exceeded.json': { status: 'failed', failureClass: 'PERMANENT', reasonCode: 'PROVIDER_QUOTA_MONTHLY' },
  };

  it('covers every 4xx error fixture, and the map is dated', () => {
    expect(EMAIL_ERROR_MAP_CHECKED_ON).toBe('2026-10-20');
    const fixtures = emailFixtureNames().filter((n) => /^error\.4/.test(n));
    expect(fixtures.sort()).toEqual(Object.keys(expected).sort());
  });

  for (const [name, outcome] of Object.entries(expected)) {
    it(`${name} -> ${outcome.reasonCode} (one request, no replay)`, async () => {
      const t = transport();
      api.on('POST', /^\/emails$/, resendAnswer(name, name.includes('rate_limit') ? { 'retry-after': '2' } : undefined));
      const res = await t.send(sendRequest());
      expect(res).toMatchObject(outcome);
      if (name.includes('rate_limit')) expect(res).toMatchObject({ retryAfterMs: 2_000 });
      expect(api.requests).toHaveLength(1);
    });
  }

  it('a provider error that echoes the key never carries it into the outcome', async () => {
    const t = transport();
    api.on('POST', /^\/emails$/, { status: 403, body: { statusCode: 403, name: 'invalid_api_key', message: `API key ${RESEND_KEY} is invalid` } });
    const res = await t.send(sendRequest());
    expect(res).toMatchObject({ status: 'failed', reasonCode: 'PROVIDER_AUTH' });
    expect(JSON.stringify(res)).not.toContain(RESEND_KEY);
  });
});

describe('unknown outcomes: one replay under the same Idempotency-Key, then AMBIGUOUS', () => {
  it('a 5xx then 2xx is a confirmed send; both requests carry identical bytes and the same key', async () => {
    const t = transport();
    api.on('POST', /^\/emails$/, resendAnswer('error.500.application_error.json'), resendAnswer('response.send-accepted.json'));
    expect(await t.send(sendRequest())).toEqual({ status: 'sent', providerMessageId: ACCEPTED_ID, simulated: false });
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1]!.raw!.equals(api.requests[0]!.raw!)).toBe(true);
    expect(api.requests[1]!.headers['idempotency-key']).toBe(api.requests[0]!.headers['idempotency-key']);
  });

  it('a 5xx twice is AMBIGUOUS (never a failure that would create a new attempt)', async () => {
    const t = transport();
    api.on('POST', /^\/emails$/, resendAnswer('error.500.application_error.json'), resendAnswer('error.500.application_error.json'));
    expect(await t.send(sendRequest())).toMatchObject({ status: 'ambiguous', reasonCode: 'PROVIDER_5XX_UNCONFIRMED' });
    expect(api.requests).toHaveLength(2);
  });

  it('a timeout after the write then a 2xx is sent; then a rejection or another timeout stays AMBIGUOUS', async () => {
    const t = transport();
    api.on('POST', /^\/emails$/, { throw: networkError('UND_ERR_HEADERS_TIMEOUT') }, resendAnswer('response.send-accepted.json'));
    expect(await t.send(sendRequest())).toMatchObject({ status: 'sent', providerMessageId: ACCEPTED_ID });
    api.reset();
    api.on('POST', /^\/emails$/, { throw: networkError('ECONNRESET') }, resendAnswer('error.422.missing_required_field.json'));
    expect(await t.send(sendRequest())).toMatchObject({ status: 'ambiguous', reasonCode: 'TIMEOUT_AFTER_WRITE' });
    api.reset();
    api.on('POST', /^\/emails$/, { throw: networkError('UND_ERR_HEADERS_TIMEOUT') }, { throw: networkError('UND_ERR_HEADERS_TIMEOUT') });
    expect(await t.send(sendRequest())).toMatchObject({ status: 'ambiguous', reasonCode: 'TIMEOUT_AFTER_WRITE' });
    expect(api.requests).toHaveLength(2);
  });

  it('a failure before the write is PRE_SEND with no replay; a 2xx without an id is AMBIGUOUS with no replay', async () => {
    const t = transport();
    api.on('POST', /^\/emails$/, { throw: networkError('ECONNREFUSED') }, resendAnswer('response.send-no-id.json'));
    expect(await t.send(sendRequest())).toMatchObject({ status: 'failed', failureClass: 'PRE_SEND', reasonCode: 'CONNECT_FAILED' });
    expect(await t.send(sendRequest())).toMatchObject({ status: 'ambiguous', reasonCode: 'NO_MESSAGE_ID' });
    expect(api.requests).toHaveLength(2);
  });

  it('through a real socket on 127.0.0.1: a server that never answers gets the request twice under one key, then AMBIGUOUS', async () => {
    const keys: string[] = [];
    const server = createServer((req) => {
      keys.push(String(req.headers['idempotency-key']));
      req.resume();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const t = createResendTransport({ mode: 'live', apiKey: RESEND_KEY, fromAddress: 'quotes@example.com', clock, baseUrl, timeoutMs: 250 });
    expect(await t.send(sendRequest())).toMatchObject({ status: 'ambiguous', reasonCode: 'TIMEOUT_AFTER_WRITE' });
    expect(keys).toEqual(['dispatch-attempt:msg_1:1', 'dispatch-attempt:msg_1:1']);
  });

  it('a DEMO-mode client is stopped by the outbound tripwire before any socket (PRE_SEND, recorded blocked, no replay)', async () => {
    const t = createResendTransport({ mode: 'demo', apiKey: RESEND_KEY, fromAddress: 'quotes@example.com', clock });
    expect(await t.send(sendRequest())).toMatchObject({ status: 'failed', failureClass: 'PRE_SEND' });
    expect(outboundAttempts()).toEqual([expect.objectContaining({ host: 'api.resend.com', mode: 'demo', blocked: true })]);
  });
});

describe('Svix signature (pure)', () => {
  const secret = newSigningSecret();
  const raw = Buffer.from(JSON.stringify(emailFixture('webhook.email.delivered.json')));
  const now = new Date('2026-10-20T06:05:00.000Z');
  const ts = Math.floor(now.getTime() / 1000);
  const headers = (signature: string, at = ts, id = 'msg_2abcDEF') => ({ id, timestamp: String(at), signature });

  it('valid, including a second signature after a secret rotation', () => {
    expect(verifySvixSignature({ secret, headers: headers(svixSign(secret, 'msg_2abcDEF', ts, raw)), raw, now })).toMatchObject({ ok: true, id: 'msg_2abcDEF' });
    const old = svixSign(newSigningSecret(), 'msg_2abcDEF', ts, raw);
    expect(verifySvixSignature({ secret, headers: headers(`${old} ${svixSign(secret, 'msg_2abcDEF', ts, raw)}`), raw, now }).ok).toBe(true);
  });

  it('invalid: another secret, a flipped byte, a re-serialized body, another id, a v2 prefix', () => {
    const good = svixSign(secret, 'msg_2abcDEF', ts, raw);
    expect(verifySvixSignature({ secret: newSigningSecret(), headers: headers(good), raw, now })).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
    const flipped = Buffer.from(raw);
    flipped[10] = flipped[10]! ^ 1;
    expect(verifySvixSignature({ secret, headers: headers(good), raw: flipped, now })).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString()), null, 2));
    expect(verifySvixSignature({ secret, headers: headers(good), raw: reserialized, now })).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
    expect(verifySvixSignature({ secret, headers: headers(good, ts, 'msg_other'), raw, now })).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
    expect(verifySvixSignature({ secret, headers: headers(good.replace('v1,', 'v2,')), raw, now })).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
  });

  it('stale or future by more than 5 minutes is REPLAY_WINDOW; exactly 5 minutes passes', () => {
    for (const at of [ts - 301, ts + 301]) expect(verifySvixSignature({ secret, headers: headers(svixSign(secret, 'msg_2abcDEF', at, raw), at), raw, now })).toEqual({ ok: false, reason: 'REPLAY_WINDOW' });
    expect(verifySvixSignature({ secret, headers: headers(svixSign(secret, 'msg_2abcDEF', ts - 300, raw), ts - 300), raw, now }).ok).toBe(true);
  });

  it('missing headers, or no usable secret', () => {
    expect(verifySvixSignature({ secret, headers: { id: null, timestamp: String(ts), signature: 'v1,x' }, raw, now })).toEqual({ ok: false, reason: 'SIGNATURE_MISSING' });
    expect(verifySvixSignature({ secret: null, headers: headers('v1,x'), raw, now })).toEqual({ ok: false, reason: 'SECRET_NOT_CONFIGURED' });
    expect(svixSecretKey('whsec_short')).toBeNull();
  });
});

describe('webhook route and connection test (LIVE)', () => {
  let h: LiveHarness;
  let uninstall: () => Promise<void>;
  let integrationId: string;
  const secret = newSigningSecret();
  const ROUTING_KEY = `rs_${'A'.repeat(31)}b`;
  let seq = 0;

  beforeAll(async () => {
    h = await createLiveHarness('t33-resend');
    uninstall = installLiveRuntime(h);
    integrationId = (await storeResend(h, { webhookSecret: secret, routingKey: ROUTING_KEY })).id;
  }, 120_000);
  afterAll(async () => {
    await uninstall?.();
    await h?.destroy();
  });
  beforeEach(async () => {
    h.resend.reset();
    await storeResend(h, { webhookSecret: secret, routingKey: ROUTING_KEY });
  });

  const nowSec = () => Math.floor(h.clock.now().getTime() / 1000);
  async function post(event: unknown, opts: { id?: string; at?: number; signWith?: string; routingKey?: string; headers?: Record<string, string> } = {}) {
    const raw = JSON.stringify(event);
    const id = opts.id ?? `msg_t33_${++seq}`;
    const headers = opts.headers ?? svixHeaders(opts.signWith ?? secret, id, opts.at ?? nowSec(), raw);
    const routingKey = opts.routingKey ?? ROUTING_KEY;
    const res = await resendPost(new Request(`http://localhost:3000/api/webhooks/email/resend/${routingKey}`, { method: 'POST', headers, body: raw }), { params: Promise.resolve({ provider: 'resend', routingKey }) });
    return { res, id, body: (await res.json()) as Record<string, unknown> };
  }

  /** One email sent through the registry's Resend transport (scripted API) to a fresh lead. */
  async function sentEmail() {
    const { lead, email } = await emailLead(h);
    const providerId = `re-${++seq}-${lead.id.slice(-6)}`;
    h.resend.on('POST', /^\/emails$/, { status: 200, body: { id: providerId } });
    const q = await queueEmail(h, lead.id);
    await h.drain();
    const message = await h.db.message.findUniqueOrThrow({ where: { id: q.messageId } });
    expect(message).toMatchObject({ status: 'SENT', providerMessageId: providerId });
    return { lead, email, q, providerId };
  }
  const event = (name: string, providerId: string, email: string, extra: Record<string, unknown> = {}) => {
    const base = emailFixture<{ type: string; created_at: string; data: Record<string, unknown> }>(name);
    return { ...base, created_at: h.clock.now().toISOString(), data: { ...base.data, email_id: providerId, to: [email], ...extra } };
  };
  const rejections = (reason: string) => h.db.webhookRejection.aggregate({ where: { provider: 'RESEND', reason }, _sum: { count: true } }).then((r) => r._sum.count ?? 0);

  it('a valid delivered event is stored once per svix-id (scoped by the integration), encrypted, and moves the message to DELIVERED', async () => {
    const { email, q, providerId } = await sentEmail();
    const { res, id, body } = await post(event('webhook.email.delivered.json', providerId, email));
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ outcome: 'ACCEPTED' });
    const again = await post(event('webhook.email.delivered.json', providerId, email), { id });
    expect(again.body).toMatchObject({ outcome: 'DUPLICATE' });
    const rows = await h.db.webhookEvent.findMany({ where: { provider: 'RESEND', externalKey: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scopeKey: integrationId, integrationId, workspaceId: h.workspaceId, status: 'RECEIVED' });
    expect(JSON.stringify(rows[0]!.payloadRedacted)).not.toContain(email);
    expect(rows[0]!.processingPayload).not.toContain(email);
    // Same svix-id, different content: CONFLICT, not stored again.
    const conflict = await post(event('webhook.email.delivery_delayed.json', providerId, email), { id });
    expect(conflict.body).toMatchObject({ outcome: 'CONFLICT' });
    await h.drain();
    expect(await h.db.message.findUniqueOrThrow({ where: { id: q.messageId } })).toMatchObject({ status: 'DELIVERED', statusRank: 2 });
  }, 60_000);

  it('a hard bounce suppresses EMAIL synchronously; a late bounce after delivery is an anomaly, not a state change', async () => {
    const { email, q, providerId } = await sentEmail();
    await post(event('webhook.email.delivered.json', providerId, email));
    await h.drain();
    const { res, body } = await post(event('webhook.email.bounced.json', providerId, email));
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ outcome: 'ACCEPTED', suppressed: 'CREATED' });
    expect(await h.db.suppression.findFirst({ where: { workspaceId: h.workspaceId, channel: 'EMAIL', contactKey: contactKey(PEPPER, 'email', email), clearedAt: null } })).toMatchObject({ reason: 'HARD_BOUNCE' });
    await h.drain();
    expect(await h.db.message.findUniqueOrThrow({ where: { id: q.messageId } })).toMatchObject({ status: 'DELIVERED' });
    expect(await h.db.messageStatusEvent.findFirst({ where: { providerMessageId: providerId, status: 'email.bounced' } })).toMatchObject({ anomaly: true });
  }, 60_000);

  it('a complaint suppresses; a temporary bounce and a delay suppress nothing', async () => {
    const { email, providerId } = await sentEmail();
    const key = contactKey(PEPPER, 'email', email);
    await post(event('webhook.email.bounced.json', providerId, email, { bounce: { type: 'Transient', subType: 'General', message: 'mailbox full' } }));
    await post(event('webhook.email.delivery_delayed.json', providerId, email));
    expect(await h.db.suppression.count({ where: { channel: 'EMAIL', contactKey: key } })).toBe(0);
    expect((await post(event('webhook.email.complained.json', providerId, email))).body).toMatchObject({ suppressed: 'CREATED' });
    expect(await h.db.suppression.findFirst({ where: { channel: 'EMAIL', contactKey: key, clearedAt: null } })).toMatchObject({ reason: 'COMPLAINT' });
  }, 60_000);

  it('the attempt tag echoed by a delivered event resolves an AMBIGUOUS attempt with positive evidence', async () => {
    const { lead, email } = await emailLead(h);
    h.resend.on('POST', /^\/emails$/, { throw: networkError('UND_ERR_HEADERS_TIMEOUT') }, { throw: networkError('UND_ERR_HEADERS_TIMEOUT') });
    const q = await queueEmail(h, lead.id);
    await h.drain();
    const attempt = await h.db.dispatchAttempt.findFirstOrThrow({ where: { messageId: q.messageId } });
    expect(attempt.state).toBe('AMBIGUOUS');
    expect(h.resend.requests).toHaveLength(2);
    await post(event('webhook.email.delivered.json', 'b7e1f0c2-late-provider-id', email, { tags: { [RESEND_ATTEMPT_TAG]: attempt.id } }));
    await h.drain();
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({ state: 'SENT', providerMessageId: 'b7e1f0c2-late-provider-id', resolvedBy: 'system:status.apply' });
    expect(await h.db.message.findUniqueOrThrow({ where: { id: q.messageId } })).toMatchObject({ status: 'DELIVERED' });
  }, 60_000);

  it('refuses a bad, missing or stale signature (401, counted, nothing stored)', async () => {
    const before = await h.db.webhookEvent.count();
    const delivered = emailFixture('webhook.email.delivered.json');
    const bad = await post(delivered, { signWith: newSigningSecret() });
    expect(bad.res.status).toBe(401);
    expect(bad.body).toMatchObject({ code: 'SIGNATURE_INVALID' });
    const stale = await post(delivered, { at: nowSec() - 600 });
    expect(stale.res.status).toBe(401);
    expect(stale.body).toMatchObject({ code: 'REPLAY_WINDOW' });
    expect((await post(delivered, { headers: { 'content-type': 'application/json' } })).res.status).toBe(401);
    expect(await h.db.webhookEvent.count()).toBe(before);
    expect(await rejections('SIGNATURE_INVALID')).toBeGreaterThanOrEqual(1);
    expect(await rejections('REPLAY_WINDOW')).toBeGreaterThanOrEqual(1);
    expect(await rejections('SIGNATURE_MISSING')).toBeGreaterThanOrEqual(1);
  });

  it('routes only by our key: an unknown key is 404; a Resend integration without a signing secret is 401', async () => {
    const unknown = await post(emailFixture('webhook.email.delivered.json'), { routingKey: `rs_${'Z'.repeat(32)}` });
    expect(unknown.res.status).toBe(404);
    expect((await post(emailFixture('webhook.email.delivered.json'), { routingKey: 'not-a-key' })).res.status).toBe(404);
    expect(await rejections('ROUTING_KEY_UNKNOWN')).toBeGreaterThanOrEqual(2);
    await storeResend(h, { webhookSecret: null, routingKey: ROUTING_KEY });
    expect((await post(emailFixture('webhook.email.delivered.json'))).res.status).toBe(401);
    expect(await rejections('SECRET_NOT_CONFIGURED')).toBeGreaterThanOrEqual(1);
  });

  it('the same svix-id from two workspaces never collides (E2)', async () => {
    const other = await h.db.workspace.create({ data: { slug: 'other-live-co', name: 'Other Live Co', mode: 'LIVE', planLabel: 'Growth', timezone: 'Asia/Kolkata' } });
    const otherSecret = newSigningSecret();
    const otherKey = `rs_${'B'.repeat(31)}c`;
    const row = await h.db.integration.create({ data: { workspaceId: other.id, kind: 'EMAIL_RESEND', status: 'CONNECTED', config: { fromDomain: 'example.org', fromAddress: 'a@example.org' }, routingKey: otherKey } });
    const { credentialAad, encryptSecret } = await import('@/server/security/secrets');
    const { KEY_RING } = await import('../integrations/live-support');
    await h.db.integration.update({ where: { id: row.id }, data: { secrets: { webhookSecret: encryptSecret(KEY_RING, otherSecret, credentialAad({ workspaceId: other.id, integrationId: row.id, field: 'webhookSecret' })) } } });
    const delivered = emailFixture('webhook.email.delivered.json');
    const a = await post(delivered, { id: 'msg_shared_id' });
    const b = await post(delivered, { id: 'msg_shared_id', signWith: otherSecret, routingKey: otherKey });
    expect([a.body.outcome, b.body.outcome]).toEqual(['ACCEPTED', 'ACCEPTED']);
    expect(await h.db.webhookEvent.count({ where: { provider: 'RESEND', externalKey: 'msg_shared_id' } })).toBe(2);
  });

  it('non-delivery events and inbound email are verified, acknowledged and not stored', async () => {
    const before = await h.db.webhookEvent.count();
    for (const name of ['webhook.domain.updated.json', 'webhook.email.received.json']) {
      const { res, body } = await post(emailFixture(name));
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ outcome: 'IGNORED' });
    }
    expect(await h.db.webhookEvent.count()).toBe(before);
  });

  describe('connection test', () => {
    const test = async () => {
      const ctx = await h.owner();
      return testIntegrationConnection(ctx, { kind: 'EMAIL_RESEND' }, { testers: liveAdapters(h.deps()).testers });
    };

    it('a verified sending domain is CONNECTED; the key goes only in Authorization of GET /domains; no email is sent', async () => {
      h.resend.on('GET', /^\/domains$/, resendAnswer('response.domains.json'));
      expect(await test()).toMatchObject({ outcome: 'TESTED', status: 'CONNECTED' });
      expect(h.resend.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /domains']);
      expect(h.resend.requests[0]!.headers.authorization).toBe(`Bearer ${RESEND_KEY}`);
    });

    it('a pending or absent domain is ERROR CONFIG_INVALID with the raw status', async () => {
      await storeResend(h, { webhookSecret: secret, routingKey: ROUTING_KEY, fromDomain: 'pending.example.com', fromAddress: 'q@pending.example.com' });
      h.resend.on('GET', /^\/domains$/, resendAnswer('response.domains.json'), resendAnswer('response.domains.json'));
      const pending = await test();
      expect(pending).toMatchObject({ status: 'ERROR', errorCode: 'CONFIG_INVALID' });
      expect(pending.message).toContain('pending');
      await storeResend(h, { webhookSecret: secret, routingKey: ROUTING_KEY, fromDomain: 'absent.example.com', fromAddress: 'q@absent.example.com' });
      expect(await test()).toMatchObject({ status: 'ERROR', errorCode: 'CONFIG_INVALID' });
    });

    it('an invalid key is ERROR PROVIDER_AUTH; a sending-only key is CONNECTED; throttling and no answer are inconclusive', async () => {
      h.resend.on('GET', /^\/domains$/, resendAnswer('error.403.invalid_api_key.json'), resendAnswer('error.401.restricted_api_key.json'), resendAnswer('error.429.rate_limit_exceeded.json'), { throw: networkError('ECONNREFUSED') });
      expect(await test()).toMatchObject({ status: 'ERROR', errorCode: 'PROVIDER_AUTH' });
      await storeResend(h, { status: 'CONFIGURED_UNVERIFIED', webhookSecret: secret, routingKey: ROUTING_KEY });
      expect(await test()).toMatchObject({ status: 'CONNECTED' });
      expect(await test()).toMatchObject({ status: 'DEGRADED', errorCode: 'PROVIDER_RATE_LIMITED' });
      await storeResend(h, { status: 'CONFIGURED_UNVERIFIED', webhookSecret: secret, routingKey: ROUTING_KEY });
      expect(await test()).toMatchObject({ status: 'CONFIGURED_UNVERIFIED', errorCode: 'PROVIDER_UNREACHABLE' });
    });
  });
});

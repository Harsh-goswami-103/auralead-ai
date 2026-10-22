// T32 (P2, E7, ADR-41, ADR-62; fixture-tested, not live-verified, plan §13): the WhatsApp Cloud
// API transport behind the WhatsAppTransport port.
// - Request shapes for a template send (DOCUMENT header by media id, positional body parameters,
//   quick-reply payload ids set on this send), a free-form text and a free-form document, each
//   carrying `biz_opaque_callback_data = attemptId`, compared with the documented-shape fixtures.
// - The document goes up first as multipart media (never a link) and the message references it.
// - Every error fixture is classified through the dated error map (class, reason, suppress,
//   throttle scope, manual retry window); Retry-After is honoured.
// - A timeout after the request was written is AMBIGUOUS (never retried); a refused connection is
//   PRE_SEND; an upload failure never makes the message ambiguous.
// - The access token is only ever in the Authorization header: never in a URL or an error.
// Transport: a scripted Graph stand-in, or a server on 127.0.0.1 for the socket cases. Zero
// outbound connections.
import { createHash } from 'node:crypto';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@/lib/clock';
import { outboundAttempts, resetOutboundAttempts } from '@/server/adapters/http/outbound';
import { buildSendBody, createCloudApiTransport, type CloudApiOptions } from '@/server/adapters/whatsapp/cloud-api';
import { WHATSAPP_ERROR_MAP_CHECKED_ON } from '@/server/adapters/whatsapp/error-map';
import type { WaSendRequest } from '@/server/adapters/whatsapp/port';
import { QUICK_REPLY_PAYLOADS } from '@/server/services/messaging/quick-replies';
import { FakeGraph, fixtureAnswer, networkError, waFixture, waFixtureNames } from './whatsapp-support';

const TOKEN = 'EAAGcontracttesttoken0000000000000000000000';
const PHONE_ID = '109876543210987';
const WABA_ID = '209876543210987';
const clock = new FixedClock('2026-10-20T06:00:00.000Z');
const DOC_COMPONENTS = waFixture<unknown[]>('template.quote-ready-doc.components.json');
const pdf = Buffer.from('%PDF-1.4\n% contract test quotation\n%%EOF\n');
const DOCUMENT = { filename: 'Q-0007-v2.pdf', mimeType: 'application/pdf' as const, bytes: pdf, sha256: createHash('sha256').update(pdf).digest('hex') };

let graph: FakeGraph;
let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
  resetOutboundAttempts();
});

function transport(over: Partial<CloudApiOptions> = {}) {
  graph = new FakeGraph();
  return createCloudApiTransport({ mode: 'live', graphVersion: 'v24.0', phoneNumberId: PHONE_ID, wabaId: WABA_ID, accessToken: TOKEN, clock, http: graph.http, ...over });
}

const templateSend = (over: Partial<WaSendRequest> = {}): WaSendRequest => ({
  attemptId: 'att_contract_0001',
  idempotencyKey: 'dispatch-attempt:msg_1:1',
  workspaceId: 'ws_contract',
  to: '+919812345678',
  kind: 'template',
  template: {
    name: 'quote_ready_doc',
    language: 'en',
    variables: { '1': 'Priya', '2': 'Q-0007' },
    components: DOC_COMPONENTS,
    quickReplies: [
      { index: 0, payload: QUICK_REPLY_PAYLOADS.QUOTE },
      { index: 1, payload: QUICK_REPLY_PAYLOADS.CALL },
      { index: 2, payload: QUICK_REPLY_PAYLOADS.STOP },
    ],
  },
  body: null,
  document: DOCUMENT,
  ...over,
});

describe('request shapes (documented-shape fixtures)', () => {
  it('template: media upload first, then the template with a DOCUMENT header, body parameters and per-send quick-reply payloads', async () => {
    const t = transport();
    graph.on('POST', new RegExp(`^/v24\\.0/${PHONE_ID}/media$`), fixtureAnswer('response.media-upload.json'));
    graph.on('POST', new RegExp(`^/v24\\.0/${PHONE_ID}/messages$`), fixtureAnswer('response.send-accepted.json'));
    const outcome = await t.send(templateSend());

    expect(outcome).toEqual({ status: 'sent', providerMessageId: (waFixture('response.send-accepted.json').messages as Array<{ id: string }>)[0]!.id, simulated: false });
    expect(graph.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`POST /v24.0/${PHONE_ID}/media`, `POST /v24.0/${PHONE_ID}/messages`]);
    const [upload, send] = graph.requests as [(typeof graph.requests)[0], (typeof graph.requests)[0]];
    // The PDF itself goes up (P2: never a link), as multipart with the documented fields.
    expect(upload.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const multipart = upload.raw!.toString('latin1');
    expect(multipart).toContain('name="messaging_product"\r\n\r\nwhatsapp');
    expect(multipart).toContain('name="type"\r\n\r\napplication/pdf');
    expect(multipart).toContain('filename="Q-0007-v2.pdf"');
    expect(upload.raw!.includes(pdf)).toBe(true);
    expect(send.body).toEqual(waFixture('request.template-document-header.json'));
    for (const r of graph.requests) {
      expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(r.url).not.toContain(TOKEN);
    }
  });

  it('free-form text and free-form document match their fixtures', async () => {
    const t = transport();
    graph.on('POST', /\/messages$/, fixtureAnswer('response.send-accepted.json'), fixtureAnswer('response.send-accepted.json'));
    graph.on('POST', /\/media$/, fixtureAnswer('response.media-upload.json'));
    const text = await t.send({ ...templateSend(), attemptId: 'att_contract_0002', kind: 'freeform', template: null, document: null, body: 'Thanks, we will call you at 4 pm.' });
    const doc = await t.send({ ...templateSend(), attemptId: 'att_contract_0003', kind: 'freeform', template: null, body: 'Quotation Q-0007 (version 2) from Smile Avenue' });
    expect(text.status).toBe('sent');
    expect(doc.status).toBe('sent');
    const sends = graph.requests.filter((r) => r.path.endsWith('/messages'));
    expect(sends[0]!.body).toEqual(waFixture('request.text.json'));
    expect(sends[1]!.body).toEqual(waFixture('request.document.json'));
  });

  it('quick-reply payload ids are set per send: another mapping gives other payloads, unmapped buttons carry none', async () => {
    const first = buildSendBody(templateSend({ attemptId: 'att_a' }), 'media_1');
    const second = buildSendBody(
      templateSend({ attemptId: 'att_b', template: { ...templateSend().template!, quickReplies: [{ index: 2, payload: QUICK_REPLY_PAYLOADS.STOP }] } }),
      'media_1',
    );
    const buttons = (r: ReturnType<typeof buildSendBody>) => {
      if (!r.ok) throw new Error('expected a body');
      const components = (r.body.template as { components: Array<Record<string, unknown>> }).components;
      return components.filter((c) => c.type === 'button').map((c) => ({ index: c.index, payload: (c.parameters as Array<{ payload: string }>)[0]!.payload }));
    };
    expect(buttons(first)).toEqual([
      { index: '0', payload: 'AL_QR_QUOTE_V1' },
      { index: '1', payload: 'AL_QR_CALL_V1' },
      { index: '2', payload: 'AL_QR_STOP_V1' },
    ]);
    expect(buttons(second)).toEqual([{ index: '2', payload: 'AL_QR_STOP_V1' }]);
    // Each send carries its own attempt id for the status echo.
    expect(first.ok && first.body.biz_opaque_callback_data).toBe('att_a');
    expect(second.ok && second.body.biz_opaque_callback_data).toBe('att_b');
  });

  it('checks what can be decided locally before any request (PERMANENT, nothing sent)', async () => {
    const t = transport();
    const noHeader = [{ type: 'BODY', text: 'Hello {{1}}' }];
    const cases: Array<[WaSendRequest, string]> = [
      [templateSend({ template: { ...templateSend().template!, components: noHeader, variables: { '1': 'Priya' } } }), 'TEMPLATE_CANNOT_CARRY_DOCUMENT'],
      [templateSend({ document: null }), 'TEMPLATE_NEEDS_DOCUMENT'],
      [templateSend({ template: { ...templateSend().template!, variables: { '1': 'Priya' } } }), 'TEMPLATE_PARAMS_MISMATCH'],
      [templateSend({ document: null, template: { ...templateSend().template!, components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hi {{1}}' }], variables: { '1': 'x' } } }), 'TEMPLATE_UNSUPPORTED'],
      [templateSend({ to: '12' }), 'INVALID_RECIPIENT'],
      [{ ...templateSend(), kind: 'freeform', template: null, document: null, body: '   ' }, 'EMPTY_BODY'],
    ];
    for (const [req, reasonCode] of cases) {
      expect(await t.send(req)).toMatchObject({ status: 'failed', failureClass: 'PERMANENT', reasonCode });
    }
    expect(graph.requests).toHaveLength(0);
  });
});

describe('error map mapping from the error fixtures', () => {
  const expected: Record<string, Record<string, unknown>> = {
    'error.131049.json': { status: 'failed', failureClass: 'PERMANENT', reasonCode: 'RECIPIENT_FREQUENCY_CAP', manualRetryAfterMs: 24 * 60 * 60 * 1000, suppress: false },
    'error.131026.json': { status: 'failed', failureClass: 'PERMANENT', reasonCode: 'UNDELIVERABLE', suppress: false },
    'error.131047.json': { status: 'failed', failureClass: 'PERMANENT', reasonCode: 'WINDOW_CLOSED' },
    'error.131050.json': { status: 'failed', failureClass: 'PERMANENT', reasonCode: 'MARKETING_STOPPED', suppress: true },
    'error.130429.json': { status: 'failed', failureClass: 'RETRYABLE', reasonCode: 'RATE_LIMITED', throttleScope: 'workspace', retryAfterMs: 30_000 },
    'error.131056.json': { status: 'failed', failureClass: 'RETRYABLE', reasonCode: 'PAIR_RATE_LIMITED', throttleScope: 'pair' },
    'error.132000.json': { status: 'failed', failureClass: 'PERMANENT', reasonCode: 'TEMPLATE_PARAMS_MISMATCH' },
    'error.132001.json': { status: 'failed', failureClass: 'PERMANENT', reasonCode: 'TEMPLATE_NOT_FOUND' },
    'error.132015.json': { status: 'failed', failureClass: 'PERMANENT', reasonCode: 'TEMPLATE_PAUSED' },
    'error.131051.json': { status: 'failed', failureClass: 'PERMANENT', reasonCode: 'UNSUPPORTED_MESSAGE_TYPE' },
    'error.190.json': { status: 'failed', failureClass: 'PERMANENT', reasonCode: 'PROVIDER_AUTH' },
    'error.100.json': { status: 'failed', failureClass: 'PERMANENT', reasonCode: 'INVALID_PARAMETER' },
    // An unmapped 5xx gives no evidence that nothing was written: AMBIGUOUS, never retried.
    'error.131000.json': { status: 'ambiguous', reasonCode: 'PROVIDER_5XX_UNCONFIRMED' },
  };

  it('covers every error fixture, and the map is dated', () => {
    expect(waFixtureNames().filter((n) => n.startsWith('error.')).sort()).toEqual(Object.keys(expected).sort());
    expect(WHATSAPP_ERROR_MAP_CHECKED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  for (const [name, outcome] of Object.entries(expected)) {
    it(`${name} -> ${String(outcome.reasonCode)}`, async () => {
      const t = transport();
      graph.on('POST', /\/messages$/, fixtureAnswer(name, name === 'error.130429.json' ? { 'retry-after': '30' } : undefined));
      const res = await t.send(templateSend({ document: null, template: { ...templateSend().template!, components: [{ type: 'BODY', text: 'Hi {{1}} {{2}}' }] } }));
      expect(res).toMatchObject(outcome);
      if (res.status !== 'sent') {
        expect(res.error.length).toBeLessThanOrEqual(500);
        expect(res.error).not.toContain(TOKEN);
      }
    });
  }

  it('a 2xx without a message id is not a confirmed send (AMBIGUOUS NO_MESSAGE_ID)', async () => {
    const t = transport();
    graph.on('POST', /\/messages$/, fixtureAnswer('response.send-no-message-id.json'));
    expect(await t.send(templateSend({ document: null, template: { ...templateSend().template!, components: [{ type: 'BODY', text: 'Hi {{1}} {{2}}' }] } }))).toMatchObject({ status: 'ambiguous', reasonCode: 'NO_MESSAGE_ID' });
  });

  it('Retry-After as an HTTP date is honoured too', async () => {
    const t = transport();
    graph.on('POST', /\/messages$/, { status: 429, body: { error: { message: 'throttled', code: 4 } }, headers: { 'retry-after': new Date(clock.now().getTime() + 90_000).toUTCString() } });
    const res = await t.send({ ...templateSend(), kind: 'freeform', template: null, document: null, body: 'hello' });
    expect(res).toMatchObject({ status: 'failed', failureClass: 'RETRYABLE', reasonCode: 'RATE_LIMITED', retryAfterMs: 90_000 });
  });

  it('a provider error that echoes the token never carries it into the outcome', async () => {
    const t = transport();
    graph.on('POST', /\/messages$/, { status: 400, body: { error: { message: `Invalid OAuth access token - Cannot parse access token ${TOKEN}`, type: 'OAuthException', code: 190 } } });
    const res = await t.send({ ...templateSend(), kind: 'freeform', template: null, document: null, body: 'hello' });
    expect(res).toMatchObject({ status: 'failed', reasonCode: 'PROVIDER_AUTH' });
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });
});

describe('before and after the write', () => {
  async function listen(handler: RequestListener): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('a timeout after the request was written is AMBIGUOUS (the server got the request, nothing answered)', async () => {
    let received = 0;
    const baseUrl = await listen((req) => {
      req.resume();
      req.on('end', () => {
        received += 1;
      });
      // never answers
    });
    const t = createCloudApiTransport({ mode: 'live', graphVersion: 'v24.0', phoneNumberId: PHONE_ID, wabaId: WABA_ID, accessToken: TOKEN, clock, baseUrl, timeoutMs: 300 });
    const res = await t.send({ ...templateSend(), kind: 'freeform', template: null, document: null, body: 'hello' });
    expect(res).toMatchObject({ status: 'ambiguous', reasonCode: 'TIMEOUT_AFTER_WRITE' });
    expect(received).toBe(1);
  });

  it('a refused connection is PRE_SEND: definitely not sent', async () => {
    const baseUrl = await listen(() => undefined);
    const closed = servers.pop()!;
    await new Promise<void>((r) => closed.close(() => r()));
    const t = createCloudApiTransport({ mode: 'live', graphVersion: 'v24.0', phoneNumberId: PHONE_ID, wabaId: WABA_ID, accessToken: TOKEN, clock, baseUrl, timeoutMs: 1_000 });
    expect(await t.send({ ...templateSend(), kind: 'freeform', template: null, document: null, body: 'hello' })).toMatchObject({ status: 'failed', failureClass: 'PRE_SEND', reasonCode: 'CONNECT_FAILED' });
  });

  it('scripted socket errors: headers timeout and reset after write are AMBIGUOUS; DNS failure is PRE_SEND', async () => {
    const t = transport();
    graph.on('POST', /\/messages$/, { throw: networkError('UND_ERR_HEADERS_TIMEOUT') }, { throw: networkError('ECONNRESET') }, { throw: networkError('ENOTFOUND') });
    const free = { ...templateSend(), kind: 'freeform' as const, template: null, document: null, body: 'hello' };
    expect(await t.send(free)).toMatchObject({ status: 'ambiguous', reasonCode: 'TIMEOUT_AFTER_WRITE' });
    expect(await t.send(free)).toMatchObject({ status: 'ambiguous', reasonCode: 'TIMEOUT_AFTER_WRITE' });
    expect(await t.send(free)).toMatchObject({ status: 'failed', failureClass: 'PRE_SEND', reasonCode: 'CONNECT_FAILED' });
  });

  it('a failed media upload never makes the message ambiguous and never sends it', async () => {
    const t = transport();
    graph.on('POST', /\/media$/, { status: 503, body: { error: { message: 'unavailable', code: 2 } } }, { throw: networkError('UND_ERR_HEADERS_TIMEOUT') }, fixtureAnswer('error.190.json'));
    expect(await t.send(templateSend())).toMatchObject({ status: 'failed', failureClass: 'RETRYABLE', reasonCode: 'MEDIA_UPLOAD_UNAVAILABLE' });
    expect(await t.send(templateSend())).toMatchObject({ status: 'failed', failureClass: 'PRE_SEND', reasonCode: 'MEDIA_UPLOAD_FAILED' });
    expect(await t.send(templateSend())).toMatchObject({ status: 'failed', failureClass: 'PERMANENT', reasonCode: 'PROVIDER_AUTH' });
    expect(graph.requests.filter((r) => r.path.endsWith('/messages'))).toHaveLength(0);
  });

  it('a DEMO-mode client is stopped by the outbound tripwire before any socket (PRE_SEND, recorded blocked)', async () => {
    resetOutboundAttempts();
    const t = createCloudApiTransport({ mode: 'demo', graphVersion: 'v24.0', phoneNumberId: PHONE_ID, wabaId: WABA_ID, accessToken: TOKEN, clock });
    expect(await t.send({ ...templateSend(), kind: 'freeform', template: null, document: null, body: 'hello' })).toMatchObject({ status: 'failed', failureClass: 'PRE_SEND' });
    expect(outboundAttempts()).toEqual([expect.objectContaining({ host: 'graph.facebook.com', mode: 'demo', blocked: true })]);
  });
});

// ADR-123 (slice F4): the template admin port's Graph adapter against a scripted transport
// (documented-shape fixtures, tests/fixtures/whatsapp/template-admin; not live-verified).
// - create: POST /<version>/<WABA>/message_templates, JSON {name, language, category, components},
//   Bearer token in the header only; answer {id, status, category}; a 2xx without an id is a
//   failure that may have applied (UNCONFIRMED).
// - delete: DELETE /<version>/<WABA>/message_templates?name=<name>.
// - document header sample: POST /<version>/<APP_ID>/uploads?file_name&file_length&file_type, then
//   POST /<version>/upload:<session> with the bytes, file_offset 0 and the OAuth scheme; the
//   answer's `h` is the handle. Without an app ID nothing is sent.
// - Failure classes: before the write NOT_SENT; after the write, 5xx or no id AMBIGUOUS; the
//   "exists" subcode NAME_TAKEN; auth, permission, throttling and invalid templates refused.
// - The token is scrubbed from every provider text. The DEMO admin answers with zero network.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FixedClock } from '@/lib/clock';
import { outboundAttempts, resetOutboundAttempts } from '@/server/adapters/http/outbound';
import { classifyTemplateCreateFailure, createGraphTemplateAdmin, TEMPLATE_SUBMIT_FAILURE_LABELS } from '@/server/adapters/whatsapp/template-admin';
import { createDemoTemplateAdmin, DEMO_REJECTION_REASON, demoTemplateReview } from '@/server/adapters/whatsapp/template-admin-demo';
import { FakeGraph, networkError } from './whatsapp-support';

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/whatsapp/template-admin');
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
type Sources = { files: Record<string, { httpStatus?: number; verified: boolean; kind: string }> };
const sources = fixture('SOURCES.json') as Sources;
const answer = (name: string) => ({ status: sources.files[name]!.httpStatus!, body: fixture(name) });

const TOKEN = 'EAAGtemplateadmintoken0000000000000000000000abcd';
const WABA = '209876543210987';
const APP = '309876543210987';
const clock = new FixedClock('2026-10-23T06:00:00.000Z');

function admin(graph: FakeGraph, appId: string | null = APP) {
  return createGraphTemplateAdmin({ mode: 'live', graphVersion: 'v24.0', wabaId: WABA, appId, accessToken: TOKEN, clock, http: graph.http });
}

const REQUEST = { name: 'website_intro', language: 'en', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hello {{1}}, we build websites. Reply to know more.', example: { body_text: [['Ravi']] } }] };

describe('fixtures', () => {
  it('every fixture is registered as documented shape, never as verified traffic', () => {
    for (const [name, meta] of Object.entries(sources.files)) {
      expect(meta, name).toMatchObject({ kind: 'documented-shape, not recorded live traffic', verified: false });
      expect(() => fixture(name), name).not.toThrow();
    }
  });
});

describe('createTemplate', () => {
  it('POSTs the template to the WABA with the token in the header only', async () => {
    const graph = new FakeGraph().on('POST', new RegExp(`^/v24\\.0/${WABA}/message_templates$`), answer('response.template-create.json'));
    const res = await admin(graph).createTemplate(REQUEST);
    expect(res).toEqual({ ok: true, status: 200, data: { id: '594425479261596', status: 'PENDING', category: 'MARKETING' } });
    const [req] = graph.requests;
    expect(req).toMatchObject({ method: 'POST', path: `/v24.0/${WABA}/message_templates`, query: {}, body: REQUEST });
    expect(req!.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });
    expect(req!.url).not.toContain(TOKEN);
  });

  it('classifies failures: refused, ambiguous, name taken, not sent', async () => {
    const run = async (a: Parameters<FakeGraph['on']>[2]) => {
      const graph = new FakeGraph().on('POST', /message_templates$/, a);
      const res = await admin(graph).createTemplate(REQUEST);
      if (res.ok) throw new Error('expected a failure');
      return { res, failure: classifyTemplateCreateFailure(res) };
    };
    expect((await run(answer('error.template-invalid.json'))).failure).toMatchObject({ kind: 'refused', code: 'TEMPLATE_REJECTED_BY_PROVIDER' });
    expect((await run(answer('error.template-invalid.json'))).failure.message).toContain("Variables can't be at the start or end");
    expect((await run(answer('error.template-name-taken.json'))).failure).toMatchObject({ kind: 'name-taken', code: 'TEMPLATE_NAME_TAKEN' });
    expect((await run(answer('error.template-auth.json'))).failure).toMatchObject({ kind: 'refused', code: 'PROVIDER_AUTH' });
    expect((await run(answer('error.template-throttled.json'))).failure).toMatchObject({ kind: 'refused', code: 'PROVIDER_RATE_LIMITED' });
    expect((await run({ status: 403, body: { error: { message: 'Permissions error', code: 200 } } })).failure).toMatchObject({ kind: 'refused', code: 'PERMISSION_MISSING' });
    expect((await run({ status: 404, body: { error: { message: 'Unknown path', code: 803 } } })).failure).toMatchObject({ kind: 'refused', code: 'CONFIG_INVALID' });
    expect((await run({ status: 500, body: { error: { message: 'Unknown error', code: 1 } } })).failure).toMatchObject({ kind: 'ambiguous', code: 'PROVIDER_UNAVAILABLE' });
    expect((await run({ status: 200, body: { success: true } })).failure).toMatchObject({ kind: 'ambiguous', code: 'UNCONFIRMED' });
    expect((await run({ throw: networkError('UND_ERR_HEADERS_TIMEOUT') })).failure).toMatchObject({ kind: 'ambiguous', code: 'WRITE_TIMEOUT' });
    expect((await run({ throw: networkError('ECONNRESET') })).failure).toMatchObject({ kind: 'ambiguous', code: 'WRITE_TIMEOUT' });
    expect((await run({ throw: networkError('ECONNREFUSED') })).failure).toMatchObject({ kind: 'not-sent', code: 'PROVIDER_UNREACHABLE' });
    for (const code of ['PROVIDER_UNREACHABLE', 'PROVIDER_AUTH', 'PERMISSION_MISSING', 'PROVIDER_RATE_LIMITED', 'CONFIG_INVALID', 'TEMPLATE_REJECTED_BY_PROVIDER', 'APP_ID_MISSING']) {
      expect(TEMPLATE_SUBMIT_FAILURE_LABELS[code], code).toEqual(expect.any(String));
    }
  });

  it('scrubs the access token from provider texts', async () => {
    const graph = new FakeGraph().on('POST', /message_templates$/, { status: 400, body: { error: { message: `bad token ${TOKEN}`, code: 100, error_user_msg: `again ${TOKEN}` } } });
    const res = await admin(graph).createTemplate(REQUEST);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain(TOKEN);
    expect(JSON.stringify(res)).toContain('[REDACTED]');
  });
});

describe('deleteTemplate', () => {
  it('DELETEs by name on the WABA', async () => {
    const graph = new FakeGraph().on('DELETE', new RegExp(`^/v24\\.0/${WABA}/message_templates$`), answer('response.template-delete.json'));
    await expect(admin(graph).deleteTemplate('festive_launch')).resolves.toEqual({ ok: true, status: 200, data: { deleted: true } });
    expect(graph.requests[0]).toMatchObject({ method: 'DELETE', query: { name: 'festive_launch' } });
  });
});

describe('uploadHeaderDocument (resumable upload)', () => {
  const doc = { fileName: 'brochure.pdf', mimeType: 'application/pdf' as const, bytes: Buffer.from('%PDF-1.4 brochure') };

  it('opens a session on the app, uploads the bytes from offset 0 and answers the handle', async () => {
    const graph = new FakeGraph()
      .on('POST', new RegExp(`^/v24\\.0/${APP}/uploads$`), answer('response.upload-session.json'))
      .on('POST', /^\/v24\.0\/upload:/, answer('response.upload-handle.json'));
    const res = await admin(graph).uploadHeaderDocument(doc);
    expect(res).toEqual({ ok: true, status: 200, data: { handle: '4::YXBwbGljYXRpb24vcGRm:ARZbrochureSampleHandle0001' } });
    const [open, upload] = graph.requests;
    expect(open).toMatchObject({ method: 'POST', query: { file_name: 'brochure.pdf', file_length: String(doc.bytes.length), file_type: 'application/pdf' } });
    expect(open!.headers.authorization).toBe(`OAuth ${TOKEN}`);
    expect(upload).toMatchObject({ method: 'POST', path: '/v24.0/upload:MTphdHRhY2htZW50OjEyMzQ1Njc4OTAxMjM0NTY3ODk=' });
    expect(upload!.headers).toMatchObject({ authorization: `OAuth ${TOKEN}`, file_offset: '0', 'content-type': 'application/octet-stream' });
    expect(upload!.raw?.equals(doc.bytes)).toBe(true);
    for (const r of graph.requests) expect(r.url).not.toContain(TOKEN);
  });

  it('without an app ID nothing is sent (APP_ID_MISSING, before the write)', async () => {
    const graph = new FakeGraph();
    const res = await admin(graph, null).uploadHeaderDocument(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(classifyTemplateCreateFailure(res)).toMatchObject({ kind: 'not-sent', code: 'APP_ID_MISSING' });
    expect(graph.requests).toHaveLength(0);
    const empty = await admin(graph).uploadHeaderDocument({ ...doc, bytes: Buffer.alloc(0) });
    if (!empty.ok) expect(classifyTemplateCreateFailure(empty)).toMatchObject({ kind: 'not-sent', code: 'DOCUMENT_INVALID' });
  });
});

describe('DEMO admin', () => {
  it('accepts, reviews and hands out a sample handle with zero network', async () => {
    resetOutboundAttempts();
    const demo = createDemoTemplateAdmin();
    const created = await demo.createTemplate(REQUEST);
    expect(created).toMatchObject({ ok: true, data: { status: 'PENDING', category: 'MARKETING' } });
    expect(created.ok && created.data.id).toMatch(/^demo-tpl-[0-9a-f]{16}$/);
    expect(await demo.createTemplate(REQUEST)).toEqual(created);
    expect(demo.review({ name: 'website_intro' })).toEqual({ status: 'APPROVED', rejectedReason: null });
    expect(demoTemplateReview({ name: 'please_REJECT_me' })).toEqual({ status: 'REJECTED', rejectedReason: DEMO_REJECTION_REASON });
    const handle = await demo.uploadHeaderDocument({ fileName: 'b.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4') });
    expect(handle.ok && handle.data.handle).toMatch(/^demo-handle-[0-9a-f]{16}$/);
    expect(await demo.deleteTemplate('x')).toMatchObject({ ok: true });
    expect(outboundAttempts()).toHaveLength(0);
  });
});

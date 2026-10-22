/**
 * T36, plan §9 Extension (T8, C18), C14 caps, AT3, AT8, E2: POST /api/webhooks/gmaps-extension.
 *  - Bearer `alx_<keyId>_<secret>` only (cookies are never read); the prefix is looked up and the
 *    secret's sha256 compared in constant time; scope `ingest:gmaps`; one workspace.
 *  - AT8: a revoked token is 401 `token_revoked` on the very next request (no cache), with a
 *    WebhookRejection counter and a `extension.token.denied` audit that carries no secret.
 *  - An http(s) or `null` Origin is 403; CORS is answered only for
 *    `chrome-extension://<allowedExtensionId>` of a live token (preflight and response headers).
 *  - Caps: 201 records is 413, a body over 1 MiB is 413; an all-invalid batch is 422.
 *  - Per-record results: a malformed record is rejected on its own (INVALID_RECORD) and the
 *    ingestion results (ACCEPTED, NO_VALID_CONTACT, ...) come back on replay; the batch is PARTIAL.
 *  - Replay (same bytes) returns the stored per-record results and writes nothing; the same batch
 *    id with a different body is 409 BATCH_CONTENT_MISMATCH; identical batch ids in two workspaces
 *    are distinct (E2).
 *  - Maps leads: no WhatsApp consent, no invented email, E.164 phones, the token on the batch.
 *  - Rate limit `extension` (60 batches per minute per key); LIVE accepts a LIVE workspace's token
 *    and refuses a DEMO workspace's token.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RATE_LIMIT_POLICIES } from '@/server/security/rate-limit';
import { generateExtensionToken } from '@/server/security/tokens';
import { revokeExtensionToken } from '@/server/services/extension/tokens';
import { useRuntime } from '../auth/support';
import { sessionFor } from './support';
import {
  batchBody,
  createExtensionHarness,
  EXTENSION_ID,
  issueToken,
  managerCtx,
  mapsPhoneE164,
  mapsRecord,
  OTHER_EXTENSION_ID,
  postBatch,
  preflight,
  recordsOf,
  WS_A,
  WS_KESARI,
  WS_KESARI_SLUG,
  type ExtensionHarness,
} from './extension-support';

let h: ExtensionHarness;
beforeAll(async () => {
  h = await createExtensionHarness('extension-ingest');
}, 120_000);
afterAll(async () => h?.destroy());

const secretOf = (t: { token: string; prefix: string }) => t.token.slice(t.prefix.length + 1);
const eventsFor = (batchId: string) => h.db.webhookEvent.count({ where: { provider: 'GMAPS_EXTENSION', externalKey: batchId } });
const rejection = (reason: string, workspaceId: string | null = null) => h.db.webhookRejection.findFirst({ where: { provider: 'GMAPS_EXTENSION', reason, workspaceId } });

describe('authentication (Bearer alx_ only)', () => {
  it('accepts a valid token: 202, one WebhookEvent scoped by the workspace, one ingest job, lastUsedAt set', async () => {
    const token = await issueToken(h);
    const batchId = 'auth-ok-1';
    const { res, body } = await postBatch(batchBody(batchId, [mapsRecord()]), { token: token.token });
    expect(res.status).toBe(202);
    expect(body).toMatchObject({ batchId, outcome: 'ACCEPTED', status: 'RECEIVED', received: 1, queued: 1, rejected: 0 });
    const event = await h.db.webhookEvent.findFirstOrThrow({ where: { provider: 'GMAPS_EXTENSION', externalKey: batchId } });
    expect(event).toMatchObject({ workspaceId: WS_A, scopeKey: WS_A, integrationId: null, status: 'RECEIVED', simulated: false });
    expect(await h.db.job.count({ where: { type: 'ingest.process', workspaceId: WS_A } })).toBeGreaterThanOrEqual(1);
    const row = await h.db.extensionToken.findUniqueOrThrow({ where: { id: token.id } });
    expect(row.lastUsedAt?.toISOString()).toBe(h.clock.now().toISOString());
    // Only the secret's sha256 is stored, never the token or the secret.
    expect(JSON.stringify(row)).not.toContain(secretOf(token));
    // The inspector view carries no contact data.
    expect(JSON.stringify(event.payloadRedacted)).not.toContain('074281');
  });

  it('AT8: revocation is effective on the next request (401 token_revoked), audited without the secret', async () => {
    const token = await issueToken(h);
    expect((await postBatch(batchBody('revoke-before', [mapsRecord()]), { token: token.token })).res.status).toBe(202);

    await revokeExtensionToken(await managerCtx(h), { tokenId: token.id });

    const { res, body } = await postBatch(batchBody('revoke-after', [mapsRecord()]), { token: token.token });
    expect(res.status).toBe(401);
    expect(body.code).toBe('token_revoked');
    expect(typeof body.reference).toBe('string');
    expect(await eventsFor('revoke-after')).toBe(0);
    expect((await rejection('TOKEN_REVOKED', WS_A))?.count).toBeGreaterThanOrEqual(1);
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'extension.token.denied', targetId: token.id }, orderBy: { createdAt: 'desc' } });
    expect(audit).toMatchObject({ workspaceId: WS_A, result: 'DENIED', actorKind: 'WEBHOOK' });
    expect(audit.summary).toMatchObject({ reason: 'REVOKED', prefix: token.prefix });
    expect(JSON.stringify(audit)).not.toContain(secretOf(token));
  });

  it('a wrong secret for a real prefix, an unknown prefix, a malformed token and no header are 401', async () => {
    const token = await issueToken(h);
    const wrongSecret = `${token.prefix}_${'A'.repeat(43)}`;
    const cases: Array<[string | null, string]> = [
      [wrongSecret, 'token_invalid'],
      [`alx_${'0'.repeat(16)}_${'B'.repeat(43)}`, 'token_invalid'],
      ['alx_not-a-token', 'token_invalid'],
      [null, 'token_missing'],
    ];
    for (const [presented, code] of cases) {
      const { res, body } = await postBatch(batchBody('auth-bad', [mapsRecord()]), { token: presented });
      expect(res.status).toBe(401);
      expect(body.code).toBe(code);
    }
    expect(await eventsFor('auth-bad')).toBe(0);
    const denied = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'extension.token.denied', targetId: token.id } });
    expect(denied.summary).toMatchObject({ reason: 'SECRET_MISMATCH' });
  });

  it('an expired token is 401 token_expired', async () => {
    const token = await issueToken(h, { expiresInDays: 30 });
    h.clock.advance(31 * 86_400_000);
    try {
      const { res, body } = await postBatch(batchBody('expired-1', [mapsRecord()]), { token: token.token });
      expect(res.status).toBe(401);
      expect(body.code).toBe('token_expired');
    } finally {
      h.clock.advance(-31 * 86_400_000);
    }
  });

  it('a token without the ingest:gmaps scope is 403 token_scope_missing', async () => {
    const token = await issueToken(h);
    await h.db.extensionToken.update({ where: { id: token.id }, data: { scopes: ['read:nothing'] } });
    const { res, body } = await postBatch(batchBody('scope-1', [mapsRecord()]), { token: token.token });
    expect(res.status).toBe(403);
    expect(body.code).toBe('token_scope_missing');
  });

  it('never reads cookies: a valid session cookie without a bearer token is 401', async () => {
    const auth = await sessionFor(h, 'employee');
    const { res } = await postBatch(batchBody('cookie-1', [mapsRecord()]), { headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf } });
    expect(res.status).toBe(401);
    expect(await eventsFor('cookie-1')).toBe(0);
  });
});

describe('Origin and CORS (C18)', () => {
  it('an http(s) or null Origin is 403 before anything is stored', async () => {
    const token = await issueToken(h, { allowedExtensionId: EXTENSION_ID });
    for (const origin of ['https://evil.example', 'http://localhost:3000', 'null']) {
      const { res, body } = await postBatch(batchBody('web-origin', [mapsRecord()]), { token: token.token, origin });
      expect(res.status).toBe(403);
      expect(['web_origin_forbidden', 'origin_forbidden']).toContain(body.code);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(await eventsFor('web-origin')).toBe(0);
    expect((await rejection('WEB_ORIGIN'))?.count).toBeGreaterThanOrEqual(2);
  });

  it('answers the preflight only for the allowed extension id of a live token', async () => {
    await issueToken(h, { allowedExtensionId: EXTENSION_ID });
    const ok = await preflight(`chrome-extension://${EXTENSION_ID}`);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(`chrome-extension://${EXTENSION_ID}`);
    expect(ok.headers.get('access-control-allow-methods')).toContain('POST');
    expect(ok.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
    expect(ok.headers.get('vary')).toContain('Origin');
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull();

    for (const origin of [`chrome-extension://${OTHER_EXTENSION_ID}`, 'https://evil.example', null]) {
      const refused = await preflight(origin);
      expect(refused.status).toBe(403);
      expect(refused.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('a revoked token no longer opens CORS for its extension id', async () => {
    const id = 'aaaabbbbccccddddaaaabbbbccccdddd';
    const token = await issueToken(h, { allowedExtensionId: id });
    expect((await preflight(`chrome-extension://${id}`)).status).toBe(204);
    await revokeExtensionToken(await managerCtx(h), { tokenId: token.id });
    expect((await preflight(`chrome-extension://${id}`)).status).toBe(403);
  });

  it('POST from the allowed extension carries the CORS header; another extension id is 403; no Origin needs no CORS', async () => {
    const token = await issueToken(h, { allowedExtensionId: EXTENSION_ID });
    const allowed = await postBatch(batchBody('cors-ok', [mapsRecord()]), { token: token.token, origin: `chrome-extension://${EXTENSION_ID}` });
    expect(allowed.res.status).toBe(202);
    expect(allowed.res.headers.get('access-control-allow-origin')).toBe(`chrome-extension://${EXTENSION_ID}`);

    const other = await postBatch(batchBody('cors-other', [mapsRecord()]), { token: token.token, origin: `chrome-extension://${OTHER_EXTENSION_ID}` });
    expect(other.res.status).toBe(403);
    expect(other.body.code).toBe('extension_not_allowed');
    expect(other.res.headers.get('access-control-allow-origin')).toBeNull();
    expect(await eventsFor('cors-other')).toBe(0);

    const server = await postBatch(batchBody('cors-none', [mapsRecord()]), { token: token.token });
    expect(server.res.status).toBe(202);
    expect(server.res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('a token without an allowed extension id accepts any extension origin but answers no CORS', async () => {
    const token = await issueToken(h);
    const { res } = await postBatch(batchBody('cors-unset', [mapsRecord()]), { token: token.token, origin: `chrome-extension://${OTHER_EXTENSION_ID}` });
    expect(res.status).toBe(202);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('caps (C14)', () => {
  it('201 records is 413 TOO_MANY_RECORDS; 200 records is accepted', async () => {
    const token = await issueToken(h);
    const many = Array.from({ length: 201 }, (_, i) => ({ recordId: `cap-${i}`, name: `Cap ${i}`, phone: mapsPhoneE164(90_000 + i) }));
    const over = await postBatch(batchBody('cap-201', many), { token: token.token });
    expect(over.res.status).toBe(413);
    expect(over.body.code).toBe('TOO_MANY_RECORDS');
    expect(await eventsFor('cap-201')).toBe(0);

    const fine = await postBatch(batchBody('cap-200', many.slice(0, 200)), { token: token.token });
    expect(fine.res.status).toBe(202);
    expect(fine.body).toMatchObject({ received: 200, queued: 200 });
  });

  it('a body over 1 MiB is 413', async () => {
    const token = await issueToken(h);
    const big = batchBody('cap-bytes', [mapsRecord({ address: 'x'.repeat(1000) })], { padding: 'p'.repeat(1_048_576) });
    const { res } = await postBatch(big, { token: token.token });
    expect(res.status).toBe(413);
    expect(await eventsFor('cap-bytes')).toBe(0);
  });

  it('a body that is not a v1 batch is 400; a batch id outside [A-Za-z0-9._:-]{1,128} is 400', async () => {
    const token = await issueToken(h);
    expect((await postBatch('{"version":1', { token: token.token })).body.code).toBe('INVALID_JSON');
    expect((await postBatch(JSON.stringify({ version: 2, batchId: 'v2', records: [mapsRecord()] }), { token: token.token })).res.status).toBe(400);
    expect((await postBatch(JSON.stringify({ version: 1, batchId: 'bad id/<x>', records: [mapsRecord()] }), { token: token.token })).res.status).toBe(400);
    expect((await postBatch(JSON.stringify({ version: 1, batchId: 'empty', records: [] }), { token: token.token })).res.status).toBe(400);
  });
});

describe('per-record results, replay and conflicts', () => {
  it('partial failure: a malformed record is rejected alone, the rest is ingested; the replay returns the stored per-record results', async () => {
    const token = await issueToken(h);
    const good = mapsRecord();
    const noContact = mapsRecord({ phone: null, website: null });
    const malformed = { recordId: 'malformed-1', name: { not: 'a string' }, phone: 42 };
    const raw = batchBody('partial-1', [good, noContact, malformed]);

    const first = await postBatch(raw, { token: token.token });
    expect(first.res.status).toBe(202);
    expect(first.body).toMatchObject({ received: 3, queued: 2, rejected: 1 });
    expect(recordsOf(first.body)).toEqual([
      { index: 0, recordId: good.recordId, status: 'QUEUED', reasonCode: null },
      { index: 1, recordId: noContact.recordId, status: 'QUEUED', reasonCode: null },
      { index: 2, recordId: 'malformed-1', status: 'REJECTED', reasonCode: 'INVALID_RECORD', fields: ['name', 'phone'] },
    ]);

    // Before processing a replay still answers with the intake view (no second event or job).
    const early = await postBatch(raw, { token: token.token });
    expect(early.res.status).toBe(200);
    expect(early.body).toMatchObject({ outcome: 'DUPLICATE', status: 'RECEIVED' });

    await h.drain();
    const leadsBefore = await h.db.lead.count();
    const jobsBefore = await h.db.job.count();
    const replay = await postBatch(raw, { token: token.token });
    expect(replay.res.status).toBe(200);
    expect(replay.body).toMatchObject({ outcome: 'DUPLICATE', status: 'PROCESSED', batchStatus: 'PARTIAL', counts: { received: 3, accepted: 1, duplicate: 0, review: 0, rejected: 2 } });
    expect(recordsOf(replay.body)).toEqual([
      { index: 0, recordId: good.recordId, status: 'ACCEPTED', reasonCode: null },
      { index: 1, recordId: noContact.recordId, status: 'REJECTED', reasonCode: 'NO_VALID_CONTACT' },
      { index: 2, recordId: 'malformed-1', status: 'REJECTED', reasonCode: 'INVALID_RECORD', fields: ['name', 'phone'] },
    ]);
    expect(await h.db.lead.count()).toBe(leadsBefore);
    expect(await h.db.job.count()).toBe(jobsBefore);
    expect(await eventsFor('partial-1')).toBe(1);

    // The batch knows which token sent it; the stored result lists every record.
    const batch = await h.db.importBatch.findFirstOrThrow({ where: { workspaceId: WS_A, source: 'GMAPS_EXTENSION', externalBatchId: 'partial-1' } });
    expect(batch.extensionTokenId).toBe(token.id);
    const event = await h.db.webhookEvent.findFirstOrThrow({ where: { externalKey: 'partial-1' } });
    expect((event.result as { records: unknown[] }).records).toHaveLength(3);
  });

  it('Maps leads: no WhatsApp consent, no invented email, E.164 phone, source GMAPS_EXTENSION', async () => {
    const token = await issueToken(h);
    const record = mapsRecord();
    await postBatch(batchBody('maps-fields', [record]), { token: token.token });
    await h.drain();
    const source = await h.db.leadSourceRecord.findFirstOrThrow({ where: { workspaceId: WS_A, source: 'GMAPS_EXTENSION', externalId: String(record.recordId) } });
    const lead = await h.db.lead.findUniqueOrThrow({ where: { id: source.leadId! } });
    expect(lead).toMatchObject({ firstSource: 'GMAPS_EXTENSION', emailNormalized: null, simulated: false, city: 'Gurugram', displayName: record.name });
    expect(lead.phoneE164).toMatch(/^\+917428\d{6}$/);
    expect(await h.db.consentRecord.count({ where: { leadId: lead.id } })).toBe(0);
    expect(source.attribution).toEqual({ keyword: 'dental clinic in Gurugram' });
  });

  it('the same batch id with a different body is 409 BATCH_CONTENT_MISMATCH and writes nothing', async () => {
    const token = await issueToken(h);
    const record = mapsRecord();
    expect((await postBatch(batchBody('conflict-1', [record]), { token: token.token })).res.status).toBe(202);
    const changed = await postBatch(batchBody('conflict-1', [{ ...record, name: 'Renamed Business' }]), { token: token.token });
    expect(changed.res.status).toBe(409);
    expect(changed.body.code).toBe('BATCH_CONTENT_MISMATCH');
    expect(await eventsFor('conflict-1')).toBe(1);
  });

  it('a batch whose every record is malformed is 422 NO_VALID_RECORDS with the per-record reasons, nothing stored', async () => {
    const token = await issueToken(h);
    const { res, body } = await postBatch(batchBody('all-bad', [{ name: 'No id' }, { recordId: 'x', rating: { bad: true } }]), { token: token.token });
    expect(res.status).toBe(422);
    expect(body.code).toBe('NO_VALID_RECORDS');
    expect((body.details as { records: unknown[] }).records).toEqual([
      { index: 0, recordId: null, status: 'REJECTED', reasonCode: 'INVALID_RECORD', fields: ['recordId'] },
      { index: 1, recordId: 'x', status: 'REJECTED', reasonCode: 'INVALID_RECORD', fields: ['rating'] },
    ]);
    expect(await eventsFor('all-bad')).toBe(0);
  });

  it('E2: the same batch id from two workspaces is two distinct batches', async () => {
    const a = await issueToken(h);
    const k = await issueToken(h, { workspaceSlug: WS_KESARI_SLUG });
    const shared = 'shared-batch-1';
    expect((await postBatch(batchBody(shared, [mapsRecord()]), { token: a.token })).res.status).toBe(202);
    expect((await postBatch(batchBody(shared, [mapsRecord()]), { token: k.token })).res.status).toBe(202);
    const events = await h.db.webhookEvent.findMany({ where: { provider: 'GMAPS_EXTENSION', externalKey: shared }, orderBy: { scopeKey: 'asc' } });
    expect(events.map((e) => e.workspaceId).sort()).toEqual([WS_A, WS_KESARI].sort());
  });
});

describe('rate limit (60 batches per minute per key)', () => {
  it('the 61st batch within a minute is 429 with Retry-After; another key is unaffected', async () => {
    const token = await issueToken(h);
    const limiter = h.runtime.limiters.extension;
    for (let i = 0; i < RATE_LIMIT_POLICIES.extension.limit; i += 1) expect(limiter.take(`extension:${token.id}`).allowed).toBe(true);
    const { res, body } = await postBatch(batchBody('rate-1', [mapsRecord()]), { token: token.token });
    expect(res.status).toBe(429);
    expect(body.code).toBe('RATE_LIMITED');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await eventsFor('rate-1')).toBe(0);

    const other = await issueToken(h);
    expect((await postBatch(batchBody('rate-2', [mapsRecord()]), { token: other.token })).res.status).toBe(202);
  });
});

describe('LIVE process', () => {
  let live: ExtensionHarness;
  beforeAll(async () => {
    live = await createExtensionHarness('extension-ingest-live', { mode: 'live' });
  }, 120_000);
  afterAll(async () => {
    await live?.destroy();
    // The DEMO harness's runtime is reinstalled for any later test in this file.
    h.runtime = useRuntime(h.db, h.config, h.clock);
  });

  it("accepts a LIVE workspace's token and the worker creates a real (not simulated) lead", async () => {
    const token = await issueToken(live);
    const record = mapsRecord();
    const { res } = await postBatch(batchBody('live-1', [record]), { token: token.token });
    expect(res.status).toBe(202);
    await live.drain();
    const source = await live.db.leadSourceRecord.findFirstOrThrow({ where: { externalId: String(record.recordId) } });
    expect(source.status).toBe('ACCEPTED');
    const lead = await live.db.lead.findUniqueOrThrow({ where: { id: source.leadId! } });
    expect(lead).toMatchObject({ workspaceId: live.live!.workspaceId, simulated: false, emailNormalized: null });
  });

  it("refuses a DEMO workspace's token in a LIVE process (401)", async () => {
    const ws = await live.db.workspace.create({ data: { slug: 'demo-stray', name: 'Demo Stray', mode: 'DEMO', planLabel: 'Demo' } });
    const generated = generateExtensionToken();
    await live.db.extensionToken.create({ data: { workspaceId: ws.id, name: 'stray', prefix: generated.prefix, secretHash: generated.secretHash, scopes: ['ingest:gmaps'], createdBy: live.live!.ownerId } });
    const { res, body } = await postBatch(batchBody('live-demo-token', [mapsRecord()]), { token: generated.token });
    expect(res.status).toBe(401);
    expect(body.code).toBe('token_invalid');
    expect(await live.db.webhookEvent.count({ where: { externalKey: 'live-demo-token' } })).toBe(0);
  });
});

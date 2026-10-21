/**
 * T34 (plan §9 Webhooks, R8, AT3, E2): POST /api/webhooks/google-sheets.
 *  - a correctly signed push is routed by its key id (never by a URL or a sheet id), persisted with
 *    an encrypted processing payload scoped by the integration, and ingested by the worker;
 *  - a replayed event id answers the stored per-record result (200) and creates nothing;
 *  - 10 minutes of skew either way is 401 REPLAY_WINDOW; a bad signature, an unknown key id or
 *    missing headers is 401; each rejection increments a WebhookRejection counter and stores nothing;
 *  - 256 KB and 50 rows caps (413); header drift and a superseded mapping are 409;
 *  - the same event id in workspaces A and B are two events (E2);
 *  - a row without an event id gets a flagged weak id;
 *  - the request the generated Apps Script makes is accepted by the real route;
 *  - the `appsScript` limit (120/min/integration) counts authenticated deliveries only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateAppsScript } from '@/server/services/sheets/apps-script';
import { SHEETS_SIGNATURE_HEADERS, signSheetsPush } from '@/server/services/sheets/signature';
import { AppsScriptEnv, FakeSheet } from '../../unit/sheets/apps-script-env';
import { createSheetsHarness, formRow, HEADER, postPush, postRaw, pushBody, setUpWorkspace, SHEET_ID, type SheetsHarness } from '../sheets/support';

let h: SheetsHarness;
let A: Awaited<ReturnType<typeof setUpWorkspace>>;
let B: Awaited<ReturnType<typeof setUpWorkspace>>;

beforeAll(async () => {
  h = await createSheetsHarness('t34-sheets-signature');
  A = await setUpWorkspace(h, h.wsA);
  B = await setUpWorkspace(h, h.wsB);
}, 120_000);
afterAll(async () => h?.destroy());

const rejections = async (reason: string) => (await h.db.webhookRejection.findMany({ where: { provider: 'GOOGLE_SHEETS', reason } })).reduce((n, r) => n + r.count, 0);
const events = (externalKey: string) => h.db.webhookEvent.count({ where: { provider: 'GOOGLE_SHEETS', externalKey } });

describe('valid push and replay', () => {
  it('accepts a signed push, persists it scoped by the integration, and the worker creates the lead', async () => {
    const row = formRow({ name: 'Asha Verma' });
    const body = pushBody([row]);
    const res = await postPush(h, A, body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'ACCEPTED', eventId: body.eventId, rows: 1, weakIdRows: 0, status: 'RECEIVED' });
    const event = await h.db.webhookEvent.findFirstOrThrow({ where: { provider: 'GOOGLE_SHEETS', externalKey: body.eventId } });
    expect(event).toMatchObject({ workspaceId: h.wsA.id, integrationId: A.integrationId, scopeKey: A.integrationId, status: 'RECEIVED', simulated: false });
    expect(event.processingPayload).not.toBeNull();
    expect(JSON.stringify(event.payloadRedacted)).not.toContain(String(row.values['Phone number']));
    await h.drain();
    const lead = await h.db.lead.findFirstOrThrow({ where: { workspaceId: h.wsA.id, displayName: 'Asha Verma' } });
    expect(lead.firstSource).toBe('GOOGLE_SHEETS');

    // Apps Script retries the same delivery (re-signed, same event id): the stored result, nothing new.
    const again = await postPush(h, A, body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ outcome: 'DUPLICATE', eventId: body.eventId, status: 'PROCESSED' });
    expect((again.body.result as { records: Array<{ leadId: string; status: string }> }).records).toEqual([expect.objectContaining({ externalId: row.rowKey, status: 'ACCEPTED', leadId: lead.id })]);
    await h.drain();
    expect(await h.db.lead.count({ where: { workspaceId: h.wsA.id, displayName: 'Asha Verma' } })).toBe(1);
    expect(await events(body.eventId)).toBe(1);
  });

  it('the same event id with a different body is 409 and stores nothing new', async () => {
    const body = pushBody([formRow()]);
    expect((await postPush(h, A, body)).status).toBe(200);
    const changed = { ...body, rows: [formRow()] };
    const res = await postPush(h, A, changed);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BATCH_CONTENT_MISMATCH');
    expect(await events(body.eventId)).toBe(1);
  });
});

describe('rejections (401, nothing persisted, counted)', () => {
  it('10 minutes of skew either way is 401 REPLAY_WINDOW', async () => {
    const now = Math.floor(h.clock.now().getTime() / 1000);
    for (const ts of [now - 600, now + 600, now - 301]) {
      const body = pushBody([formRow()]);
      const before = await rejections('REPLAY_WINDOW');
      const res = await postPush(h, A, body, { timestamp: ts });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('REPLAY_WINDOW');
      expect(await events(body.eventId)).toBe(0);
      expect(await rejections('REPLAY_WINDOW')).toBe(before + 1);
    }
    // 299 s is still inside the window.
    expect((await postPush(h, A, pushBody([formRow()]), { timestamp: now - 299 })).status).toBe(200);
  });

  it('a replayed event outside the window is refused too (the window applies before the stored result)', async () => {
    const body = pushBody([formRow()]);
    expect((await postPush(h, A, body)).status).toBe(200);
    const res = await postPush(h, A, body, { timestamp: Math.floor(h.clock.now().getTime() / 1000) - 600 });
    expect(res.status).toBe(401);
  });

  it('a bad signature, a flipped body byte, an unknown key id or missing headers is 401', async () => {
    const body = pushBody([formRow()]);
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(h.clock.now().getTime() / 1000));
    const good = signSheetsPush(A.secret, ts, body.eventId, Buffer.from(raw));
    const base = { [SHEETS_SIGNATURE_HEADERS.keyId]: A.keyId, [SHEETS_SIGNATURE_HEADERS.timestamp]: ts, [SHEETS_SIGNATURE_HEADERS.eventId]: body.eventId, [SHEETS_SIGNATURE_HEADERS.signature]: good };

    const flipped = await postRaw(raw.replace('Consultation', 'Consultatioo'), base);
    expect(flipped.status).toBe(401);
    expect(flipped.body.code).toBe('SIGNATURE_INVALID');
    const otherSecret = await postRaw(raw, { ...base, [SHEETS_SIGNATURE_HEADERS.signature]: signSheetsPush(B.secret, ts, body.eventId, Buffer.from(raw)) });
    expect(otherSecret.status).toBe(401);
    const otherEvent = await postRaw(raw, { ...base, [SHEETS_SIGNATURE_HEADERS.eventId]: 'evt-other' });
    expect(otherEvent.status).toBe(401);
    const unknown = await postRaw(raw, { ...base, [SHEETS_SIGNATURE_HEADERS.keyId]: 'as_unknownKeyId0000' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe('KEY_UNKNOWN');
    const bare = await postRaw(raw, {});
    expect(bare.status).toBe(401);
    expect(bare.body.code).toBe('SIGNATURE_MISSING');

    expect(await events(body.eventId)).toBe(0);
    expect(await rejections('SIGNATURE_INVALID')).toBeGreaterThanOrEqual(3);
    const unknownRow = await h.db.webhookRejection.findFirstOrThrow({ where: { provider: 'GOOGLE_SHEETS', reason: 'KEY_UNKNOWN' } });
    expect(unknownRow.workspaceId).toBeNull();
    const invalidRow = await h.db.webhookRejection.findFirstOrThrow({ where: { provider: 'GOOGLE_SHEETS', reason: 'SIGNATURE_INVALID', workspaceId: h.wsA.id } });
    expect(invalidRow.count).toBeGreaterThanOrEqual(2);
    expect(await rejections('SIGNATURE_MISSING')).toBeGreaterThanOrEqual(1);
  });
});

describe('caps', () => {
  it('a body over 256 KB is 413 before anything is read further', async () => {
    const big = Buffer.alloc(262_145, 0x20);
    const res = await postRaw(big, { [SHEETS_SIGNATURE_HEADERS.keyId]: A.keyId });
    expect(res.status).toBe(413);
  });

  it('51 rows is 413 TOO_MANY_ROWS; 50 rows is accepted', async () => {
    const tooMany = pushBody(Array.from({ length: 51 }, () => formRow()));
    const res = await postPush(h, A, tooMany);
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('TOO_MANY_ROWS');
    expect(await events(tooMany.eventId)).toBe(0);
    expect(await rejections('TOO_MANY_ROWS')).toBe(1);
    const fifty = pushBody(Array.from({ length: 50 }, () => formRow()));
    expect((await postPush(h, A, fifty)).status).toBe(200);
  });
});

describe('mapping checks', () => {
  it('a header that drifted from the mapping is 409 HEADER_DRIFT with the column diff; nothing stored', async () => {
    const body = pushBody([formRow()], { header: HEADER.map((c) => (c === 'Phone number' ? 'Mobile' : c)) });
    const res = await postPush(h, A, body);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'HEADER_DRIFT', details: { added: ['Mobile'], removed: ['Phone number'] } });
    expect(await events(body.eventId)).toBe(0);
  });

  it('a script made for an older mapping version is 409 MAPPING_SUPERSEDED; a script for another sheet is 422', async () => {
    const stale = pushBody([formRow()], { mappingVersion: 7 });
    expect((await postPush(h, A, stale)).body.code).toBe('MAPPING_SUPERSEDED');
    const other = await postPush(h, A, pushBody([formRow()], { sheetId: 'another-sheet-id-000000000' }));
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('SHEET_MISMATCH');
  });
});

describe('scoping and weak ids', () => {
  it('the same event id and row ids in workspaces A and B are distinct events and distinct leads (E2)', async () => {
    const shared = 'evt-shared-across-tenants';
    const rowA = formRow({ rowKey: 'shared-row-1', name: 'Tenant A Person' });
    const rowB = { ...formRow({ rowKey: 'shared-row-1', name: 'Tenant B Person' }) };
    const a = await postPush(h, A, pushBody([rowA], { eventId: shared }));
    const b = await postPush(h, B, pushBody([rowB], { eventId: shared }));
    expect([a.status, a.body.outcome, b.status, b.body.outcome]).toEqual([200, 'ACCEPTED', 200, 'ACCEPTED']);
    const stored = await h.db.webhookEvent.findMany({ where: { externalKey: shared }, select: { workspaceId: true, scopeKey: true } });
    expect(stored.map((e) => e.scopeKey).sort()).toEqual([A.integrationId, B.integrationId].sort());
    await h.drain();
    expect(await h.db.lead.count({ where: { workspaceId: h.wsA.id, displayName: 'Tenant A Person' } })).toBe(1);
    expect(await h.db.lead.count({ where: { workspaceId: h.wsB.id, displayName: 'Tenant B Person' } })).toBe(1);
  });

  it('a row without auralead_event_id gets a weak content-hash id, flagged on its source record', async () => {
    const row = formRow({ rowKey: null, name: 'No Id Person' });
    const res = await postPush(h, A, pushBody([row]));
    expect(res.body).toMatchObject({ outcome: 'ACCEPTED', weakIdRows: 1 });
    await h.drain();
    const lead = await h.db.lead.findFirstOrThrow({ where: { workspaceId: h.wsA.id, displayName: 'No Id Person' } });
    const record = await h.db.leadSourceRecord.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(record.externalId).toMatch(/^weak:[0-9a-f]{40}$/);
    expect(record.attribution).toMatchObject({ sheet: SHEET_ID, weakId: 'content-hash' });
  });
});

describe('the generated Apps Script against the real route', () => {
  it('the request the script signs is accepted and its row becomes a lead', async () => {
    const sheet = new FakeSheet('Form Responses 1', [HEADER, [new Date('2026-10-20T05:30:00.000Z'), 'Script Person', '9812300001', 'script@example.test', 'Consultation', 'Yes']]);
    const env = new AppsScriptEnv(SHEET_ID, sheet, h.clock.now().getTime()).load(
      generateAppsScript({ endpoint: 'http://localhost:3000/api/webhooks/google-sheets', keyId: A.keyId, sheetId: SHEET_ID, sheetName: 'Form Responses 1', mappingVersion: A.mappingVersion, columns: HEADER, submittedAtColumn: 'Timestamp', generatedAt: h.clock.now() }),
    );
    env.promptAnswer = { button: 'OK', text: A.secret };
    env.call('auraleadSetSecret');
    env.call('auraleadSetup');
    sheet.rows.push([new Date('2026-10-20T05:40:00.000Z'), 'Script Person Two', '9812300002', 'script2@example.test', 'Price list', 'Yes']);
    env.call('auraleadOnFormSubmit', env.formSubmitEvent(3));
    expect(env.fetches).toHaveLength(1);
    const { params } = env.fetches[0]!;
    const res = await postRaw(params.payload, params.headers);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('ACCEPTED');
    await h.drain();
    const lead = await h.db.lead.findFirstOrThrow({ where: { workspaceId: h.wsA.id, displayName: 'Script Person Two' } });
    const col = sheet.rows[0]!.indexOf('auralead_event_id');
    const record = await h.db.leadSourceRecord.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(record.externalId).toBe(String(sheet.rows[2]![col]));
  });
});

describe('rate limit', () => {
  it('counts authenticated deliveries per integration: the 121st within a minute is 429; workspace B is unaffected', async () => {
    const body = pushBody([formRow()]);
    let limited = 0;
    let ok = 0;
    for (let i = 0; i < 125; i += 1) {
      const res = await postPush(h, A, body);
      if (res.status === 429) limited += 1;
      else if (res.status === 200) ok += 1;
    }
    expect(limited).toBeGreaterThan(0);
    expect(ok).toBeLessThanOrEqual(120);
    expect((await postPush(h, B, pushBody([formRow()]))).status).toBe(200);
    // Forged deliveries are refused before the limiter, so they never use A's budget.
    const forged = await postPush(h, A, pushBody([formRow()]), { signature: `v1=${'0'.repeat(64)}` });
    expect(forged.status).toBe(401);
  });
});

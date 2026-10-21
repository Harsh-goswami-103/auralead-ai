/**
 * T34 (plan §11 T34, §9 Webhooks, R8, PRD "Generate copyable Apps Script (setup, mapping, event IDs,
 * auth, retry guidance)"): the generated Apps Script, run in node's vm against a stand-in of the
 * Apps Script runtime (apps-script-env.ts).
 *  - endpoint, key id, sheet id, mapping version and the mapped columns are embedded as literals
 *    (hostile column names cannot break out of them); the secret is never in the text;
 *  - event ids: setup adds the hidden, warning-protected `auralead_event_id` column, gives rows an
 *    id once and keeps existing ones; a form submit writes the row's id once and every later send
 *    of that row reuses it (an edit or a second trigger never makes a new id);
 *  - signature: `v1=` + hex HMAC-SHA256 of `timestamp + "." + eventId + "." + body` with the secret
 *    from Script Properties, which the server's own verifier accepts; the body is pure ASCII, so
 *    no charset can change the signed bytes;
 *  - retries: 5xx, 429 and network errors back off exponentially within the run (same event id,
 *    re-signed); other 4xx are not retried; unsent rows wait in Script Properties (401 and mapping
 *    409s keep them; 400/413/422 drop them); a flush sends at most 50 rows per push;
 *  - the secret is never written to a cell.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateAppsScript, type AppsScriptInput } from '@/server/services/sheets/apps-script';
import { SHEETS_SIGNATURE_HEADERS, verifySheetsSignature } from '@/server/services/sheets/signature';
import { AppsScriptEnv, FakeSheet, type Cell } from './apps-script-env';

const NOW = Date.parse('2026-10-20T06:00:00.000Z');
const SECRET = 'Zk3n9QpX2vL7wR4tY8uC1bN6mA5sD0fGhJ-_qwertyu';
const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

const INPUT: AppsScriptInput = {
  endpoint: 'https://app.example.test/api/webhooks/google-sheets',
  keyId: 'as_k3yIdExample01',
  sheetId: SHEET_ID,
  sheetName: 'Form Responses 1',
  mappingVersion: 3,
  columns: ['Timestamp', 'Full name', 'Phone number', 'Email address', 'WhatsApp updates'],
  submittedAtColumn: 'Timestamp',
  generatedAt: new Date('2026-10-20T05:00:00.000Z'),
};

const HEADER: Cell[] = ['Timestamp', 'Full name', 'Phone number', 'Email address', 'Notes', 'WhatsApp updates'];

function row(i: number, overrides: Partial<Record<string, Cell>> = {}): Cell[] {
  const base: Record<string, Cell> = {
    Timestamp: new Date(Date.UTC(2026, 9, 20, 4, i)),
    'Full name': `Person ${i}`,
    'Phone number': `98100000${String(i).padStart(2, '0')}`,
    'Email address': `p${i}@example.test`,
    Notes: `private note ${i}`,
    'WhatsApp updates': i % 2 === 0 ? 'Yes' : 'No',
    ...overrides,
  };
  return HEADER.map((h) => base[h as string]!);
}

function env(rows: Cell[][] = [HEADER, row(1), row(2)], input: AppsScriptInput = INPUT): AppsScriptEnv {
  return new AppsScriptEnv(SHEET_ID, new FakeSheet('Form Responses 1', rows), NOW).load(generateAppsScript(input));
}

function withSecret(e: AppsScriptEnv): AppsScriptEnv {
  e.promptAnswer = { button: 'OK', text: SECRET };
  e.call('auraleadSetSecret');
  return e;
}

const eventIdCol = (e: AppsScriptEnv) => e.sheet.rows[0]!.indexOf('auralead_event_id') + 1;

describe('generated Apps Script: configuration', () => {
  it('embeds the endpoint, key id, sheet, mapping version and mapped columns, and never a secret', () => {
    const script = generateAppsScript(INPUT);
    const e = new AppsScriptEnv(SHEET_ID, new FakeSheet('Form Responses 1', [HEADER]), NOW).load(script);
    expect(e.global('AURALEAD')).toMatchObject({
      endpoint: INPUT.endpoint,
      keyId: INPUT.keyId,
      sheetId: SHEET_ID,
      sheetName: 'Form Responses 1',
      mappingVersion: 3,
      columns: INPUT.columns,
      submittedAtColumn: 'Timestamp',
      eventIdColumn: 'auralead_event_id',
      maxRowsPerPush: 50,
    });
    expect(script).not.toContain(SECRET);
    expect(script).toContain('PropertiesService.getScriptProperties()');
    expect(script).toContain('muteHttpExceptions: true');
    // Loading the script does nothing by itself.
    expect(e.fetches).toHaveLength(0);
    expect(e.sheet.writes).toHaveLength(0);
  });

  it('keeps hostile column names and tab names inside string literals', () => {
    const hostile = ['"); UrlFetchApp.fetch("https://evil.test"); ("', '*/ Logger.log("x") /*', 'नाम   line'];
    const e = new AppsScriptEnv(SHEET_ID, new FakeSheet('x\'"; tab', [hostile]), NOW).load(generateAppsScript({ ...INPUT, columns: hostile, sheetName: 'x\'"; tab', submittedAtColumn: null }));
    expect(e.global<{ columns: string[]; sheetName: string }>('AURALEAD')).toMatchObject({ columns: hostile, sheetName: 'x\'"; tab' });
    expect(e.fetches).toHaveLength(0);
  });

  it('adds an AuraLead menu on open', () => {
    const e = env();
    e.call('onOpen');
    expect(e.menus).toEqual([
      {
        name: 'AuraLead',
        items: [
          ['Set signing secret', 'auraleadSetSecret'],
          ['Set up', 'auraleadSetup'],
          ['Send queued rows now', 'auraleadFlushPending'],
        ],
      },
    ]);
  });
});

describe('generated Apps Script: the secret', () => {
  it('stores the secret in Script Properties only, never in a cell, and refuses something that is not a secret', () => {
    const e = env();
    e.promptAnswer = { button: 'OK', text: 'too short' };
    e.call('auraleadSetSecret');
    expect(e.properties.has('AURALEAD_SECRET')).toBe(false);
    withSecret(e);
    expect(e.properties.get('AURALEAD_SECRET')).toBe(SECRET);
    e.call('auraleadSetup');
    e.sheet.rows.push(row(3));
    e.call('auraleadOnFormSubmit', e.formSubmitEvent(4));
    e.answer({ code: 503 }, { code: 503 }, { code: 503 }, { code: 503 });
    e.sheet.rows.push(row(4));
    e.call('auraleadOnFormSubmit', e.formSubmitEvent(5));
    e.call('auraleadFlushPending');
    expect(e.sheet.writes.length).toBeGreaterThan(0);
    expect(e.sheet.writes.some((w) => String(w.value).includes(SECRET))).toBe(false);
    expect(e.sheet.rows.flat().some((c) => String(c).includes(SECRET))).toBe(false);
    for (const f of e.fetches) expect(f.params.payload).not.toContain(SECRET);
    expect(e.logs.join('\n')).not.toContain(SECRET);
  });

  it('setup refuses to run before the secret is set, and when a mapped column is missing', () => {
    const e = env();
    expect(() => e.call('auraleadSetup')).toThrow(/signing secret/);
    expect(e.sheet.writes).toHaveLength(0);
    const missing = withSecret(env([HEADER.filter((h) => h !== 'Phone number'), row(1)]));
    expect(() => missing.call('auraleadSetup')).toThrow(/Phone number/);
  });
});

describe('generated Apps Script: auralead_event_id', () => {
  it('setup adds the hidden, warning-protected column, ids each row once, keeps existing ids and installs two triggers', () => {
    const e = withSecret(env([HEADER, row(1), row(2), row(3)]));
    e.call('auraleadSetup');
    const col = eventIdCol(e);
    expect(col).toBe(HEADER.length + 1);
    expect(e.sheet.hidden).toEqual([col]);
    expect(e.sheet.protections).toEqual([expect.objectContaining({ col, warningOnly: true })]);
    const ids = [2, 3, 4].map((r) => e.sheet.cell(r, col));
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(String(id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.triggers.map((t) => [t.handler, t.kind, t.detail]).sort()).toEqual([
      ['auraleadFlushPending', 'everyMinutes', 15],
      ['auraleadOnFormSubmit', 'onFormSubmit', SHEET_ID],
    ]);
    // Setup never pushes history (the server-side sync reads it).
    expect(e.fetches).toHaveLength(0);

    // Running setup again: the same ids, still exactly two triggers.
    e.sheet.set(3, col, '');
    e.call('auraleadSetup');
    expect(e.sheet.cell(2, col)).toBe(ids[0]);
    expect(e.sheet.cell(4, col)).toBe(ids[2]);
    expect(String(e.sheet.cell(3, col))).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.triggers).toHaveLength(2);
  });

  it('a form submit writes the row id once; an edited row is sent again with the same id', () => {
    const e = withSecret(env());
    e.call('auraleadSetup');
    e.sheet.rows.push(row(9));
    e.call('auraleadOnFormSubmit', e.formSubmitEvent(4));
    const col = eventIdCol(e);
    const id = String(e.sheet.cell(4, col));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const first = e.bodies()[0] as { rows: Array<{ rowKey: string; values: Record<string, unknown>; submittedAt: string }>; header: string[] };
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]!.rowKey).toBe(id);
    // Only mapped columns travel; the unmapped "Notes" column stays in the Sheet.
    expect(Object.keys(first.rows[0]!.values).sort()).toEqual([...INPUT.columns].sort());
    expect(JSON.stringify(first)).not.toContain('private note');
    expect(first.rows[0]!.submittedAt).toBe(new Date(Date.UTC(2026, 9, 20, 4, 9)).toISOString());
    // The header is sent for the drift check, without the event id column.
    expect(first.header).toEqual(HEADER);

    // The row is corrected by hand and the trigger fires again (or fires twice).
    e.sheet.set(4, 3, '9810009999');
    e.call('auraleadOnFormSubmit', e.formSubmitEvent(4));
    const second = e.bodies()[1] as { rows: Array<{ rowKey: string; values: Record<string, unknown> }> };
    expect(second.rows[0]!.rowKey).toBe(id);
    expect(second.rows[0]!.values['Phone number']).toBe('9810009999');
    expect(e.sheet.writes.filter((w) => w.col === col && w.row === 4)).toHaveLength(1);
  });

  it('ignores a submit on another tab', () => {
    const e = withSecret(env());
    e.call('auraleadSetup');
    const other = new FakeSheet('Other', [HEADER, row(5)], 202);
    e.call('auraleadOnFormSubmit', { range: other.getRange(2, 1, 1, 6) });
    expect(e.fetches).toHaveLength(0);
  });
});

describe('generated Apps Script: signing', () => {
  it('signs timestamp.eventId.body with the secret; the server verifier accepts it', () => {
    const e = withSecret(env([HEADER, row(1, { 'Full name': 'राहुल शर्मा' })]));
    e.call('auraleadSetup');
    e.sheet.rows.push(row(2, { 'Full name': 'प्रिया' }));
    e.call('auraleadOnFormSubmit', e.formSubmitEvent(3));
    expect(e.fetches).toHaveLength(1);
    const { url, params } = e.fetches[0]!;
    expect(url).toBe(INPUT.endpoint);
    expect(params).toMatchObject({ method: 'post', contentType: 'application/json', muteHttpExceptions: true, followRedirects: false });
    const h = params.headers;
    expect(h[SHEETS_SIGNATURE_HEADERS.keyId]).toBe(INPUT.keyId);
    expect(h[SHEETS_SIGNATURE_HEADERS.timestamp]).toBe(String(Math.floor(NOW / 1000)));
    const eventId = h[SHEETS_SIGNATURE_HEADERS.eventId]!;
    expect(eventId).toMatch(/^[0-9a-f-]{36}$/);
    const body = params.payload;
    // ASCII only: Devanagari travels as \u escapes, so the signed bytes cannot depend on a charset.
    expect(/^[\x20-\x7e]*$/.test(body)).toBe(true);
    const parsed = JSON.parse(body) as { version: number; eventId: string; sheetId: string; mappingVersion: number; rows: Array<{ values: Record<string, unknown> }> };
    expect(parsed).toMatchObject({ version: 1, eventId, sheetId: SHEET_ID, mappingVersion: 3 });
    expect(parsed.rows[0]!.values['Full name']).toBe('प्रिया');
    const expected = createHmac('sha256', SECRET).update(`${h[SHEETS_SIGNATURE_HEADERS.timestamp]}.${eventId}.${body}`, 'utf8').digest('hex');
    expect(h[SHEETS_SIGNATURE_HEADERS.signature]).toBe(`v1=${expected}`);
    expect(verifySheetsSignature(SECRET, h[SHEETS_SIGNATURE_HEADERS.timestamp]!, eventId, Buffer.from(body, 'utf8'), h[SHEETS_SIGNATURE_HEADERS.signature]!)).toBe(true);
    expect(verifySheetsSignature('another-secret-another-secret-0000', h[SHEETS_SIGNATURE_HEADERS.timestamp]!, eventId, Buffer.from(body, 'utf8'), h[SHEETS_SIGNATURE_HEADERS.signature]!)).toBe(false);
  });

  it('does not send without the secret, and keeps the row queued', () => {
    const e = env();
    e.sheet.rows.push(row(3));
    e.call('auraleadOnFormSubmit', e.formSubmitEvent(4));
    expect(e.fetches).toHaveLength(0);
    expect(JSON.parse(e.properties.get('AURALEAD_PENDING') ?? '[]')).toHaveLength(1);
  });
});

describe('generated Apps Script: retries and the queue', () => {
  function submitted(answers: Parameters<AppsScriptEnv['answer']>) {
    const e = withSecret(env());
    e.call('auraleadSetup');
    e.answer(...answers);
    e.sheet.rows.push(row(7));
    e.call('auraleadOnFormSubmit', e.formSubmitEvent(4));
    return e;
  }
  const queued = (e: AppsScriptEnv) => JSON.parse(e.properties.get('AURALEAD_PENDING') ?? '[]') as string[];

  it('backs off on 5xx and 429 with the same event id, re-signed each time, then succeeds', () => {
    const e = submitted([{ code: 503 }, { code: 429, headers: { 'Retry-After': '3' } }, { code: 200 }]);
    expect(e.fetches).toHaveLength(3);
    expect(new Set(e.fetches.map((f) => f.params.headers[SHEETS_SIGNATURE_HEADERS.eventId])).size).toBe(1);
    expect(e.sleeps).toHaveLength(2);
    expect(e.sleeps[0]).toBeGreaterThanOrEqual(1000);
    expect(e.sleeps[1]).toBeGreaterThanOrEqual(3000);
    expect(queued(e)).toEqual([]);
  });

  it('a network error is retried; when every attempt fails the row waits in the queue', () => {
    const e = submitted([{ throw: 'DNS error' }, { throw: 'DNS error' }, { throw: 'DNS error' }, { throw: 'DNS error' }]);
    expect(e.fetches).toHaveLength(4);
    expect(e.sleeps).toHaveLength(3);
    expect(e.sleeps[2]!).toBeGreaterThan(e.sleeps[0]!);
    expect(queued(e)).toHaveLength(1);
  });

  it('does not retry a 4xx; 400 drops the row, 401 and a mapping 409 keep it for the next flush', () => {
    const bad = submitted([{ code: 400, body: { code: 'INVALID_PAYLOAD' } }]);
    expect(bad.fetches).toHaveLength(1);
    expect(queued(bad)).toEqual([]);
    const unauthorized = submitted([{ code: 401, body: { code: 'SIGNATURE_INVALID' } }]);
    expect(unauthorized.fetches).toHaveLength(1);
    expect(queued(unauthorized)).toHaveLength(1);
    const drift = submitted([{ code: 409, body: { code: 'HEADER_DRIFT' } }]);
    expect(drift.fetches).toHaveLength(1);
    expect(queued(drift)).toHaveLength(1);
  });

  it('a flush sends at most 50 queued rows per push, oldest first, and drops ids no longer in the Sheet', () => {
    const rows: Cell[][] = [HEADER];
    for (let i = 1; i <= 60; i += 1) rows.push(row(i));
    const e = withSecret(env(rows));
    e.call('auraleadSetup');
    const col = eventIdCol(e);
    const ids = Array.from({ length: 60 }, (_, i) => String(e.sheet.cell(i + 2, col)));
    e.properties.set('AURALEAD_PENDING', JSON.stringify(['gone-row-id', ...ids]));
    e.call('auraleadFlushPending');
    expect(e.fetches).toHaveLength(1);
    const first = e.bodies()[0] as { rows: Array<{ rowKey: string }> };
    expect(first.rows).toHaveLength(49);
    expect(first.rows.map((r) => r.rowKey)).toEqual(ids.slice(0, 49));
    expect(queued(e)).toEqual(ids.slice(49));
    e.call('auraleadFlushPending');
    expect((e.bodies()[1] as { rows: unknown[] }).rows).toHaveLength(11);
    expect(queued(e)).toEqual([]);
    for (const b of e.bodies()) expect((b as { rows: unknown[] }).rows.length).toBeLessThanOrEqual(50);
  });

  it('a failed flush keeps its rows at the front of the queue', () => {
    const e = withSecret(env([HEADER, row(1), row(2)]));
    e.call('auraleadSetup');
    const col = eventIdCol(e);
    const ids = [2, 3].map((r) => String(e.sheet.cell(r, col)));
    e.properties.set('AURALEAD_PENDING', JSON.stringify(ids));
    e.answer({ code: 500 }, { code: 500 }, { code: 500 }, { code: 500 });
    e.call('auraleadFlushPending');
    expect(queued(e)).toEqual(ids);
  });
});

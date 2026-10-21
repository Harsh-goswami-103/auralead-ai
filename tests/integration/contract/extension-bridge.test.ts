/**
 * T36 / R37: the extension bridge contract (`extension-bridge/saas-sync.js`, ADR-13) driven by a
 * fake `chrome.*` in node; no real Chrome, no network. The vendor extension is played by the test:
 * it saves its whole local blob (`collect` rows plus `_auth`) under its own storage key, as the
 * security review records for `saveToLocal` (docs/reviews/ceo/03-security.md T19 (4)).
 *  - diff by row_key against the bridge's own ledger: only new rows are sent;
 *  - the ledger keeps row_key -> recordId, state, batchId and a content hash, never contact data;
 *  - the queue is persisted in chrome.storage.local before any request is made;
 *  - the bridge never writes, removes or clears the vendor key (nor anything else of the vendor);
 *  - the vendor "clear" (collect = []) is a no-op: nothing is sent, deleted or forgotten;
 *  - the licence gate: `_auth.hasValidKey !== true` gives "Extension not licensed: sync disabled"
 *    and no request at all;
 *  - `cid` is the record id, `row_key` the fallback; rows without a row_key are skipped and counted;
 *  - copy-agnostic field mapping, no invented email, the extraction time stamped by the bridge;
 *  - batches of at most 200 records per keyword, a settle window, permanent versus retryable
 *    failures, exponential backoff through chrome.alarms capped at 30 minutes, Retry-After.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extensionBatchSchema, extensionEnvelopeSchema } from '@/lib/schemas/webhooks';
import { BRIDGE_SOURCE_PATH, TEST_EXTENSION_ID, VENDOR_KEY, accepted, createBridgeEnv, fakeServer, jsonResponse, loadBridgeModule, type BridgeEnv } from '../../support/extension-bridge';
import { createFakeChrome, fakeClock } from '../../support/fake-chrome';

const ORIGIN = 'https://app.auralead.example';
const TOKEN = `alx_0123456789abcdef_${'S'.repeat(43)}`;
const LICENSED = { hasValidKey: true };

type Row = Record<string, unknown>;
const row = (n: number, extra: Row = {}): Row => ({
  row_key: `rk-${n}`,
  cid: `100000000000000${String(n).padStart(4, '0')}`,
  name: `Clinic ${n}`,
  phone: `+91 98110 ${String(10000 + n)}`,
  address: `Shop ${n}, Sector 29`,
  website: `https://clinic-${n}.example.in`,
  rating: 4.5,
  reviews: 120 + n,
  category: 'Dental clinic',
  keyword: 'dentist gurugram',
  location: 'Gurugram',
  ...extra,
});

async function ready(options: { settleSeconds?: number; respond?: Parameters<typeof fakeServer>[0] } = {}): Promise<{ env: BridgeEnv; server: ReturnType<typeof fakeServer> }> {
  const server = fakeServer(options.respond);
  const env = createBridgeEnv({ fetch: server.fetch });
  env.start();
  await env.configure({ saasOrigin: ORIGIN, token: TOKEN, settleSeconds: options.settleSeconds ?? 0 });
  return { env, server };
}

const bridgeWrites = (env: BridgeEnv) => env.chrome.storage.local.writes.filter((w) => w.by === 'api');

describe('diff by row_key and the ledger', () => {
  it('sends only rows whose row_key is new; a re-save of the same rows sends nothing', async () => {
    const { env, server } = await ready();
    await env.vendorSave({ _auth: LICENSED, collect: [row(1), row(2)] });
    expect(server.requests).toHaveLength(1);
    const first = server.requests[0]!;
    expect(first.url).toBe(`${ORIGIN}/api/webhooks/gmaps-extension`);
    expect(first.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(first.headers['content-type']).toBe('application/json');
    expect(first.json).toMatchObject({ version: 1, keyword: 'dentist gurugram' });
    expect(first.json.batchId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(first.json.records.map((r) => r.recordId)).toEqual([row(1).cid, row(2).cid]);

    await env.vendorSave({ _auth: LICENSED, collect: [row(1), row(2)] });
    expect(server.requests).toHaveLength(1);

    await env.vendorSave({ _auth: LICENSED, collect: [row(1), row(2), row(3)] });
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]!.json.records.map((r) => r.recordId)).toEqual([row(3).cid]);
    expect(server.requests[1]!.json.batchId).not.toBe(first.json.batchId);
  });

  it('keeps row_key -> recordId, state, batchId and a hash in its own ledger, with no contact data', async () => {
    const { env, server } = await ready();
    await env.vendorSave({ _auth: LICENSED, collect: [row(1), row(2)] });
    const ledger = env.ledger();
    expect(Object.keys(ledger).sort()).toEqual(['rk-1', 'rk-2']);
    expect(ledger['rk-1']).toMatchObject({ recordId: row(1).cid, state: 'sent', batchId: server.requests[0]!.json.batchId, reasonCode: null });
    expect(ledger['rk-1']!.hash).toMatch(/^[0-9a-f]{8,}$/);
    const raw = JSON.stringify(ledger);
    for (const value of [row(1).phone, row(1).name, row(1).address, row(1).website]) expect(raw).not.toContain(String(value));
    expect(env.status()).toMatchObject({ state: 'idle', queuedBatches: 0, pendingRows: 0, sentRows: 2 });
  });

  it('a row changed after it was sent is marked, not sent again (the server never updates a lead from a re-sent record)', async () => {
    const { env, server } = await ready();
    await env.vendorSave({ _auth: LICENSED, collect: [row(1)] });
    await env.vendorSave({ _auth: LICENSED, collect: [row(1, { email: 'front.desk@clinic-1.example.in' })] });
    expect(server.requests).toHaveLength(1);
    expect(env.ledger()['rk-1']).toMatchObject({ state: 'sent', changedAfterSend: true });
  });
});

describe('durable queue', () => {
  it('persists the batch in chrome.storage.local before the request, with the exact bytes it sends', async () => {
    let queuedAtRequest: unknown = null;
    const server = fakeServer((request) => {
      queuedAtRequest = env.queue();
      return accepted(request);
    });
    const env = createBridgeEnv({ fetch: server.fetch });
    env.start();
    await env.configure({ saasOrigin: ORIGIN, token: TOKEN, settleSeconds: 0 });
    await env.vendorSave({ _auth: LICENSED, collect: [row(1)] });
    expect(server.requests).toHaveLength(1);
    expect(queuedAtRequest).toEqual([
      expect.objectContaining({ batchId: server.requests[0]!.json.batchId, body: server.requests[0]!.body, rowKeys: ['rk-1'], recordIds: [row(1).cid] }),
    ]);
    expect(env.queue()).toEqual([]);
  });

  it('a queued batch survives a service-worker restart and is sent by the next instance with the same batchId', async () => {
    const server = fakeServer((request, n) => (n === 1 ? jsonResponse(503, { code: 'DB_BUSY' }) : accepted(request)));
    const env = createBridgeEnv({ fetch: server.fetch });
    env.start();
    await env.configure({ saasOrigin: ORIGIN, token: TOKEN, settleSeconds: 0 });
    await env.vendorSave({ _auth: LICENSED, collect: [row(1)] });
    expect(env.queue()).toHaveLength(1);
    const batchId = env.queue()[0]!.batchId;

    await env.restart();
    await env.advance(60_000);
    expect(server.requests.map((r) => r.json.batchId)).toEqual([batchId, batchId]);
    expect(server.requests[1]!.body).toBe(server.requests[0]!.body);
    expect(env.queue()).toEqual([]);
  });
});

describe('the vendor key is read-only', () => {
  it('never writes, removes or clears the vendor key, and the vendor blob is exactly what the vendor saved', async () => {
    const { env } = await ready({ respond: (r, n) => (n % 2 === 0 ? jsonResponse(503, {}) : accepted(r)) });
    const blob = { _auth: { hasValidKey: true, licenseKey: 'VENDOR-KEY-NOT-READ' }, collect: [row(1), row(2)], settings: { theme: 'dark' } };
    await env.vendorSave(blob);
    await env.vendorSave({ ...blob, collect: [...blob.collect, row(3)] });
    await env.advance(10 * 60_000);
    await env.vendorSave({ ...blob, collect: [] });
    expect(env.chrome.storage.local.writes.some((w) => w.by === 'api' && (w.op !== 'set' || w.keys.includes(VENDOR_KEY)))).toBe(false);
    expect(bridgeWrites(env).flatMap((w) => w.keys).every((k) => k.startsWith('auralead_sync_'))).toBe(true);
    expect(env.chrome.storage.local.peek(VENDOR_KEY)).toEqual({ ...blob, collect: [] });
    // The licence key is never copied anywhere the bridge writes.
    const everything = JSON.stringify(Object.values(env.module.KEYS).map((k) => env.chrome.storage.local.peek(k)));
    expect(everything).not.toContain('VENDOR-KEY-NOT-READ');
  });

  it('the shipped example batch and a batch the bridge built both satisfy the server schema', async () => {
    const example = JSON.parse(fs.readFileSync(BRIDGE_SOURCE_PATH.replace('saas-sync.js', 'examples/batch-v1.json'), 'utf8')) as unknown;
    expect(extensionBatchSchema.safeParse(example).success).toBe(true);
    const { env, server } = await ready();
    await env.vendorSave({ _auth: LICENSED, collect: [row(1), row(2, { email: 'a@clinic.example.in' })] });
    expect(extensionBatchSchema.safeParse(server.requests[0]!.json).success).toBe(true);
    expect(extensionEnvelopeSchema.safeParse(server.requests[0]!.json).success).toBe(true);
  });

  it('the source contains no vendor code markers, no licence-key access and no storage clear', () => {
    const source = fs.readFileSync(BRIDGE_SOURCE_PATH, 'utf8');
    for (const marker of ['licenseKey', 'jmjdigitalworld', 'foxoyo', 'dataget', 'gmapkeyregistration', '$box', 'storage.local.clear', '.remove(']) expect(source).not.toContain(marker);
  });
});

describe('"clear" is a no-op', () => {
  it('emptying collect sends nothing, deletes nothing and forgets nothing; the same rows saved again are not resent', async () => {
    const { env, server } = await ready();
    await env.vendorSave({ _auth: LICENSED, collect: [row(1), row(2)] });
    const ledgerBefore = env.ledger();
    await env.vendorSave({ _auth: LICENSED, collect: [] });
    await env.vendorSave({ _auth: LICENSED });
    expect(server.requests).toHaveLength(1);
    expect(env.ledger()).toEqual(ledgerBefore);
    await env.vendorSave({ _auth: LICENSED, collect: [row(1), row(2)] });
    expect(server.requests).toHaveLength(1);
  });

  it('rows still settling when the vendor clears are sent after the settle window from the bridge’s own copy', async () => {
    const { env, server } = await ready({ settleSeconds: 60 });
    await env.vendorSave({ _auth: LICENSED, collect: [row(1)] });
    expect(server.requests).toHaveLength(0);
    await env.vendorSave({ _auth: LICENSED, collect: [] });
    await env.advance(61_000);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.json.records[0]).toMatchObject({ recordId: row(1).cid, name: 'Clinic 1' });
  });
});

describe('licence gate', () => {
  it.each([
    ['hasValidKey false', { _auth: { hasValidKey: false } }],
    ['no _auth at all', {}],
    ['hasValidKey "true" (a string)', { _auth: { hasValidKey: 'true' } }],
  ])('%s: sync disabled, status says so, nothing is sent or recorded', async (_label, auth) => {
    const { env, server } = await ready();
    await env.vendorSave({ ...auth, collect: [row(1), row(2)] });
    expect(server.requests).toHaveLength(0);
    expect(env.ledger()).toEqual({});
    expect(env.status()).toMatchObject({ state: 'unlicensed', message: 'Extension not licensed: sync disabled', licensed: false });
    expect(env.module.UNLICENSED_MESSAGE).toBe('Extension not licensed: sync disabled');
  });

  it('a licence that lapses stops queued retries; it resumes once the vendor reports a valid key again', async () => {
    const { env, server } = await ready({ respond: (r, n) => (n === 1 ? jsonResponse(503, {}) : accepted(r)) });
    await env.vendorSave({ _auth: LICENSED, collect: [row(1)] });
    expect(server.requests).toHaveLength(1);
    await env.vendorSave({ _auth: { hasValidKey: false }, collect: [row(1)] });
    await env.advance(60 * 60_000);
    expect(server.requests).toHaveLength(1);
    expect(env.status()).toMatchObject({ state: 'unlicensed' });
    await env.vendorSave({ _auth: LICENSED, collect: [row(1)] });
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]!.json.batchId).toBe(server.requests[0]!.json.batchId);
  });
});

describe('record ids and fields', () => {
  it('uses cid as the record id and falls back to row_key; a row without row_key is skipped and counted', async () => {
    const { env, server } = await ready();
    const noCid = row(2);
    delete noCid.cid;
    const noKey = row(3);
    delete noKey.row_key;
    await env.vendorSave({ _auth: LICENSED, collect: [row(1), noCid, noKey, row(4, { cid: '' })] });
    expect(server.requests[0]!.json.records.map((r) => r.recordId)).toEqual([row(1).cid, 'rk-2', 'rk-4']);
    expect(env.ledger()['rk-2']).toMatchObject({ recordId: 'rk-2' });
    expect(env.status()).toMatchObject({ rowsWithoutKey: 1 });
  });

  it('maps fields copy-agnostically, never invents an email and stamps the extraction time once', async () => {
    const { env, server } = await ready();
    await env.configure({ fieldMap: { name: ['title'], phone: ['phone_numbers'], email: ['emails'], website: ['site'], placeId: ['place_id'] } });
    const firstSeen = env.clock.now();
    await env.vendorSave({
      _auth: LICENSED,
      collect: [
        { row_key: 'a', title: 'Mapped Studio', phone_numbers: ['+91 98110 22222', '0124 400 1234'], emails: ['hello@mapped.example.in', 'second@mapped.example.in'], site: 'mapped.example.in', place_id: 'ChIJ-example', keyword: 'studio' },
        { row_key: 'b', title: 'No Email Studio', phone_numbers: '+91 98110 33333', keyword: 'studio' },
      ],
    });
    const [a, b] = server.requests[0]!.json.records;
    expect(a).toMatchObject({ recordId: 'a', name: 'Mapped Studio', phone: '+91 98110 22222, 0124 400 1234', email: 'hello@mapped.example.in', website: 'mapped.example.in', placeId: 'ChIJ-example' });
    expect(a!.extractedAt).toBe(new Date(firstSeen).toISOString());
    expect(b!.email ?? null).toBeNull();
    expect(Object.values(b!).join(' ')).not.toMatch(/@/);
  });

  it('groups by keyword and cuts batches at 200 records', async () => {
    const { env, server } = await ready();
    const rows = [...Array.from({ length: 450 }, (_, i) => row(i + 1)), ...Array.from({ length: 3 }, (_, i) => row(1000 + i, { keyword: 'gym noida' }))];
    await env.vendorSave({ _auth: LICENSED, collect: rows });
    expect(server.requests.map((r) => [r.json.keyword, r.json.records.length])).toEqual([
      ['dentist gurugram', 200],
      ['dentist gurugram', 200],
      ['dentist gurugram', 50],
      ['gym noida', 3],
    ]);
    expect(new Set(server.requests.map((r) => r.json.batchId)).size).toBe(4);
    for (const r of server.requests) expect(Buffer.byteLength(r.body)).toBeLessThan(1_000_000);
  });

  it('waits for a row to settle so later vendor updates (an email found afterwards) go out in the first send', async () => {
    const { env, server } = await ready({ settleSeconds: 60 });
    await env.vendorSave({ _auth: LICENSED, collect: [row(1)] });
    await env.advance(30_000);
    await env.vendorSave({ _auth: LICENSED, collect: [row(1, { email: 'desk@clinic-1.example.in' })] });
    await env.advance(45_000);
    expect(server.requests).toHaveLength(0);
    await env.advance(20_000);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.json.records[0]).toMatchObject({ email: 'desk@clinic-1.example.in' });
  });
});

describe('server answers', () => {
  it('records per-record intake rejections in the ledger', async () => {
    const { env } = await ready({
      respond: (r) =>
        jsonResponse(202, {
          batchId: r.json.batchId,
          outcome: 'ACCEPTED',
          status: 'RECEIVED',
          records: [
            { index: 0, recordId: r.json.records[0]!.recordId, status: 'QUEUED', reasonCode: null },
            { index: 1, recordId: r.json.records[1]!.recordId, status: 'REJECTED', reasonCode: 'INVALID_RECORD', fields: ['name'] },
          ],
        }),
    });
    await env.vendorSave({ _auth: LICENSED, collect: [row(1), row(2)] });
    expect(env.ledger()['rk-1']).toMatchObject({ state: 'sent' });
    expect(env.ledger()['rk-2']).toMatchObject({ state: 'rejected', reasonCode: 'INVALID_RECORD' });
  });

  it.each([
    [413, 'TOO_MANY_RECORDS'],
    [409, 'BATCH_CONTENT_MISMATCH'],
    [422, 'NO_VALID_RECORDS'],
    [400, 'VALIDATION_FAILED'],
  ])('%i %s is permanent for that batch: moved to failed, the next batch still goes', async (status, code) => {
    const { env, server } = await ready({ respond: (r, n) => (n === 1 ? jsonResponse(status, { code, message: 'no', reference: 'req_x' }) : accepted(r)) });
    await env.vendorSave({ _auth: LICENSED, collect: [row(1), row(2, { keyword: 'second' })] });
    expect(server.requests).toHaveLength(2);
    expect(env.failed()).toEqual([expect.objectContaining({ batchId: server.requests[0]!.json.batchId, code, httpStatus: status, rowKeys: ['rk-1'] })]);
    expect(env.ledger()['rk-1']).toMatchObject({ state: 'failed', reasonCode: code });
    expect(env.ledger()['rk-2']).toMatchObject({ state: 'sent' });
    expect(env.queue()).toEqual([]);
  });

  it('5xx and network errors retry through chrome.alarms with exponential backoff capped at 30 minutes', async () => {
    const { env, server } = await ready({ respond: () => jsonResponse(503, { code: 'DB_BUSY' }) });
    await env.vendorSave({ _auth: LICENSED, collect: [row(1)] });
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const alarm = env.chrome.alarms.peek(env.module.ALARM_NAME);
      expect(alarm).toBeDefined();
      delays.push(Math.round((alarm!.scheduledTime - env.clock.now()) / 60_000));
      await env.advance(alarm!.scheduledTime - env.clock.now());
    }
    expect(delays).toEqual([1, 2, 4, 8, 16, 30, 30, 30]);
    expect(new Set(server.requests.map((r) => r.json.batchId)).size).toBe(1);
    expect(env.status()).toMatchObject({ state: 'retrying', queuedBatches: 1, lastError: { httpStatus: 503 } });
    expect(env.module.backoffDelayMs(50)).toBe(30 * 60_000);
  });

  it('429 honours Retry-After (bounded by the 30-minute cap)', async () => {
    const { env, server } = await ready({ respond: (r, n) => (n === 1 ? jsonResponse(429, { code: 'RATE_LIMITED' }, { 'retry-after': '120' }) : accepted(r)) });
    await env.vendorSave({ _auth: LICENSED, collect: [row(1)] });
    const alarm = env.chrome.alarms.peek(env.module.ALARM_NAME)!;
    expect(alarm.scheduledTime - env.clock.now()).toBe(120_000);
    await env.advance(120_000);
    expect(server.requests).toHaveLength(2);
  });

  it('401 token_revoked pauses every send, keeps the queue and says what to do; a new token resumes the same batch', async () => {
    const { env, server } = await ready({ respond: (r, n) => (n === 1 ? jsonResponse(401, { code: 'token_revoked', message: 'revoked', reference: 'req_r' }) : accepted(r)) });
    await env.vendorSave({ _auth: LICENSED, collect: [row(1)] });
    expect(env.status()).toMatchObject({ state: 'paused_auth', lastError: { code: 'token_revoked', httpStatus: 401 } });
    expect(env.status()!.message).toMatch(/Token revoked/);
    expect(env.queue()).toHaveLength(1);
    await env.advance(60 * 60_000);
    await env.vendorSave({ _auth: LICENSED, collect: [row(1), row(2)] });
    expect(server.requests).toHaveLength(1);
    await env.restart();
    expect(server.requests).toHaveLength(1);

    await env.configure({ token: `alx_fedcba9876543210_${'N'.repeat(43)}` });
    expect(server.requests.map((r) => r.json.batchId)[1]).toBe(server.requests[0]!.json.batchId);
    expect(server.requests[1]!.headers.authorization).toBe(`Bearer alx_fedcba9876543210_${'N'.repeat(43)}`);
    // The status the options page shows never carries the token itself.
    expect(JSON.stringify(env.status())).not.toContain('N'.repeat(8));
    expect(JSON.stringify(env.status())).not.toContain('S'.repeat(8));
  });

  it('403 (extension not allowed) pauses like an auth failure', async () => {
    const { env, server } = await ready({ respond: () => jsonResponse(403, { code: 'extension_not_allowed' }) });
    await env.vendorSave({ _auth: LICENSED, collect: [row(1)] });
    await env.advance(60 * 60_000);
    expect(server.requests).toHaveLength(1);
    expect(env.status()).toMatchObject({ state: 'paused_forbidden', lastError: { code: 'extension_not_allowed' } });
  });
});

describe('configuration', () => {
  it('without a token rows wait as pending; saving the token sends them', async () => {
    const server = fakeServer();
    const env = createBridgeEnv({ fetch: server.fetch });
    env.start();
    await env.configure({ saasOrigin: ORIGIN, settleSeconds: 0 });
    await env.vendorSave({ _auth: LICENSED, collect: [row(1)] });
    expect(server.requests).toHaveLength(0);
    expect(env.status()).toMatchObject({ state: 'not_configured', pendingRows: 1 });
    await env.configure({ token: TOKEN });
    expect(server.requests).toHaveLength(1);
  });

  it('normalizes the SaaS origin and refuses anything but an http(s) origin', () => {
    const { module } = loadBridgeModule();
    expect(module.normalizeOrigin('https://app.example.in/')).toBe('https://app.example.in');
    expect(module.normalizeOrigin('http://localhost:3000/dashboard')).toBe('http://localhost:3000');
    expect(module.normalizeOrigin('javascript:alert(1)')).toBeNull();
    expect(module.normalizeOrigin('ftp://x')).toBeNull();
    expect(module.normalizeOrigin('https://user:pw@app.example.in')).toBeNull();
  });

  it('only a service worker starts a bridge on load: the options page can load the script safely', async () => {
    const clock = fakeClock(Date.parse('2026-10-20T06:00:00.000Z'));
    const chrome = createFakeChrome({ clock, extensionId: TEST_EXTENSION_ID });
    loadBridgeModule({ chrome, fetch: () => Promise.reject(new Error('no')) });
    expect(chrome.storage.onChanged.hasListeners()).toBe(false);
    expect(chrome.alarms.onAlarm.hasListeners()).toBe(false);
  });

  it('the enabled switch stops all syncing', async () => {
    const { env, server } = await ready();
    await env.configure({ enabled: false });
    await env.vendorSave({ _auth: LICENSED, collect: [row(1)] });
    expect(server.requests).toHaveLength(0);
    expect(env.status()).toMatchObject({ state: 'disabled' });
    await env.configure({ enabled: true });
    expect(server.requests).toHaveLength(1);
  });
});

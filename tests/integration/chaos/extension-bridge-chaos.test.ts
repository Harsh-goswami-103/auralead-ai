/**
 * T36 / R37 chaos: the extension bridge (`extension-bridge/saas-sync.js`, fake `chrome.*`) against
 * the real POST /api/webhooks/gmaps-extension route, real DB and the in-process worker. The bridge's
 * fetch is the route handler called in-process with the Chrome-like `Origin: chrome-extension://<id>`
 * header, so idempotency and revocation are the server's real behaviour.
 *  - The service worker is terminated in the middle of a retry (a request that never completes) and
 *    the next instance resumes the same batchId from chrome.storage.local: one event, one lead each.
 *  - A token revoked between two retries: the retry gets 401 `token_revoked`, the bridge stops (no
 *    further requests on later alarms), keeps the batch and shows "Token revoked"; a new token sends
 *    the same batch once.
 *  - Network flaps where the request reached the server but the answer was lost: the retries are
 *    replays of the same bytes, so the server stores one event, one ImportBatch and one lead per row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeExtensionToken } from '@/server/services/extension/tokens';
import { createBridgeEnv, TEST_EXTENSION_ID, type BridgeDeps, type BridgeEnv } from '../../support/extension-bridge';
import { createExtensionHarness, ENDPOINT, issueToken, managerCtx, WS_A, type ExtensionHarness } from '../webhooks/extension-support';
import { POST as ingestRoute } from '@/app/api/webhooks/gmaps-extension/route';
import { ORIGIN } from '../auth/support';

let h: ExtensionHarness;
beforeAll(async () => {
  h = await createExtensionHarness('extension-bridge-chaos');
}, 120_000);
afterAll(async () => h?.destroy());

const LICENSED = { hasValidKey: true };
let rowSeq = 0;
function rows(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, () => {
    rowSeq += 1;
    const n = String(rowSeq).padStart(5, '0');
    return { row_key: `chaos-rk-${n}`, cid: `77${n}00${n}`, name: `Chaos Clinic ${n}`, phone: `+91 74282 ${n}`, keyword: 'chaos keyword', address: `Plot ${n}` };
  });
}

type Mode = 'server' | 'drop-before' | 'drop-after' | 'hang' | 'unavailable';

/** The bridge's fetch: the real route in-process, with a switchable failure mode per call. */
function wire(modes: Mode[]) {
  const calls: Array<{ mode: Mode; batchId: string; status: number | null }> = [];
  const fetch: BridgeDeps['fetch'] = async (url, init) => {
    const mode = modes.shift() ?? 'server';
    const batchId = (JSON.parse(init.body) as { batchId: string }).batchId;
    expect(url).toBe(`${ORIGIN}${ENDPOINT}`);
    if (mode === 'drop-before') {
      calls.push({ mode, batchId, status: null });
      throw new TypeError('Failed to fetch');
    }
    if (mode === 'hang') {
      calls.push({ mode, batchId, status: null });
      return new Promise<Response>(() => undefined);
    }
    if (mode === 'unavailable') {
      calls.push({ mode, batchId, status: 503 });
      return new Response(JSON.stringify({ code: 'DB_BUSY', message: 'busy', reference: 'req_chaos' }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    const headers = new Headers(init.headers);
    headers.set('origin', `chrome-extension://${TEST_EXTENSION_ID}`);
    const res = await ingestRoute(new Request(url, { method: init.method, headers, body: init.body }), { params: Promise.resolve({}) });
    calls.push({ mode, batchId, status: res.status });
    if (mode === 'drop-after') throw new TypeError('network changed: the answer was lost');
    return res;
  };
  return { fetch, calls };
}

async function bridgeFor(token: string, fetch: BridgeDeps['fetch']): Promise<BridgeEnv> {
  // Real UUIDs: every test's batches go to the same server database.
  const env = createBridgeEnv({ fetch, start: h.clock.now().getTime(), randomUUID: () => crypto.randomUUID() });
  env.start();
  await env.configure({ saasOrigin: ORIGIN, token, settleSeconds: 0 });
  return env;
}

const eventsFor = (batchId: string) => h.db.webhookEvent.count({ where: { provider: 'GMAPS_EXTENSION', externalKey: batchId } });
const leadsFor = (names: string[]) => h.db.lead.count({ where: { workspaceId: WS_A, displayName: { in: names } } });

describe('MV3 service-worker suspension', () => {
  it('a worker terminated mid-retry is replaced by one that resumes the same batchId; one event, one lead per row', async () => {
    const token = await issueToken(h, { allowedExtensionId: TEST_EXTENSION_ID });
    const wiring = wire(['drop-before', 'hang']);
    const env = await bridgeFor(token.token, wiring.fetch);
    const batch = rows(3);
    await env.vendorSave({ _auth: LICENSED, collect: batch });
    expect(env.queue()).toHaveLength(1);
    const batchId = env.queue()[0]!.batchId;

    // The retry alarm fires and the request hangs; Chrome then terminates the idle worker.
    env.chrome.alarms.fireDue();
    env.clock.advance(60_000);
    env.chrome.alarms.fireDue();
    await new Promise((resolve) => setTimeout(resolve, 10));
    env.terminate();
    expect(await eventsFor(batchId)).toBe(0);

    // Chrome starts the worker again (alarm or browser event): it resumes from storage.
    env.start();
    await env.settle();
    env.clock.advance(5 * 60_000);
    env.chrome.alarms.fireDue();
    await env.settle();

    expect(wiring.calls.map((c) => c.batchId)).toEqual([batchId, batchId, batchId]);
    expect(wiring.calls[2]).toMatchObject({ mode: 'server', status: 202 });
    expect(env.queue()).toEqual([]);
    expect(await eventsFor(batchId)).toBe(1);
    await h.drain();
    expect(await leadsFor(batch.map((r) => String(r.name)))).toBe(3);
    expect(env.ledger()[String(batch[0]!.row_key)]).toMatchObject({ state: 'sent', batchId });
  });
});

describe('revocation between retries', () => {
  it('the retry after a revoke gets 401 token_revoked: the bridge stops, keeps the batch and says so; a new token sends it once', async () => {
    const token = await issueToken(h, { allowedExtensionId: TEST_EXTENSION_ID });
    const wiring = wire(['unavailable']);
    const env = await bridgeFor(token.token, wiring.fetch);
    const batch = rows(2);
    await env.vendorSave({ _auth: LICENSED, collect: batch });
    const batchId = env.queue()[0]!.batchId;
    expect(env.status()).toMatchObject({ state: 'retrying' });

    await revokeExtensionToken(await managerCtx(h), { tokenId: token.id });
    await env.advance(60_000);
    expect(wiring.calls.map((c) => c.status)).toEqual([503, 401]);
    expect(env.status()).toMatchObject({ state: 'paused_auth', lastError: { code: 'token_revoked', httpStatus: 401 } });
    expect(env.status()!.message).toContain('Token revoked');
    expect(env.queue().map((q) => q.batchId)).toEqual([batchId]);

    // Later alarms and a worker restart send nothing more with the revoked token.
    await env.advance(2 * 60 * 60_000);
    await env.restart();
    await env.advance(60 * 60_000);
    expect(wiring.calls).toHaveLength(2);
    expect(await eventsFor(batchId)).toBe(0);

    // The operator issues a new token and saves it in the options page.
    const replacement = await issueToken(h, { allowedExtensionId: TEST_EXTENSION_ID });
    await env.configure({ token: replacement.token });
    expect(wiring.calls.map((c) => c.status)).toEqual([503, 401, 202]);
    expect(wiring.calls[2]!.batchId).toBe(batchId);
    expect(await eventsFor(batchId)).toBe(1);
    expect(env.status()).toMatchObject({ state: 'idle', queuedBatches: 0 });
  });
});

describe('network flap', () => {
  it('answers lost after the server stored the batch: retries are replays, no duplicate event, batch or lead', async () => {
    const token = await issueToken(h, { allowedExtensionId: TEST_EXTENSION_ID });
    const wiring = wire(['drop-after', 'drop-before', 'drop-after', 'server']);
    const env = await bridgeFor(token.token, wiring.fetch);
    const batch = rows(4);
    await env.vendorSave({ _auth: LICENSED, collect: batch });
    const batchId = env.queue()[0]!.batchId;
    for (let i = 0; i < 6 && env.queue().length > 0; i += 1) {
      if (i === 1) await h.drain(); // the worker processes the stored batch between two flaps
      const alarm = env.chrome.alarms.peek('auralead-sync')!;
      await env.advance(alarm.scheduledTime - env.clock.now());
    }
    expect(wiring.calls.map((c) => [c.mode, c.status])).toEqual([
      ['drop-after', 202],
      ['drop-before', null],
      ['drop-after', 200],
      ['server', 200],
    ]);
    expect(new Set(wiring.calls.map((c) => c.batchId))).toEqual(new Set([batchId]));
    expect(await eventsFor(batchId)).toBe(1);
    expect(await h.db.importBatch.count({ where: { workspaceId: WS_A, source: 'GMAPS_EXTENSION', externalBatchId: batchId } })).toBe(1);
    await h.drain();
    expect(await leadsFor(batch.map((r) => String(r.name)))).toBe(4);
    expect(await h.db.leadSourceRecord.count({ where: { workspaceId: WS_A, source: 'GMAPS_EXTENSION', externalId: { in: batch.map((r) => String(r.cid)) } } })).toBe(4);
    expect(env.queue()).toEqual([]);
    expect(Object.values(env.ledger()).filter((e) => e.batchId === batchId).every((e) => e.state === 'sent')).toBe(true);
  });
});

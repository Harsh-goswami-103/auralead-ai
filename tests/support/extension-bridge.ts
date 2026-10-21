/**
 * Typed wrapper around `extension-bridge/saas-sync.js` for the contract and chaos tests (plan §11
 * T36). The bridge is a plain classic script (it is loaded with `importScripts` inside the vendor's
 * MV3 service worker, so it cannot be an ES module and is not type-checked: `allowJs` stays false).
 *
 * Each `startServiceWorker()` evaluates the script in a fresh `node:vm` context, exactly like Chrome
 * starting the extension's service worker again: module state, timers and caches are new, while
 * `chrome.storage.local` and the alarms (owned by the fake browser) carry over. `terminate()` drops
 * every listener the instance registered, as Chrome does to an idle MV3 worker.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createFakeChrome, fakeClock, flushEvents, type FakeChrome, type FakeClock } from './fake-chrome';
import { REPO_ROOT } from './spawn';

export const BRIDGE_SOURCE_PATH = path.join(REPO_ROOT, 'extension-bridge', 'saas-sync.js');

export type FieldMap = Record<string, string[]>;

export type BridgeConfig = {
  saasOrigin: string;
  token: string;
  vendorKey: string;
  rowsPath: string;
  authPath: string;
  rowKeyField: string;
  cidField: string;
  keywordField: string;
  fieldMap: FieldMap;
  settleSeconds: number;
  enabled: boolean;
};

export type LedgerEntry = {
  recordId: string;
  hash: string;
  state: 'pending' | 'queued' | 'sent' | 'rejected' | 'failed';
  batchId: string | null;
  firstSeenAt: number;
  changedAt: number;
  sentAt: number | null;
  reasonCode: string | null;
  changedAfterSend?: boolean;
};

export type QueueEntry = {
  batchId: string;
  body: string;
  rowKeys: string[];
  recordIds: string[];
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  lastError: { code: string | null; httpStatus: number | null; at: number } | null;
};

export type FailedBatch = { batchId: string; rowKeys: string[]; recordCount: number; code: string | null; httpStatus: number | null; failedAt: number };

export type BridgeStatus = {
  state: 'idle' | 'waiting' | 'syncing' | 'retrying' | 'paused_auth' | 'paused_forbidden' | 'not_configured' | 'unlicensed' | 'disabled';
  message: string;
  licensed: boolean | null;
  queuedBatches: number;
  pendingRows: number;
  failedBatches: number;
  sentRows: number;
  rowsWithoutKey: number;
  lastSyncAt: number | null;
  nextAttemptAt: number | null;
  lastError: { code: string | null; httpStatus: number | null; at: number } | null;
  tokenFingerprint: string | null;
  updatedAt: number;
};

export type BridgeKeys = { config: string; ledger: string; pending: string; queue: string; failed: string; status: string };

export type BridgeDeps = {
  chrome: FakeChrome;
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>;
  now: () => number;
  randomUUID?: () => string;
  random?: () => number;
};

export type BridgeInstance = {
  /** Resolves when every queued operation (scan, flush, send) has finished. */
  whenIdle(): Promise<void>;
  /** Scan the vendor rows, flush settled rows into batches and send what is due. */
  tick(reason?: string): Promise<void>;
  status(): Promise<BridgeStatus>;
};

export type AuraLeadSyncModule = {
  VERSION: string;
  KEYS: BridgeKeys;
  ALARM_NAME: string;
  ENDPOINT_PATH: string;
  DEFAULT_CONFIG: BridgeConfig;
  MAX_RECORDS_PER_BATCH: number;
  BACKOFF_BASE_MS: number;
  BACKOFF_CAP_MS: number;
  UNLICENSED_MESSAGE: string;
  install(deps: BridgeDeps): BridgeInstance;
  normalizeOrigin(value: string): string | null;
  backoffDelayMs(attempt: number, random?: () => number): number;
};

let cachedSource: string | null = null;
function bridgeSource(): string {
  cachedSource ??= fs.readFileSync(BRIDGE_SOURCE_PATH, 'utf8');
  return cachedSource;
}

/** Evaluates saas-sync.js in a fresh context and returns what it put on `globalThis.AuraLeadSync`. */
export function loadBridgeModule(extraGlobals: Record<string, unknown> = {}): { module: AuraLeadSyncModule; context: vm.Context } {
  const sandbox: Record<string, unknown> = {
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    TextEncoder,
    URL,
    crypto: globalThis.crypto,
    ...extraGlobals,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(bridgeSource(), context, { filename: BRIDGE_SOURCE_PATH });
  const api = (context as { AuraLeadSync?: AuraLeadSyncModule }).AuraLeadSync;
  if (!api) throw new Error('saas-sync.js did not define globalThis.AuraLeadSync');
  return { module: api, context };
}

export const VENDOR_KEY = 'Google_Map_Extractor_local_default';
export const TEST_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

export type BridgeEnv = {
  chrome: FakeChrome;
  clock: FakeClock;
  module: AuraLeadSyncModule;
  bridge: BridgeInstance;
  /** Simulates Chrome terminating the idle service worker, then starting it again. */
  restart(): Promise<BridgeInstance>;
  terminate(): void;
  start(): BridgeInstance;
  /** The vendor extension saving its whole local blob (collect rows plus `_auth`). */
  vendorSave(blob: Record<string, unknown>): Promise<void>;
  configure(config: Partial<BridgeConfig>): Promise<void>;
  /** Advances the clock, fires due alarms and waits for the bridge to settle. */
  advance(ms: number): Promise<void>;
  settle(): Promise<void>;
  ledger(): Record<string, LedgerEntry>;
  queue(): QueueEntry[];
  failed(): FailedBatch[];
  status(): BridgeStatus | undefined;
  setFetch(fetch: BridgeDeps['fetch']): void;
};

export function createBridgeEnv(options: { start?: number; fetch?: BridgeDeps['fetch']; randomUUID?: () => string } = {}): BridgeEnv {
  const clock = fakeClock(options.start ?? Date.parse('2026-10-20T06:00:00.000Z'));
  const chrome = createFakeChrome({ clock, extensionId: TEST_EXTENSION_ID });
  let currentFetch: BridgeDeps['fetch'] =
    options.fetch ??
    (async () => {
      throw new TypeError('Failed to fetch');
    });
  let uuidSeq = 0;
  const randomUUID = options.randomUUID ?? (() => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`);
  const { module } = loadBridgeModule();

  const start = (): BridgeInstance => {
    // A fresh evaluation per start: nothing in memory survives a service-worker restart.
    const fresh = loadBridgeModule().module;
    return fresh.install({ chrome, fetch: (url, init) => currentFetch(url, init), now: () => clock.now(), randomUUID, random: () => 0 });
  };

  const env: BridgeEnv = {
    chrome,
    clock,
    module,
    bridge: undefined as unknown as BridgeInstance,
    start: () => {
      env.bridge = start();
      return env.bridge;
    },
    terminate: () => chrome.terminateServiceWorker(),
    restart: async () => {
      await env.settle();
      chrome.terminateServiceWorker();
      env.bridge = start();
      await env.settle();
      return env.bridge;
    },
    vendorSave: async (blob) => {
      chrome.storage.local.vendorSet({ [VENDOR_KEY]: blob });
      await env.settle();
    },
    configure: async (config) => {
      const key = module.KEYS.config;
      const current = (chrome.storage.local.peek<Record<string, unknown>>(key) ?? {}) as Record<string, unknown>;
      chrome.storage.local.vendorSet({ [key]: { ...current, ...config } }, 'options');
      await env.settle();
    },
    advance: async (ms) => {
      clock.advance(ms);
      chrome.alarms.fireDue();
      await env.settle();
    },
    settle: async () => {
      for (let i = 0; i < 5; i += 1) {
        await flushEvents();
        if (env.bridge) await env.bridge.whenIdle();
      }
    },
    ledger: () => chrome.storage.local.peek<Record<string, LedgerEntry>>(module.KEYS.ledger) ?? {},
    queue: () => chrome.storage.local.peek<QueueEntry[]>(module.KEYS.queue) ?? [],
    failed: () => chrome.storage.local.peek<FailedBatch[]>(module.KEYS.failed) ?? [],
    status: () => chrome.storage.local.peek<BridgeStatus>(module.KEYS.status),
    setFetch: (fetch) => {
      currentFetch = fetch;
    },
  };
  return env;
}

export type CapturedRequest = { url: string; headers: Record<string, string>; body: string; json: { version: number; batchId: string; keyword?: string; records: Array<Record<string, unknown>> } };

/** A fake SaaS endpoint: records every request and answers with `respond` (default 202 all QUEUED). */
export function fakeServer(respond?: (request: CapturedRequest, n: number) => Response | Promise<Response>) {
  const requests: CapturedRequest[] = [];
  const fetch: BridgeDeps['fetch'] = async (url, init) => {
    const captured: CapturedRequest = { url, headers: { ...init.headers }, body: init.body, json: JSON.parse(init.body) as CapturedRequest['json'] };
    requests.push(captured);
    if (respond) return respond(captured, requests.length);
    return accepted(captured);
  };
  return { requests, fetch };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** What the real endpoint answers for a fresh batch with no intake rejections. */
export function accepted(request: CapturedRequest): Response {
  const records = request.json.records.map((r, index) => ({ index, recordId: r.recordId, status: 'QUEUED', reasonCode: null }));
  return jsonResponse(202, { batchId: request.json.batchId, outcome: 'ACCEPTED', status: 'RECEIVED', received: records.length, queued: records.length, rejected: 0, records });
}

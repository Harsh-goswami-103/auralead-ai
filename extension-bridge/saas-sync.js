/*
 * AuraLead sync bridge for the Google_Map_Extractor Chrome extension (Manifest V3).
 *
 * What it does: rows the extension extracts are saved by the extension under its own key in
 * chrome.storage.local (default `Google_Map_Extractor_local_default`, field `collect`). This
 * script, loaded once into the extension's service worker with `importScripts`, watches that key
 * through `chrome.storage.onChanged`, finds rows whose `row_key` it has not seen (its own ledger),
 * waits until a row has stopped changing (settle window), packs settled rows into batches of at
 * most 200 records per search keyword, stores each batch durably in its own queue, and posts it to
 * AuraLead's /api/webhooks/gmaps-extension with the workspace's Bearer token. Failed sends are
 * retried with exponential backoff through `chrome.alarms` (capped at 30 minutes); after the
 * service worker is terminated and started again it resumes from storage with the same batch ids,
 * so the server deduplicates every retry.
 *
 * What it never does: write, remove or clear the extension's own key (the extension rewrites that
 * whole blob on every save, so a second writer would lose rows), send anything while the
 * extension's licence check (`_auth.hasValidKey`) is not exactly `true`, read the licence value
 * itself, control the browser, or talk to any host but the configured AuraLead origin.
 *
 * Copy-agnostic: the storage key, the rows path and the field names are configuration
 * (options.html), because the vendor's row format is not documented. This file contains no vendor
 * code. It is a classic script (importScripts cannot load ES modules and MV3 service workers do
 * not allow dynamic import); `globalThis.AuraLeadSync` is its only global, and it starts itself only
 * inside a service worker, so the options page can load it for its helpers.
 */
(function bridge(root) {
  'use strict';

  const VERSION = '1.0.0';
  const KEYS = Object.freeze({
    config: 'auralead_sync_config',
    ledger: 'auralead_sync_ledger',
    pending: 'auralead_sync_pending',
    queue: 'auralead_sync_queue',
    failed: 'auralead_sync_failed',
    status: 'auralead_sync_status',
  });
  const ALARM_NAME = 'auralead-sync';
  const ENDPOINT_PATH = '/api/webhooks/gmaps-extension';
  const MAX_RECORDS_PER_BATCH = 200;
  /** The server accepts 1 MiB; batches are cut well below it. */
  const MAX_BATCH_BYTES = 900000;
  const BACKOFF_BASE_MS = 60 * 1000;
  const BACKOFF_CAP_MS = 30 * 60 * 1000;
  const REQUEST_TIMEOUT_MS = 30 * 1000;
  const FAILED_KEEP = 50;
  const UNLICENSED_MESSAGE = 'Extension not licensed: sync disabled';

  const DEFAULT_CONFIG = Object.freeze({
    saasOrigin: 'http://localhost:3000',
    token: '',
    vendorKey: 'Google_Map_Extractor_local_default',
    rowsPath: 'collect',
    authPath: '_auth',
    rowKeyField: 'row_key',
    cidField: 'cid',
    keywordField: 'keyword',
    /** Target field -> candidate row keys, first non-empty wins. Adjust in the options page. */
    fieldMap: Object.freeze({
      name: ['name', 'title', 'business_name'],
      phone: ['phone', 'phone_number', 'phoneNumber', 'phones'],
      email: ['email', 'emails'],
      website: ['website', 'site'],
      address: ['address', 'full_address'],
      city: ['city'],
      category: ['category', 'categories', 'type'],
      rating: ['rating', 'stars'],
      reviewCount: ['reviews', 'review_count', 'reviewCount'],
      placeId: ['place_id', 'placeId'],
    }),
    settleSeconds: 60,
    enabled: true,
  });

  const TEXT_FIELDS = ['name', 'phone', 'website', 'address', 'city', 'category'];

  // ---- pure helpers ------------------------------------------------------------------------------

  /** `https://host[:port]` for an http(s) URL without credentials, else null. */
  function normalizeOrigin(value) {
    if (typeof value !== 'string' || value.trim() === '') return null;
    let url;
    try {
      url = new URL(value.trim());
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  }

  function backoffDelayMs(attempt, random) {
    const n = Math.max(1, Math.floor(attempt));
    const raw = Math.min(BACKOFF_BASE_MS * Math.pow(2, Math.min(n - 1, 20)), BACKOFF_CAP_MS);
    const jitter = typeof random === 'function' ? random() : 0;
    return Math.round(raw * (1 - 0.1 * Math.min(Math.max(jitter, 0), 1)));
  }

  /** cyrb53: a fast 53-bit string hash (change detection only, not security). */
  function hashText(text) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  }

  function stableJson(value) {
    if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
    if (value !== null && typeof value === 'object') {
      return '{' + Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  function getPath(object, path) {
    if (!path) return object;
    let current = object;
    for (const part of String(path).split('.')) {
      if (current === null || typeof current !== 'object') return undefined;
      current = current[part];
    }
    return current;
  }

  function idOf(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string' && value.trim() !== '' && value.trim().length <= 256) return value.trim();
    return null;
  }

  function firstValue(row, candidates) {
    for (const key of candidates || []) {
      const value = row[key];
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value) && value.length === 0) continue;
      return value;
    }
    return null;
  }

  function asText(value) {
    if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) {
      const parts = value.map(asText).filter((v) => v !== null);
      return parts.length > 0 ? parts.join(', ') : null;
    }
    return null;
  }

  /** The first address-looking value; an email is never made up from anything else. */
  function asEmail(value) {
    const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,;]+/) : [];
    for (const item of list) {
      if (typeof item === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.trim())) return item.trim();
    }
    return null;
  }

  function asNumberish(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && value.trim().length <= 40) return value.trim();
    return null;
  }

  function mergeConfig(stored) {
    const s = stored && typeof stored === 'object' ? stored : {};
    const fieldMap = Object.assign({}, DEFAULT_CONFIG.fieldMap, s.fieldMap && typeof s.fieldMap === 'object' ? s.fieldMap : {});
    const settle = Number(s.settleSeconds);
    return Object.assign({}, DEFAULT_CONFIG, s, {
      fieldMap,
      saasOrigin: normalizeOrigin(s.saasOrigin === undefined ? DEFAULT_CONFIG.saasOrigin : s.saasOrigin),
      token: typeof s.token === 'string' ? s.token.trim() : '',
      settleSeconds: Number.isFinite(settle) ? Math.min(Math.max(Math.round(settle), 0), 600) : DEFAULT_CONFIG.settleSeconds,
      enabled: s.enabled !== false,
    });
  }

  /** A vendor row as a v1 batch record (null fields left out); null without a row key. */
  function mapRow(row, config) {
    if (!row || typeof row !== 'object') return null;
    const rowKey = idOf(row[config.rowKeyField]);
    if (rowKey === null) return null;
    const cid = idOf(row[config.cidField]);
    const record = { recordId: cid !== null ? cid : rowKey };
    const map = config.fieldMap;
    for (const field of TEXT_FIELDS) {
      const value = asText(firstValue(row, map[field]));
      if (value !== null) record[field] = value;
    }
    const email = asEmail(firstValue(row, map.email));
    if (email !== null) record.email = email;
    const rating = asNumberish(firstValue(row, map.rating));
    if (rating !== null) record.rating = rating;
    const reviews = asNumberish(firstValue(row, map.reviewCount));
    if (reviews !== null) record.reviewCount = reviews;
    const placeId = idOf(firstValue(row, map.placeId));
    if (placeId !== null) record.placeId = placeId;
    const keyword = asText(row[config.keywordField]);
    return { rowKey, record, keyword: keyword === null ? '' : keyword.slice(0, 200) };
  }

  function licensed(blob, config) {
    const auth = getPath(blob, config.authPath);
    return Boolean(auth && typeof auth === 'object' && auth.hasValidKey === true);
  }

  function statusMessageFor(code) {
    if (code === 'token_revoked') return 'Token revoked: create a new token in the AuraLead Extension hub and save it here. Queued batches wait.';
    if (code === 'token_expired') return 'Token expired: create a new token in the AuraLead Extension hub and save it here. Queued batches wait.';
    return 'Token not accepted: check the token in the options page (create a new one in the AuraLead Extension hub). Queued batches wait.';
  }

  // ---- the bridge -----------------------------------------------------------------------------------

  function install(deps) {
    const chrome = deps.chrome;
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    const random = typeof deps.random === 'function' ? deps.random : Math.random;
    const uuid = typeof deps.randomUUID === 'function' ? deps.randomUUID : () => root.crypto.randomUUID();
    const doFetch = deps.fetch;
    const storage = chrome.storage.local;

    let chain = Promise.resolve();
    let pendingTicks = 0;

    /** Runs operations one at a time: every read-modify-write of the bridge's keys is serialized. */
    function serialize(fn) {
      pendingTicks += 1;
      const run = chain.then(fn).catch((error) => {
        if (root.console) root.console.warn('[auralead-sync]', error && error.message ? error.message : error);
      });
      chain = run.then(() => {
        pendingTicks -= 1;
      });
      return chain;
    }

    async function read() {
      const got = await storage.get([KEYS.config, KEYS.ledger, KEYS.pending, KEYS.queue, KEYS.failed, KEYS.status]);
      return {
        config: mergeConfig(got[KEYS.config]),
        ledger: got[KEYS.ledger] && typeof got[KEYS.ledger] === 'object' ? got[KEYS.ledger] : {},
        pending: got[KEYS.pending] && typeof got[KEYS.pending] === 'object' ? got[KEYS.pending] : {},
        queue: Array.isArray(got[KEYS.queue]) ? got[KEYS.queue] : [],
        failed: Array.isArray(got[KEYS.failed]) ? got[KEYS.failed] : [],
        status: got[KEYS.status] && typeof got[KEYS.status] === 'object' ? got[KEYS.status] : {},
      };
    }

    async function vendorBlob(config) {
      const got = await storage.get(config.vendorKey);
      return got[config.vendorKey];
    }

    function counts(state) {
      let sent = 0;
      for (const key of Object.keys(state.ledger)) if (state.ledger[key].state === 'sent') sent += 1;
      return { queuedBatches: state.queue.length, pendingRows: Object.keys(state.pending).length, failedBatches: state.failed.length, sentRows: sent };
    }

    function buildStatus(state, patch) {
      const previous = state.status || {};
      return Object.assign(
        {
          state: 'idle',
          message: 'Up to date.',
          licensed: previous.licensed === undefined ? null : previous.licensed,
          rowsWithoutKey: previous.rowsWithoutKey || 0,
          lastSyncAt: previous.lastSyncAt || null,
          nextAttemptAt: null,
          lastError: previous.lastError || null,
          tokenFingerprint: previous.tokenFingerprint || null,
          version: VERSION,
        },
        counts(state),
        patch,
        { updatedAt: now() },
      );
    }

    function tokenFingerprint(config) {
      return config.token ? hashText('token:' + config.token) : null;
    }

    /** Diff the vendor rows against the ledger by row key; new rows become pending (settling). */
    function scan(state, blob, at) {
      const rows = getPath(blob, state.config.rowsPath);
      let changed = false;
      let withoutKey = 0;
      // "Clear" (an empty or missing list) is a no-op: nothing is deleted or forgotten.
      if (!Array.isArray(rows)) return { changed, withoutKey: state.status.rowsWithoutKey || 0 };
      for (const row of rows) {
        const mapped = mapRow(row, state.config);
        if (mapped === null) {
          withoutKey += 1;
          continue;
        }
        const hash = hashText(stableJson({ record: mapped.record, keyword: mapped.keyword }));
        const entry = state.ledger[mapped.rowKey];
        if (!entry) {
          state.ledger[mapped.rowKey] = { recordId: mapped.record.recordId, hash, state: 'pending', batchId: null, firstSeenAt: at, changedAt: at, sentAt: null, reasonCode: null };
          state.pending[mapped.rowKey] = { record: Object.assign({}, mapped.record, { extractedAt: new Date(at).toISOString() }), keyword: mapped.keyword };
          changed = true;
        } else if (entry.hash !== hash) {
          entry.hash = hash;
          if (entry.state === 'pending' && state.pending[mapped.rowKey]) {
            // Keep the record id and the extraction time of the first sighting.
            const first = state.pending[mapped.rowKey].record;
            state.pending[mapped.rowKey] = { record: Object.assign({}, mapped.record, { recordId: entry.recordId, extractedAt: first.extractedAt }), keyword: mapped.keyword };
            entry.changedAt = at;
          } else {
            // Already batched or sent: the server never updates a lead from a re-sent record.
            entry.changedAfterSend = true;
          }
          changed = true;
        }
      }
      return { changed, withoutKey };
    }

    /** Settled pending rows -> durable batches (per keyword, at most 200 records and ~900 KB). */
    function flush(state, at) {
      const settleMs = state.config.settleSeconds * 1000;
      const groups = new Map();
      for (const rowKey of Object.keys(state.pending)) {
        const entry = state.ledger[rowKey];
        if (!entry || entry.changedAt > at - settleMs) continue;
        const item = state.pending[rowKey];
        if (!groups.has(item.keyword)) groups.set(item.keyword, []);
        groups.get(item.keyword).push({ rowKey, record: item.record });
      }
      let made = 0;
      for (const [keyword, items] of groups) {
        let batch = null;
        const close = () => {
          if (!batch || batch.records.length === 0) return;
          const body = JSON.stringify(Object.assign({ version: 1, batchId: batch.batchId }, keyword ? { keyword } : {}, { records: batch.records }));
          state.queue.push({ batchId: batch.batchId, body, rowKeys: batch.rowKeys, recordIds: batch.records.map((r) => r.recordId), attempts: 0, nextAttemptAt: at, createdAt: at, lastError: null });
          made += 1;
          batch = null;
        };
        for (const item of items) {
          const size = JSON.stringify(item.record).length + 1;
          if (batch && (batch.records.length >= MAX_RECORDS_PER_BATCH || batch.bytes + size > MAX_BATCH_BYTES)) close();
          if (!batch) batch = { batchId: uuid(), records: [], rowKeys: [], ids: new Set(), bytes: 200 };
          const entry = state.ledger[item.rowKey];
          entry.state = 'queued';
          entry.batchId = batch.batchId;
          delete state.pending[item.rowKey];
          batch.rowKeys.push(item.rowKey);
          if (batch.ids.has(item.record.recordId)) continue; // the same place under two row keys: one record
          batch.ids.add(item.record.recordId);
          batch.records.push(item.record);
          batch.bytes += size;
        }
        close();
      }
      return made;
    }

    function markRows(state, entry, patch) {
      for (const rowKey of entry.rowKeys) {
        const ledgerEntry = state.ledger[rowKey];
        if (ledgerEntry) Object.assign(ledgerEntry, patch);
      }
    }

    async function save(state, statusPatch) {
      state.status = buildStatus(state, statusPatch);
      await storage.set({
        [KEYS.ledger]: state.ledger,
        [KEYS.pending]: state.pending,
        [KEYS.queue]: state.queue,
        [KEYS.failed]: state.failed,
        [KEYS.status]: state.status,
      });
    }

    async function scheduleAlarm(state) {
      let next = null;
      if (state.queue.length > 0) next = state.queue[0].nextAttemptAt;
      const settleMs = state.config.settleSeconds * 1000;
      for (const rowKey of Object.keys(state.pending)) {
        const entry = state.ledger[rowKey];
        if (!entry) continue;
        const due = entry.changedAt + settleMs;
        if (next === null || due < next) next = due;
      }
      if (next === null) {
        await chrome.alarms.clear(ALARM_NAME);
        return null;
      }
      await chrome.alarms.create(ALARM_NAME, { when: Math.max(next, now() + 1000) });
      return next;
    }

    async function post(config, entry) {
      const controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
      const timer = controller ? root.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
      try {
        const init = { method: 'POST', headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' }, body: entry.body };
        if (controller) init.signal = controller.signal;
        const res = await doFetch(config.saasOrigin + ENDPOINT_PATH, init);
        let body = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        const retryAfter = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
        return { status: res.status, body, retryAfter };
      } finally {
        if (timer !== null) root.clearTimeout(timer);
      }
    }

    /** Sends due batches in order; stops at the first transient failure or a pause. */
    async function send(state) {
      const config = state.config;
      const fingerprint = tokenFingerprint(config);
      let outcome = null;
      while (state.queue.length > 0) {
        const entry = state.queue[0];
        const at = now();
        if (entry.nextAttemptAt > at) break;
        let answer;
        try {
          answer = await post(config, entry);
        } catch {
          entry.attempts += 1;
          entry.nextAttemptAt = now() + backoffDelayMs(entry.attempts, random);
          entry.lastError = { code: 'NETWORK', httpStatus: null, at: now() };
          outcome = { state: 'retrying', message: 'Network error; retrying (attempt ' + entry.attempts + ').', lastError: entry.lastError };
          await save(state, outcome);
          break;
        }
        const code = answer.body && typeof answer.body.code === 'string' ? answer.body.code : null;
        const doneAt = now();
        if (answer.status >= 200 && answer.status < 300) {
          state.queue.shift();
          markRows(state, entry, { state: 'sent', sentAt: doneAt, reasonCode: null });
          const records = answer.body && Array.isArray(answer.body.records) ? answer.body.records : [];
          for (const result of records) {
            if (!result || (result.status !== 'REJECTED' && result.status !== 'FAILED')) continue;
            for (const rowKey of entry.rowKeys) {
              const ledgerEntry = state.ledger[rowKey];
              if (ledgerEntry && ledgerEntry.recordId === result.recordId) Object.assign(ledgerEntry, { state: 'rejected', reasonCode: typeof result.reasonCode === 'string' ? result.reasonCode : null });
            }
          }
          outcome = { state: 'idle', message: 'Up to date.', lastSyncAt: doneAt, lastError: null };
          await save(state, outcome);
          continue;
        }
        entry.lastError = { code, httpStatus: answer.status, at: doneAt };
        if (answer.status === 401) {
          outcome = { state: 'paused_auth', message: statusMessageFor(code), lastError: entry.lastError, tokenFingerprint: fingerprint };
          await save(state, outcome);
          return outcome;
        }
        if (answer.status === 403) {
          outcome = {
            state: 'paused_forbidden',
            message: 'Refused by AuraLead (' + (code || 'forbidden') + '): check the allowed extension id of this token in the Extension hub, then save the options again.',
            lastError: entry.lastError,
            tokenFingerprint: fingerprint,
          };
          await save(state, outcome);
          return outcome;
        }
        if (answer.status === 429 || answer.status >= 500) {
          entry.attempts += 1;
          const seconds = Number(answer.retryAfter);
          const delay = answer.status === 429 && Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, BACKOFF_CAP_MS) : backoffDelayMs(entry.attempts, random);
          entry.nextAttemptAt = doneAt + delay;
          outcome = { state: 'retrying', message: 'AuraLead answered ' + answer.status + '; retrying in ' + Math.round(delay / 60000) + ' min.', lastError: entry.lastError };
          await save(state, outcome);
          break;
        }
        // Any other answer (400, 409, 413, 422, ...) is permanent for this batch: resending the
        // same bytes cannot succeed. It is kept (ids only) for the options page; the next goes.
        state.queue.shift();
        markRows(state, entry, { state: 'failed', reasonCode: code });
        state.failed.push({ batchId: entry.batchId, rowKeys: entry.rowKeys, recordCount: entry.recordIds.length, code, httpStatus: answer.status, failedAt: doneAt });
        if (state.failed.length > FAILED_KEEP) state.failed.splice(0, state.failed.length - FAILED_KEEP);
        outcome = { state: 'idle', message: 'A batch was refused (' + (code || answer.status) + '); see failed batches.', lastError: entry.lastError };
        await save(state, outcome);
      }
      return outcome;
    }

    /** One full pass: licence, scan, flush, send, schedule. */
    async function tick() {
      const state = await read();
      const at = now();
      const config = state.config;
      if (!config.enabled) {
        await save(state, { state: 'disabled', message: 'Sync is switched off in the options page.' });
        await chrome.alarms.clear(ALARM_NAME);
        return;
      }
      const blob = await vendorBlob(config);
      if (!licensed(blob, config)) {
        // Licence gate: no scan, no ledger, no sending while the extension is not licensed.
        await save(state, { state: 'unlicensed', message: UNLICENSED_MESSAGE, licensed: false });
        return;
      }
      const scanned = scan(state, blob, at);
      const patch = { licensed: true, rowsWithoutKey: scanned.withoutKey };
      if (!config.saasOrigin || !config.token) {
        await save(state, Object.assign(patch, { state: 'not_configured', message: 'Not configured: enter the AuraLead URL and an ingestion token in the options page.' }));
        await scheduleAlarm(Object.assign({}, state, { pending: {} }));
        return;
      }
      flush(state, at);
      const fingerprint = tokenFingerprint(config);
      const previous = state.status;
      if ((previous.state === 'paused_auth' || previous.state === 'paused_forbidden') && previous.tokenFingerprint === fingerprint) {
        // Paused by a 401/403 for this very token: batches wait until the configuration changes.
        await save(state, Object.assign(patch, { state: previous.state, message: previous.message, tokenFingerprint: fingerprint }));
        await chrome.alarms.clear(ALARM_NAME);
        return;
      }
      await save(state, Object.assign({}, patch, { state: 'syncing', message: 'Sending.' }));
      const outcome = await send(state);
      if (outcome && (outcome.state === 'paused_auth' || outcome.state === 'paused_forbidden')) {
        await chrome.alarms.clear(ALARM_NAME);
        return;
      }
      const next = await scheduleAlarm(state);
      let final;
      if (state.queue.length > 0) {
        final = outcome && outcome.state === 'retrying' ? { state: 'retrying', message: outcome.message } : { state: 'retrying', message: 'Waiting to retry a batch.' };
      } else if (Object.keys(state.pending).length > 0) {
        final = { state: 'waiting', message: 'Waiting for new rows to settle.' };
      } else {
        final = { state: 'idle', message: state.failed.length > 0 ? 'Up to date; some batches were refused (see failed batches).' : 'Up to date.' };
      }
      await save(state, Object.assign(patch, final, { nextAttemptAt: next }));
    }

    function requestTick() {
      return serialize(tick);
    }

    function onStorageChanged(changes, areaName) {
      if (areaName !== 'local' || !changes) return;
      const keys = Object.keys(changes);
      // The bridge's own state keys never trigger work, except the configuration (options page).
      if (keys.includes(KEYS.config)) {
        void serialize(async () => {
          const got = await storage.get(KEYS.status);
          const status = got[KEYS.status];
          if (status && (status.state === 'paused_auth' || status.state === 'paused_forbidden')) {
            // A saved configuration (a new token, a fixed extension id) lifts the pause.
            await storage.set({ [KEYS.status]: Object.assign({}, status, { state: 'idle', message: 'Configuration saved; retrying.', tokenFingerprint: null }) });
          }
        });
        void requestTick();
        return;
      }
      if (keys.some((k) => !k.startsWith('auralead_sync_'))) void requestTick();
    }

    function onAlarm(alarm) {
      if (alarm && alarm.name === ALARM_NAME) void requestTick();
    }

    function onMessage(message, _sender, sendResponse) {
      if (!message || typeof message !== 'object' || message.type !== 'auralead-sync:sync-now') return false;
      void serialize(async () => {
        const got = await storage.get(KEYS.queue);
        const queue = Array.isArray(got[KEYS.queue]) ? got[KEYS.queue] : [];
        for (const entry of queue) entry.nextAttemptAt = Math.min(entry.nextAttemptAt, now());
        await storage.set({ [KEYS.queue]: queue });
      });
      void requestTick().then(() => sendResponse({ ok: true }));
      return true;
    }

    // MV3: listeners are registered synchronously while the service worker script is evaluated.
    chrome.storage.onChanged.addListener(onStorageChanged);
    chrome.alarms.onAlarm.addListener(onAlarm);
    if (chrome.runtime && chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(() => void requestTick());
    if (chrome.runtime && chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener(() => void requestTick());
    if (chrome.runtime && chrome.runtime.onMessage) chrome.runtime.onMessage.addListener(onMessage);
    // Resume on every service-worker start: queued batches keep their batch ids.
    void requestTick();

    return {
      whenIdle: async () => {
        while (pendingTicks > 0) await chain;
      },
      tick: () => requestTick(),
      status: async () => (await storage.get(KEYS.status))[KEYS.status],
    };
  }

  const api = Object.freeze({
    VERSION,
    KEYS,
    ALARM_NAME,
    ENDPOINT_PATH,
    DEFAULT_CONFIG,
    MAX_RECORDS_PER_BATCH,
    BACKOFF_BASE_MS,
    BACKOFF_CAP_MS,
    UNLICENSED_MESSAGE,
    install,
    normalizeOrigin,
    backoffDelayMs,
    mergeConfig,
  });
  root.AuraLeadSync = api;

  // Start only inside the extension's service worker (never on the options page).
  const isServiceWorker = typeof root.ServiceWorkerGlobalScope === 'function' && root instanceof root.ServiceWorkerGlobalScope;
  if (isServiceWorker && root.chrome && root.chrome.storage && typeof root.fetch === 'function') {
    install({ chrome: root.chrome, fetch: root.fetch.bind(root), now: () => Date.now() });
  }
})(globalThis);

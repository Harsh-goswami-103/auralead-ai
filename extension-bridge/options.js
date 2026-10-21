/*
 * Options page of the AuraLead sync bridge (ES module). It reads and writes only the bridge's own
 * keys in chrome.storage.local (`auralead_sync_config`; the status is read-only here). Saving
 * requests the host permission for the one AuraLead origin entered (optional_host_permissions),
 * stores the token in extension storage only and never displays it again. The service worker
 * notices the saved configuration through chrome.storage.onChanged and resumes sending.
 */
const sync = globalThis.AuraLeadSync;
const { KEYS, DEFAULT_CONFIG } = sync;

const $ = (id) => document.getElementById(id);
const form = $('form');
const notice = $('notice');

function describe(status) {
  if (!status) return 'No activity yet.';
  const parts = [status.message];
  parts.push(`Queued batches: ${status.queuedBatches ?? 0}. Rows settling: ${status.pendingRows ?? 0}. Rows sent: ${status.sentRows ?? 0}.`);
  if (status.lastSyncAt) parts.push(`Last sync: ${new Date(status.lastSyncAt).toLocaleString()}.`);
  if (status.nextAttemptAt && status.state === 'retrying') parts.push(`Next attempt: ${new Date(status.nextAttemptAt).toLocaleString()}.`);
  if (status.lastError && status.lastError.code) parts.push(`Last error: ${status.lastError.code}${status.lastError.httpStatus ? ` (HTTP ${status.lastError.httpStatus})` : ''}.`);
  if (status.rowsWithoutKey) parts.push(`Rows without a row key (skipped): ${status.rowsWithoutKey}.`);
  return parts.join(' ');
}

async function render() {
  const got = await chrome.storage.local.get([KEYS.config, KEYS.status, KEYS.failed]);
  const config = sync.mergeConfig(got[KEYS.config]);
  $('saasOrigin').value = config.saasOrigin ?? '';
  $('token').value = '';
  $('token').placeholder = config.token ? `Saved (${config.token.slice(0, 20)}...)` : 'alx_...';
  $('vendorKey').value = config.vendorKey;
  $('rowsPath').value = config.rowsPath;
  $('settleSeconds').value = String(config.settleSeconds);
  $('fieldMap').value = JSON.stringify(config.fieldMap, null, 2);
  $('enabled').checked = config.enabled;
  $('extension-id').value = chrome.runtime.id;
  $('status').textContent = describe(got[KEYS.status]);
  const failed = $('failed');
  failed.replaceChildren();
  for (const batch of got[KEYS.failed] ?? []) {
    const li = document.createElement('li');
    li.textContent = `${new Date(batch.failedAt).toLocaleString()}: batch ${batch.batchId}, ${batch.recordCount} records, ${batch.code ?? 'HTTP ' + batch.httpStatus}`;
    failed.append(li);
  }
  if (failed.childElementCount === 0) {
    const li = document.createElement('li');
    li.textContent = 'None.';
    failed.append(li);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  notice.textContent = '';
  const origin = sync.normalizeOrigin($('saasOrigin').value);
  if (!origin) {
    notice.textContent = 'Enter the AuraLead address as http(s)://host, without a user name or password.';
    return;
  }
  const typed = $('token').value.trim();
  if (typed && !/^alx_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/.test(typed)) {
    notice.textContent = 'That is not an AuraLead ingestion token (it starts with alx_). Copy it again from the Extension hub.';
    return;
  }
  let fieldMap;
  try {
    fieldMap = JSON.parse($('fieldMap').value);
    if (!fieldMap || typeof fieldMap !== 'object' || Array.isArray(fieldMap)) throw new Error('not an object');
  } catch {
    notice.textContent = 'Field names must be a JSON object such as {"name": ["name", "title"]}.';
    return;
  }
  // Must run inside the click: Chrome only grants host permissions on a user gesture.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    notice.textContent = `Chrome did not grant access to ${origin}. Nothing was saved.`;
    return;
  }
  const current = (await chrome.storage.local.get(KEYS.config))[KEYS.config] ?? {};
  const settle = Number($('settleSeconds').value);
  await chrome.storage.local.set({
    [KEYS.config]: {
      ...current,
      saasOrigin: origin,
      token: typed || current.token || '',
      vendorKey: $('vendorKey').value.trim() || DEFAULT_CONFIG.vendorKey,
      rowsPath: $('rowsPath').value.trim() || DEFAULT_CONFIG.rowsPath,
      settleSeconds: Number.isFinite(settle) ? settle : DEFAULT_CONFIG.settleSeconds,
      fieldMap,
      enabled: $('enabled').checked,
    },
  });
  notice.textContent = 'Saved.';
  await render();
});

$('sync-now').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'auralead-sync:sync-now' });
  await render();
});

$('copy-id').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(chrome.runtime.id);
    notice.textContent = 'Extension id copied.';
  } catch {
    $('extension-id').select();
    notice.textContent = 'Copy failed: the id is selected, copy it with Ctrl+C.';
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[KEYS.status] || changes[KEYS.failed])) void render();
});

void render();

# Patch guide: adding the AuraLead bridge to Google_Map_Extractor

This guide changes **one line** of the extension's service worker and **three manifest keys**. It
does not touch extraction, licensing, login or any other vendor file, and no vendor code is
shipped with AuraLead (ADR-13). Use a copy of the extension you are licensed to use: the bridge
stays off ("Extension not licensed: sync disabled") unless the extension itself reports a valid
licence (`_auth.hasValidKey === true` in its storage).

Verification level: the bridge is **contract verified** (fake `chrome.*` tests against the real
AuraLead endpoint); it has **not** been run against a live install (plan section 13). The handoff
point and the storage key below come from the CEO security review's reading of the copy inspected on
2026-10-15 (`docs/reviews/ceo/03-security.md`, T19 (4)); check them against your copy.

## 1. Copy the folder

Copy this whole `extension-bridge/` folder into the extension's root folder (next to its
`manifest.json`), so that `extension-bridge/saas-sync.js` and `extension-bridge/options.html` are
inside the extension.

## 2. One line in the service worker

Open the file named by `background.service_worker` in `manifest.json` (in the inspected copy:
`controllers/background.js`) and add this line at the **top level** (not inside a function or an
event handler; MV3 only allows `importScripts` while the worker script first runs):

```js
importScripts(chrome.runtime.getURL('/extension-bridge/saas-sync.js'));
```

If the manifest declares `"type": "module"` for the background worker, `importScripts` does not
exist; add `import '/extension-bridge/saas-sync.js';` at the top of the worker instead (the bridge
is valid as a classic script and as a module).

## 3. Manifest keys

Merge these into `manifest.json` (also in `examples/manifest-additions.json`); keep everything
that is already there:

```json
{
  "permissions": ["alarms", "storage"],
  "optional_host_permissions": ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
  "options_page": "extension-bridge/options.html"
}
```

- `alarms`: retries and settle timers that survive the service worker being suspended.
- `storage`: the extension already uses it; listed so the bridge works on any copy.
- `optional_host_permissions`: nothing is granted at install. When you save the AuraLead URL in the
  options page, Chrome asks for that one origin only. (The inspected copy already requests
  `<all_urls>` for its own email scraping; the bridge adds no host permission of its own.)
- `options_page`: if the manifest already has `options_page` or `options_ui`, leave it and open
  `chrome-extension://<extension id>/extension-bridge/options.html` directly instead.

## 4. Reload and configure

1. `chrome://extensions` -> Developer mode -> Reload the extension (or Load unpacked).
2. In AuraLead: Employee panel -> your workspace -> **Maps extension** -> Create token. Copy the
   token (it is shown once) and the webhook URL's origin.
3. Open the bridge options page, enter the AuraLead URL and the token, Save (accept Chrome's
   permission prompt). Copy "This extension's id" back into the token's **Allowed extension id**
   in the Extension hub.
4. Extract as usual. New rows are sent after they have not changed for the settle time (60 s by
   default), in batches of at most 200 per search keyword. The hub's Batches table shows each
   batch, its per-record results and any refused requests.

## What the bridge reads and writes

| Storage key (chrome.storage.local) | Bridge access |
|---|---|
| `Google_Map_Extractor_local_default` (configurable) | Read only: the `collect` row list and `_auth.hasValidKey`. Never written, removed or cleared. The licence key itself is never read. |
| `auralead_sync_config` | Written by the options page: AuraLead origin, token, storage format. |
| `auralead_sync_ledger` | row_key -> record id, state, batch id, content hash (no contact data). |
| `auralead_sync_pending` | Rows still settling (contact data, until sent). |
| `auralead_sync_queue` | Batches waiting to be sent, with their exact bytes. |
| `auralead_sync_failed` | Batches the server refused permanently (ids and codes only). |
| `auralead_sync_status` | What the options page shows. |

The token sits in the extension's storage on this Chrome profile; any code running in the
extension (including the vendor's) can read it. A token can only add leads to one workspace and can
be revoked in the hub at any time; revoke it if the profile or the extension is no longer trusted.

## Row format

The vendor's row format is not documented. The review records only `row_key` (set by the
extension), `cid` (may be missing), `keyword` and `location`. Every other field name in the default
mapping is a guess: open DevTools on the extension's service worker, run
`chrome.storage.local.get('Google_Map_Extractor_local_default')`, look at one `collect` row and
adjust "Field names" in the options page (JSON: AuraLead field -> row keys to try, first non-empty
wins). The record id is `cid` when present, otherwise `row_key`; a row without `row_key` is skipped
and counted in the status.

## Limitations

- A row is sent once. If the extension changes it after it was sent (for example an email found
  later), the change is not sent again: AuraLead never updates a lead from a re-sent record. The
  settle time exists so late emails make the first send; raise it if your emails arrive later.
- Clearing the extension's list ("clear") does nothing to AuraLead or to the bridge's ledger.
- Only one email per row is sent (the first address-shaped value); AuraLead never invents one.

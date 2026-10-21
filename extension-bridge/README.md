# AuraLead extension bridge

A small MV3 helper that lets the Google_Map_Extractor Chrome extension sync the businesses it
extracts into one AuraLead workspace. No vendor code is in this folder (ADR-13).

| File | Purpose |
|---|---|
| `saas-sync.js` | The bridge. A classic script loaded into the extension's service worker with one `importScripts` line. Watches the extension's storage key, diffs rows by `row_key` against its own ledger, queues batches durably, posts them to `/api/webhooks/gmaps-extension` with the Bearer token, retries with `chrome.alarms` (1, 2, 4, ... minutes, capped at 30), resumes after the worker is suspended, and honours the extension's licence gate. |
| `options.html`, `options.js` | Options page: AuraLead URL, token (stored in `chrome.storage.local` only), this extension's id (to enter as the token's allowed extension id), storage format, status, refused batches, Sync now. |
| `PATCH-GUIDE.md` | The one-line service-worker hook, the manifest keys, setup steps, what is read and written. |
| `examples/` | A v1 batch, every server answer, the manifest additions. |

Contract: `POST <AuraLead origin>/api/webhooks/gmaps-extension`, `Authorization: Bearer alx_<keyId>_<secret>`,
JSON `{version: 1, batchId, keyword?, records[<=200]}`, each record
`{recordId, placeId?, name?, phone?, email?, website?, address?, city?, category?, rating?, reviewCount?, extractedAt?}`.
A retry sends the identical bytes with the same `batchId`; the server answers a replay with the
stored per-record results and refuses the same `batchId` with other content (409).

Tests (no Chrome, no network): `tests/integration/contract/extension-bridge.test.ts` and
`tests/integration/chaos/extension-bridge-chaos.test.ts`, with the fake `chrome.*` in
`tests/support/fake-chrome.ts` and the typed loader `tests/support/extension-bridge.ts`.
Status: contract verified; not run against a live extension install.

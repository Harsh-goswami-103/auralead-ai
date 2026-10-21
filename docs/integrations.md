# Integrations

One row per provider adapter, one section per provider. The matrix is parsed by `npm run verify` (P18): it prints every row and
checks that each evidence path cited in a *Live-verified* cell exists. Nothing is marked live-verified without evidence from a
user-authorized check against the real provider (plan section 13).

Column meanings:

- **Implemented**: the adapter, webhook or job exists and is wired into the registry.
- **Fixture-tested**: contract tests run the adapter against recorded or documented fixtures (no network).
- **Demo-verified**: the DEMO simulator exercises the same application services with zero outbound traffic.
- **Live-verified**: `<date> <evidence path>` once a person ran a check with real credentials; otherwise `No`.

## Status matrix

| Integration | Implemented | Fixture-tested | Demo-verified | Live-verified |
|---|---|---|---|---|
| WhatsApp Cloud API (send, templates, media) | Yes | Yes | Yes | No |
| WhatsApp quality rating and messaging limit | Yes | Yes | Yes | No |
| WhatsApp webhooks (inbound, statuses) | Yes | Yes | Yes | No |
| Meta Lead Ads webhook and lead fetch | No | No | Yes | No |
| Meta Marketing API (metrics, pause/resume) | No | No | Yes | No |
| Resend (email send, webhooks) | Demo transport only | No | Yes | No |
| SMTP (nodemailer) | No | No | Yes | No |
| Google Sheets and Apps Script | No | No | Yes | No |
| Google_Map_Extractor bridge (receiver, tokens, `extension-bridge/`) | Yes | Yes (contract and chaos tests, fake `chrome.*`) | Yes | No |
| Anthropic (drafts) | Yes | Yes | Yes | No |
| OpenAI (drafts) | Yes | Yes | Yes | No |
| Anthropic and OpenAI connection tests (Models API) | Yes | Yes | Yes | No |

## Documentation check log

Plan rule (PRD working method 9): before building a live adapter, check the current official provider documentation, record the
links, the API version and the date here, and mark everything not confirmed as UNVERIFIED. Each integration task appends its own
section below. A check made only through search-result snippets, or against a cached copy, says so.

Environment note, 2026-10-20: the build environment's network policy blocks the provider documentation hosts
(`developers.facebook.com`, `resend.com`, `developers.google.com`), so first-hand reads of those pages were not possible. Web search
returned snippets only. Every behaviour below that came from snippets, from the earlier dated `error-map.ts` review (2026-10-16) or
from memory is marked UNVERIFIED and must be re-checked against the live documentation before a production go-live.

### WhatsApp Cloud API (T32, checked 2026-10-20)

How the pages were read: **not first-hand**. `developers.facebook.com` is blocked by the build environment's network policy, so
the shapes below come from web-search snippets of Meta's pages and from third-party copies of them (360dialog, Kapso, Vonage,
chatarchitect). Every behaviour in this section is **UNVERIFIED** until a user-authorized live check produces evidence (plan
section 13). The fixtures in `tests/fixtures/whatsapp/documented-shape/` are documented-shape fixtures derived from these
snippets and the dated error map; none is recorded live traffic (`SOURCES.json` there lists each file's source).

Pages cited (not read first-hand):

- Messages reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
- Media reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media and
  https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media
- Template management: https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/
- Messaging limits: https://developers.facebook.com/docs/whatsapp/messaging-limits
- Status webhook reference: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status
- Error codes: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
- Platform changelog: https://developers.facebook.com/docs/whatsapp/business-platform/changelog

Graph API version: `META_GRAPH_VERSION` (server config, for example `v24.0`). It has no default: unset means WhatsApp is not
configured on the server (sends are skipped `NOT_CONFIGURED`, the connection test says so). The version is never guessed.

| Behaviour | What the app does | Status |
|---|---|---|
| Send endpoint | `POST /<version>/<PHONE_NUMBER_ID>/messages`, JSON, `Authorization: Bearer <token>`, `messaging_product: whatsapp`, `recipient_type: individual`, `to` as E.164 digits without the plus | UNVERIFIED |
| Template send | `type: template`, `template.name`, `template.language.code`, components: `header` (document parameter by media id), `body` (positional text parameters), one `button` per mapped quick reply (`sub_type: quick_reply`, `index` as a string, `parameters: [{type: payload, payload}]`) | UNVERIFIED (button `index` type differs between examples) |
| Quick-reply payloads | Set on every send from the template's button mapping: `AL_QR_QUOTE_V1`, `AL_QR_CALL_V1`, `AL_QR_STOP_V1` (ADR-62); the inbound side falls back to button text when no payload is echoed | Payload echo UNVERIFIED |
| `biz_opaque_callback_data` | Set to the DispatchAttempt id on every send; a matching status webhook resolves an AMBIGUOUS attempt (ADR-62). The changelog snippet says the maximum was raised from 256 to 512 characters; a forum thread reports it missing from some status payloads | UNVERIFIED |
| Free-form text | `type: text`, `text.body`, `preview_url: false`; 4096 characters at most (checked locally) | UNVERIFIED limit |
| Documents (P2) | The quotation PDF is uploaded first, `POST /<version>/<PHONE_NUMBER_ID>/media` multipart (`messaging_product=whatsapp`, `type=application/pdf`, `file`), answer `{id}`; then `type: document` with `document.id`, `filename` and the caption, or as the template's DOCUMENT header. Never a link | UNVERIFIED |
| Media limits | Documents up to 100 MB (third-party snippets), media ids valid 30 days after upload (Meta snippet); the app uploads per send and does not rely on the TTL | UNVERIFIED |
| A template without a DOCUMENT header and a send with a PDF | Refused before any request (`TEMPLATE_CANNOT_CARRY_DOCUMENT`, PERMANENT). Templates with named parameters, header variables, image/video/location headers or URL-button variables are shown as not sendable from this app | Design choice |
| Template list | `GET /<version>/<WABA_ID>/message_templates?fields=id,name,language,status,category,components&limit=100`, paged with the `after` cursor; the `next` URL in an answer is never followed; at most 20 pages | UNVERIFIED |
| Template status and category | Stored as the raw provider strings (APPROVED, PAUSED, REJECTED, PENDING, ...; MARKETING, UTILITY, ...). Only the exact value `APPROVED` makes a template sendable | Values UNVERIFIED |
| Quality rating | `GET /<version>/<PHONE_NUMBER_ID>?fields=id,quality_rating,whatsapp_business_manager_messaging_limit`, stored raw in `Integration.qualityRaw`. Snippets show upper-case values (GREEN, YELLOW, RED) and NA for an ungraded number. RED pauses automated WhatsApp sends (`QUALITY_PAUSED`), not sends a person approves | UNVERIFIED |
| Messaging limit | Stored raw in `messagingLimitRaw`. Meta's page (snippet) says `messaging_limit_tier` is deprecated and `whatsapp_business_manager_messaging_limit` replaces it, and that limits are per business portfolio. No tier list exists in the app; a missing field is shown "Unknown, last checked <time>" | UNVERIFIED |
| Connection test | `GET /<PHONE_NUMBER_ID>?fields=id,display_phone_number,verified_name` and `GET /<WABA_ID>?fields=id,name`; CONNECTED only when both ids come back as configured | UNVERIFIED |
| Error classes | `src/server/adapters/whatsapp/error-map.ts` (dated). Mapped codes: 131049, 131026, 131047, 131050 (suppress), 130429 and 131056 (retryable, throttle), 132000, 132001, 132015, 131051, 190, 100. Unmapped 5xx is AMBIGUOUS; a timeout or reset after the write is AMBIGUOUS; a failure before the write is PRE_SEND; `Retry-After` (seconds or date) is honoured, capped at one hour | UNVERIFIED semantics |
| Graph throttling and permission codes on reads | Throttling 4, 17, 32, 613, 80007, 80008, 130429 or HTTP 429; permission 3, 10, 200, 294 or HTTP 403; token 190 or HTTP 401 | UNVERIFIED |
| Scheduled checks | Hourly connection re-test and quality check, template sync every 6 hours, while the integration is CONNECTED or DEGRADED (time-bucket job keys) | Design choice |

### AI providers (T32 connection tests, checked 2026-10-20)

How the pages were read: **not first-hand** (the provider documentation hosts are not reachable from the build environment).
The calls go through the pinned SDKs (`@anthropic-ai/sdk` 0.134.0, `openai` 7.34.0), whose `models.list` / `models.retrieve`
methods define the paths; response shapes in the fixtures follow the SDK types. UNVERIFIED until a live check.

- Anthropic Models API: https://docs.anthropic.com/en/api/models-list and https://docs.anthropic.com/en/api/models
- OpenAI Models API: https://platform.openai.com/docs/api-reference/models

| Behaviour | What the app does | Status |
|---|---|---|
| Anthropic connection test | `GET /v1/models?limit=1` (key check), then `GET /v1/models/<modelId>` (the configured model, or the adapter default `claude-opus-5-5`); the key only in `x-api-key`; no retries | Fixture-tested, UNVERIFIED live |
| OpenAI connection test | `GET /v1/models`; CONNECTED only when the configured model id is in the list (OpenAI has no default model here) | Fixture-tested, UNVERIFIED live |
| Outcomes | 401/403 ERROR `PROVIDER_AUTH`; unknown model ERROR `AI_MODEL_NOT_FOUND`; 429, 5xx and timeouts leave the status unverified (or DEGRADED after CONNECTED); never CONNECTED without a real answer | Design choice |

### Google_Map_Extractor bridge (T36, checked 2026-10-21)

Status: **contract verified, live extension NOT verified** (plan section 13). No vendor code and no vendor key material is in
the repository (ADR-13). There is no provider documentation to check: the vendor publishes none, so the contract is AuraLead's
own, and everything about the vendor extension below comes from the CEO security review (`docs/reviews/ceo/03-security.md`,
T19), not from a first-hand inspection during T36 (no vendor copy is available in the build environment).

What exists:

- Receiver `POST /api/webhooks/gmaps-extension` (`src/server/services/extension/receive.ts`): `Authorization: Bearer
  alx_<keyId>_<secret>` only, prefix lookup and constant-time sha256 compare, scope `ingest:gmaps`, one workspace, revocation
  applies to the next request (401 `token_revoked`), `token_expired`, `token_invalid`, `token_missing`; an http(s) or `null`
  Origin is 403; CORS only for `chrome-extension://<allowedExtensionId>` of a live token (preflight `OPTIONS` too); 1 MiB and
  200 records (more is 413 `TOO_MANY_RECORDS`); per-record intake validation (`INVALID_RECORD`), 422 `NO_VALID_RECORDS` when
  none is valid; WebhookEvent persistence keyed `(GMAPS_EXTENSION, workspaceId, batchId)` with the raw-body hash: replay returns
  the stored per-record results, other bytes are 409 `BATCH_CONTENT_MISMATCH`; rate limit `extension` 60 batches per minute
  per token; refusals counted in WebhookRejection and, for a known token, audited `extension.token.denied` without secrets.
  Records go through `ingestBatch` as `GMAPS_EXTENSION`: no WhatsApp consent, no invented email, E.164 phones.
- Tokens (`/api/app/extension/tokens`, `/revoke`, `/allowed-extension`; `extension.manage`): shown once, sha256 only, at most 10
  active per workspace, optional expiry (30, 90, 365 days), audited by prefix.
- Extension hub page (`/dashboard/employee/[ws]/extension`): webhook URL, create/list/revoke, allowed extension id, batches with
  per-record failures, refused requests, example payload, DEMO simulation.
- `extension-bridge/`: `saas-sync.js` (classic script for the vendor's service worker), options page, `PATCH-GUIDE.md`, examples.

| Behaviour | What the bridge assumes | Status |
|---|---|---|
| Handoff | The extension saves its whole local blob under `Google_Map_Extractor_local_default` in `chrome.storage.local`; rows in `collect[]`, each with `row_key`; `cid` sometimes missing | From the review's reading of the copy inspected on 2026-10-15; configurable; UNVERIFIED live |
| Licence gate | `_auth.hasValidKey === true` in that blob means licensed; anything else disables sync ("Extension not licensed: sync disabled") | Same source; UNVERIFIED live |
| Row field names | Only `row_key`, `cid`, `keyword`, `location` are recorded; name, phone, email, website, address, rating and reviews keys are guesses with a configurable mapping | UNVERIFIED |
| Service worker hook | `importScripts(chrome.runtime.getURL('/extension-bridge/saas-sync.js'))` at the top level of `controllers/background.js` | Same source; UNVERIFIED live |
| Permissions added | `alarms` (and `storage`), `optional_host_permissions` for the AuraLead origin, `options_page` | Chrome MV3 behaviour from memory; UNVERIFIED in this environment |

Vendor telemetry disclosure (for `/docs`, T37). Observed in the copy inspected on 2026-10-15, as recorded by one reviewer of the
CEO security review (T19); the critic (`docs/reviews/ceo/99-critic.md` 12.3) confirmed only that both copies exist, that neither
has a LICENSE file and that the original carries local modifications, and asked for re-confirmation during implementation. That
re-confirmation was **not** possible in T36 (no vendor copy in the build environment), so each item below is unconfirmed:

- the licence check sends the licence key in a query string to the vendor's backend (`jmjdigitalworld.com`);
- every page load calls the vendor's `version.php` and `adinfo.php` (the user's IP address and usage timing reach the vendor), and
  the vendor can remotely show an "update required" dialog with any download link plus an ad image and link;
- the original copy contains unreachable code that would post every extracted row (business name, phone, emails, address,
  coordinates, website, the search keyword and location) to a vendor endpoint; it is dead in that copy, so a vendor build may
  be capable of exfiltrating lead data;
- the extension requests `<all_urls>` (used for its email scraping, which fetches each lead's website from the operator's
  browser) and exposes some scripts as web-accessible resources.

Unknown: whether the build a customer installs matches the inspected copy, what any current vendor build sends, and the
vendor's terms. The bridge adds no host permission of its own beyond the AuraLead origin, never reads the licence key and never
writes the vendor's storage; the token sits in the extension's storage and is readable by any code running in the extension.


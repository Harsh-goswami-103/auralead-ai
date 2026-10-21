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
| Google Sheets and Apps Script | Yes | Yes | Yes | No |
| Google_Map_Extractor bridge | No | No | Yes | No |
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

### Google Sheets and Apps Script (T34, checked 2026-10-20)

How the pages were read: **not first-hand**. `developers.google.com` is blocked by the build environment's network policy, so
the behaviour below comes from web-search snippets of Google's pages (and localized copies of them), third-party write-ups and
the pinned `google-auth-library` 11.3.0 source in `node_modules` (read directly: the JWT client posts a signed RS256 assertion to
`https://oauth2.googleapis.com/token` through its gaxios transport). Every behaviour is **UNVERIFIED** until a user-authorized
live check. The fixtures in `tests/fixtures/sheets/documented-shape/` are documented-shape fixtures (`SOURCES.json` lists each
one); none is recorded live traffic. The generated Apps Script is tested in node's `vm` against a stand-in of the Apps Script
runtime (`tests/unit/sheets/apps-script-env.ts`), not against Google's runtime.

Pages cited (not read first-hand):

- Sheets API `spreadsheets.values.get`: https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets.values/get
  (snippets confirm `valueRenderOption`, that `dateTimeRenderOption` applies only when the render option is not
  FORMATTED_VALUE, and SERIAL_NUMBER as days since 1899-12-30 with the time as a day fraction; mirrored at
  https://docs.cloud.google.com/workflows/docs/reference/googleapis/sheets/v4/spreadsheets.values/get)
- Sheets API `spreadsheets.get`: https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/get
- Service account OAuth (JWT bearer): https://developers.google.com/identity/protocols/oauth2/service-account
- Sheets API limits: https://developers.google.com/sheets/api/limits
- Apps Script Utilities (`computeHmacSignature(algorithm, value, key, charset)` returning `Byte[]`, `MacAlgorithm.HMAC_SHA_256`):
  https://developers.google.com/apps-script/reference/utilities (localized copies only)
- UrlFetchApp (`muteHttpExceptions`, `followRedirects`, `headers`, `payload`, `contentType`, `getResponseCode`):
  https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app and
  https://developers.google.com/apps-script/reference/url-fetch/http-response
- Installable triggers (`onFormSubmit` for a spreadsheet, time-driven): https://developers.google.com/apps-script/guides/triggers/installable
- Apps Script quotas: https://developers.google.com/apps-script/guides/services/quotas
- Not-shared and API-disabled 403s (community reports): https://discuss.google.dev/t/google-sheets-api-suddenly-returns-403-the-caller-does-not-have-permission-after-working-for-a-month-php/243640,
  https://zenn.dev/catnose99/articles/d9b831b850ca3a?locale=en, https://www.mintlify.com/googleworkspace/cli/troubleshooting/api-not-enabled

API version: Sheets API v4 (`https://sheets.googleapis.com/v4/...`), OAuth scope `https://www.googleapis.com/auth/spreadsheets.readonly`.

| Behaviour | What the app does | Status |
|---|---|---|
| Access | A service account key (JSON) saved as an encrypted credential; the person shares the Sheet with the service account email (shown on the Sheets page with the masked key file). A Sheet URL alone grants nothing | Design (ADR-16) |
| Token | `google-auth-library` JWT client, scope `spreadsheets.readonly`; its HTTP goes through `adapters/http/outbound.ts` (`fetchImplementation`), only to `oauth2.googleapis.com/token`, library retries off | Library behaviour read from source; endpoint UNVERIFIED live |
| Connection test | `GET /v4/spreadsheets/{id}?fields=properties.timeZone,sheets.properties.title`, then `values.get` of `'<tab>'!1:1` (FORMATTED_VALUE). CONNECTED only on Google's answer with row 1 | UNVERIFIED |
| Errors | 403 `PERMISSION_DENIED` = not shared (guidance names the service account); 403 naming `SERVICE_DISABLED` / `accessNotConfigured` / "has not been used in project" = API not enabled; 404 = unknown spreadsheet; 400 "Unable to parse range" = wrong tab; 401 and token `invalid_grant` = rejected key; 429 / 5xx / no answer never pass and never fail the credentials | UNVERIFIED error shapes |
| Rows | `values.get` of `'<tab>'!<from>:<to>` with `UNFORMATTED_VALUE` + `SERIAL_NUMBER`; serial dates converted in the spreadsheet's time zone (`properties.timeZone`) | UNVERIFIED |
| Mapping and drift | Header names normalized (NFKC, spaces folded); fingerprint = sha256 of the sorted set of names other than `auralead_event_id`; any rename/add/remove blocks sync and pushes (409 `HEADER_DRIFT` with the column diff) until the mapping is re-confirmed | Design (ADR-103) |
| Preview | Dry run of the next 10 rows through the same mapping and normalizer; writes nothing | Design |
| Sync now | Job `sheets.sync`: at most 200 rows after the last cursor, ingested via `ingestBatch` as ImportBatch `sheets-sync:<run>`; row key = the row's `auralead_event_id` cell (same key as the script), rows still waiting for their id are skipped and the cursor stops before them; a Sheet without that column gets flagged weak content-hash ids | Design (ADR-104) |
| Apps Script push | `POST /api/webhooks/google-sheets`, headers `X-AuraLead-Key-Id`, `X-AuraLead-Timestamp` (Unix seconds), `X-AuraLead-Event-Id`, `X-AuraLead-Signature: v1=<hex HMAC-SHA256(secret, ts + "." + eventId + "." + body)>`; +/- 300 s (`REPLAY_WINDOW`); 256 KB and 50 rows (413); replayed event id = stored result; scoped by integration (E2); rate limit 120/min/integration after verification | Fixture- and vm-tested; real Apps Script delivery UNVERIFIED |
| Script signing | `Utilities.computeHmacSignature(HMAC_SHA_256, message, secret, UTF_8)`, signed bytes converted with `& 0xff`; the JSON body is made pure ASCII (\u escapes) so the signed bytes cannot depend on UrlFetchApp's charset | UNVERIFIED (charset default not confirmed, so it is passed explicitly) |
| Script retries | `muteHttpExceptions: true`, `followRedirects: false`; network errors, 429 (Retry-After honoured) and 5xx retried up to 4 attempts with exponential backoff and jitter in one run, re-signed, same event id; no retry on other 4xx; unsent rows wait in Script Properties (`AURALEAD_PENDING`, at most 200 ids) and a 15-minute time trigger sends them, 50 rows per push | Design |
| Secret storage | Issued by the server (32 random bytes), shown once; the script prompts for it and stores it in Script Properties (`AURALEAD_SECRET`), never in a cell or in the script text. Rotation issues a new key id and secret | Design (ADR-105) |
| Apps Script quotas | Script runtime 6 min per execution, Properties value 9 KB and 500 KB in total, 20 triggers per user per script (official quotas table, snippet); UrlFetch 20,000 calls/day (consumer) / 100,000 (Workspace) and trigger runtime 90 min/day (consumer) from third-party sources only | UNVERIFIED |
| Triggers | Installable `onFormSubmit` for the spreadsheet and a time-driven trigger every 15 minutes; `e.range` is the submitted row. Duplicate firings are harmless (the row id is written once and the server dedupes by it) | UNVERIFIED trigger behaviour |
| Event id column | The script appends a hidden `auralead_event_id` column (warning-only protection) and writes a UUID per row once. Where Google Forms puts columns for newly added questions relative to it is not confirmed | UNVERIFIED |
| Reachability | Apps Script runs on Google's servers: APP_ORIGIN must be a public https address; the page warns otherwise | Design |


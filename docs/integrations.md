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
| Meta Lead Ads webhook and lead fetch | Yes | Yes | Yes | No |
| Meta Marketing API (metrics, pause/resume) | Yes | Yes | Yes | No |
| Resend (email send, webhooks) | Demo transport only | No | Yes | No |
| SMTP (nodemailer) | No | No | Yes | No |
| Google Sheets and Apps Script | No | No | Yes | No |
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

### Meta Lead Ads (T35, checked 2026-10-20 and 2026-10-21)

How the pages were read: **not first-hand**. `developers.facebook.com` does not resolve from the build environment (a fetch
of the Lead Ads retrieval page failed with `ENOTFOUND`), so the shapes below come from web-search snippets of Meta's pages and
from third-party guides (LeadSync, Mixed Analytics, Tonkean). Every behaviour in this section is **UNVERIFIED** until a
user-authorized live check produces evidence (plan section 13). The fixtures in `tests/fixtures/meta/documented-shape/` are
documented-shape fixtures, not recorded live traffic (`SOURCES.json` lists each file's source).

Pages cited (not read first-hand):

- Webhooks for Lead Ads: https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-leadgen and
  https://developers.facebook.com/docs/marketing-api/guides/lead-ads/quickstart/webhooks-integration/
- Retrieving leads: https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving
- Graph API error handling: https://developers.facebook.com/docs/graph-api/guides/error-handling
- Graph API rate limiting: https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
- Versioning: https://developers.facebook.com/docs/graph-api/guides/versioning/ and https://developers.facebook.com/docs/graph-api/changelog/versions
- Third-party, for the `filtering` syntax: https://leadsync.me/blog/meta-lead-gen-api-guide/ and
  https://mixedanalytics.com/knowledge-base/import-facebook-leads-to-google-sheets/

Graph API version: `META_GRAPH_VERSION` (for example `v24.0`). No default: unset means leads cannot be read (the job fails the
event `INTEGRATION_NOT_CONFIGURED`, the connection test says so). Snippets: Graph versions are usable for at least two years after
the next version ships; v24.0 (2025-10-08) and v25.0 (2026-02-18) list their expiry as TBD (UNVERIFIED).

| Behaviour | What the app does | Status |
|---|---|---|
| Webhook verification | `GET /api/webhooks/meta-ads`: `hub.mode=subscribe`, `hub.verify_token` compared in constant time with `META_VERIFY_TOKEN`, the challenge echoed only if it matches `^[0-9A-Za-z_-]{1,128}$`, else 403 | Design per plan section 9 |
| Webhook signature | `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(META_APP_SECRET, raw body)>` over the bytes read once (1 MB cap). Re-serialized JSON (for example Devanagari as `\u` escapes) or one changed byte fails; failures are counted in `WebhookRejection`, never stored | UNVERIFIED (same scheme as the WhatsApp webhook) |
| Delivery shape | `{object: "page", entry: [{id: <page id>, time, changes: [{field: "leadgen", value: {leadgen_id, page_id, form_id, ad_id, adgroup_id, created_time}}]}]}`; only `leadgen` changes are read; a change whose `page_id` differs from its entry is not stored | UNVERIFIED |
| Routing and idempotency | By `page_id` through `Integration.routingKey` (set when a LIVE workspace saves its Page ID); unknown Pages are stored UNROUTED (30-day purge). One event per notification, key `meta:{page}:{leadgen}` scoped by the routed integration (E2) | Design |
| Rate limit | `metaWebhook` 600 per minute per client address (before the signature check) and per routed integration (before anything is written); over it: 429 with Retry-After, counted, nothing stored | Design (single instance, plan section 9) |
| Lead fetch | Worker job `meta.lead.fetch`: `GET /<version>/<leadgen id>?fields=id,created_time,ad_id,form_id,campaign_id,field_data,custom_disclaimer_responses` with `Authorization: Bearer <token>`; mapped with the form's MetaFormMapping (question keys, consent question and notice hash, P1) and ingested through `ingestBatch` (dedupe per leadgen id and contact) | UNVERIFIED |
| Consent checkboxes | Each `custom_disclaimer_responses[]` entry becomes an answer keyed by its `checkbox_key` with the `is_checked` value, so a consent checkbox can be mapped like a question | UNVERIFIED (field and values) |
| Errors | Code 190 or HTTP 401: integration set to CONFIGURED_UNVERIFIED ("Verification required"), job DEAD, not retried. Codes 3, 10, 200-299 or HTTP 403: "Missing permission: <name>" (Meta's name when the message has one, else the operation's: `leads_retrieval`), job DEAD. Codes 4, 17, 32, 613, 80000-80014 or HTTP 429: retry with `min(30 s * 2^(n-1), 1 h)` or Retry-After, 8 attempts. Code 100 or 404: the event is FAILED `LEAD_UNRETRIEVABLE` (no stub record, so a later backfill can still bring the lead in) | UNVERIFIED codes |
| Unmapped form | The event is FAILED `MAPPING_NOT_FOUND` before Meta is called; the Meta page lists the form; map it, then backfill | Design |
| Backfill from form since T | `GET /<version>/<form id>/leads?fields=...&limit=100&filtering=[{"field":"time_created","operator":"GREATER_THAN","value":<unix>}]`, paged by the `after` cursor only (the `next` URL is never followed), at most 10 pages per run, each page ingested as its own batch; on demand only (critic L-8), last 90 days | Filtering syntax from third-party guides: UNVERIFIED |
| Lead retention | Meta keeps leads for 90 days (third-party snippet); the backfill refuses an older start | UNVERIFIED |
| Permissions and access | `leads_retrieval`, `pages_show_list`, `pages_manage_metadata` (to subscribe the Page), and the app's access to the form in Leads Access Manager; App Review may be required for `leads_retrieval` | UNVERIFIED (App Review and Leads Access Manager behaviour not checked) |
| Connection test | `GET /<graph version>/<page id>?fields=id,name` must return the configured Page id; with an ad account, `GET /<marketing version>/act_<id>?fields=id,account_id,name,currency,timezone_name,account_status` must return it with a currency | UNVERIFIED |

### Meta Marketing API (T35, checked 2026-10-20 and 2026-10-21)

How the pages were read: **not first-hand** (same restriction). Sources: search snippets of the Marketing API rate-limiting page,
the effective_status webhook page and the Marketing API changelog, a Meta developer blog post on Insights metric changes, and
third-party wrappers (pipeboard meta-ads-mcp, CData). Everything below is **UNVERIFIED**.

- Rate limiting: https://developers.facebook.com/docs/marketing-api/overview/rate-limiting
- Effective status: https://developers.facebook.com/documentation/ads-commerce/marketing-api/ads-webhooks/effective-status
- Versioning and changelog: https://developers.facebook.com/docs/marketing-api/overview/versioning and
  https://developers.facebook.com/docs/marketing-api/marketing-api-changelog
- Insights metric changes: https://developers.facebook.com/blog/post/2024/08/07/ads-insights-api-unique-metric-updates/

Marketing API version: `META_MARKETING_VERSION` (for example `v25.0`), separate from `META_GRAPH_VERSION`. No default: unset gates
the sync and the pause/resume controls on configuration. Snippets: a previous Marketing API version stays supported for at least
90 days after a new one ships (shorter than the Graph API's two years); v23.0 was listed as available until 2026-06-09 (UNVERIFIED).

| Behaviour | What the app does | Status |
|---|---|---|
| Ad account | `GET /<version>/act_<id>?fields=id,account_id,name,currency,timezone_name,account_status`; the `currency` is stored on every campaign exactly as returned | UNVERIFIED |
| Campaigns | `GET /<version>/act_<id>/campaigns?fields=id,name,status,configured_status,effective_status&limit=100`, at most 20 pages; `configured_status` (else `status`) and `effective_status` stored as raw strings (values such as ACTIVE, PAUSED, CAMPAIGN_PAUSED, IN_PROCESS, WITH_ISSUES not checked) | UNVERIFIED |
| Insights | `GET /<version>/act_<id>/insights?level=campaign&date_preset=last_7d&use_unified_attribution_setting=true&fields=campaign_id,campaign_name,spend,actions,cost_per_action_type,date_start,date_stop,attribution_setting` | UNVERIFIED (`attribution_setting` as an insights field, `use_unified_attribution_setting`) |
| Money (P6) | `spend` and the lead `cost_per_action_type` are decimal strings in the ad account currency; stored as integer minor units of that same currency (digits from the platform's ISO 4217 data, explicit half-up rounding), never converted; shown with "As of", the date window and the attribution setting ("attribution not reported" when absent) | Design; field formats UNVERIFIED |
| Leads per campaign | The first of the action types `lead`, `onsite_conversion.lead_grouped`, `leadgen_grouped`; an absent action counts 0 (Meta omits zero-valued actions) | UNVERIFIED action types |
| Sync | Manual "Sync campaigns" (once a minute) and `campaign.metricsSync` every 6 hours while the integration is CONNECTED or DEGRADED | Design |
| Pause / resume | `POST /<version>/<campaign id>` form body `status=PAUSED` or `status=ACTIVE`, answer `{success: true}`; then `GET /<campaign id>?fields=id,name,status,configured_status,effective_status` read back. The CampaignAction is SENDING before the call; a timeout after the write, a 5xx or an unconfirmed 2xx is UNKNOWN and resolved by a delayed read-back; a definite refusal is FAILED with the reason and the campaign unchanged; 17/80004 and connection failures before the write retry | UNVERIFIED (endpoint and answer from secondary sources) |
| Permissions | `ads_read` for reads, `ads_management` for pause/resume (named in the failure when Meta refuses) | UNVERIFIED |
| Throttling codes | 4, 17, 32, 613, 80000-80014 (business use case limits) or HTTP 429; `X-Business-Use-Case-Usage` is not read | UNVERIFIED |
| DEMO | "Sync campaigns" uses the demo stand-in (an INR ad account with two simulated campaigns, labelled Simulated); pause/resume changes the simulated campaign at once as a SIMULATED action; zero outbound | Demo-verified by tests |


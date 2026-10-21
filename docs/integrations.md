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
| Resend (email send, webhooks) | Yes (inbound email not supported, ADR-102) | Yes | Yes | No |
| SMTP (nodemailer) | Yes (no inbound, no bounce tracking) | Yes (local fake server) | Yes | No |
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

### Resend (T33, checked 2026-10-20)

How the pages were read: **not first-hand**. `resend.com` did not resolve from the build environment (WebFetch: `ENOTFOUND
resend.com`), so everything below comes from web-search snippets of Resend's pages, its changelog and blog, and third-party
pages that quote them (Hookdeck, Svix docs, getfluxly, sendraven, GitHub pull requests). Every behaviour is **UNVERIFIED** until a
user-authorized live check. The fixtures in `tests/fixtures/email/documented-shape/` are documented-shape fixtures derived from
these snippets; none is recorded live traffic (`SOURCES.json` there lists each file's source). The adapter uses plain HTTP through
`adapters/http/outbound.ts`, not the `resend` SDK (the SDK cannot be driven through the outbound guard).

Pages cited (not read first-hand):

- Send email: https://resend.com/docs/api-reference/emails/send-email
- Errors: https://resend.com/docs/api-reference/errors ; rate limits: https://resend.com/docs/api-reference/rate-limit
- Idempotency keys: https://resend.com/docs/dashboard/emails/idempotency-keys and https://resend.com/changelog/idempotency-keys
- List domains: https://resend.com/docs/api-reference/domains/list-domains ; API key permissions: https://resend.com/changelog/new-api-key-permissions
- Webhooks: https://resend.com/docs/webhooks/introduction , https://resend.com/docs/webhooks/verify-webhooks-requests ,
  https://docs.svix.com/receiving/verifying-payloads/how
- Receiving: https://resend.com/docs/dashboard/receiving/introduction , https://resend.com/docs/webhooks/emails/received ,
  https://resend.com/docs/api-reference/emails/retrieve-received-email

| Behaviour | What the app does | Status |
|---|---|---|
| Send | `POST https://api.resend.com/emails`, JSON, `Authorization: Bearer <key>`; `from` = `"<workspace name>" <configured from address>`, `to` (one address), `subject`, `text` (text/plain only), `headers` (List-Unsubscribe and List-Unsubscribe-Post, RFC 8058), `attachments: [{filename, content: base64}]`, `tags: [{name: auralead_attempt, value: <attempt id>}]`; answer `{id}` | UNVERIFIED shape |
| Idempotency-Key | Confirmed in the docs and changelog snippets: header `Idempotency-Key`, 1 to 256 characters, 24-hour window, a repeat with the same body returns the original response and sends nothing; a different body is 409 `invalid_idempotent_request`; a repeat while the first runs is 409 `concurrent_idempotent_requests`. The app sends the attempt's own key and, when an outcome is unknown (timeout or reset after the write, or a 5xx), replays the identical bytes under the same key once: a 2xx with an id is SENT, anything else AMBIGUOUS (ADR-100) | Semantics UNVERIFIED |
| Reply-To | Not set: inbound email is not processed (below), so replies go to the from mailbox | Design choice |
| Error classes | `src/server/adapters/email/error-map.ts` (dated 2026-10-20): validation_error, missing_required_field, invalid_parameter, invalid_attachment, invalid_from_address, invalid_access, invalid_region, missing_api_key, invalid_api_key, restricted_api_key, not_found, method_not_allowed, invalid_idempotency_key, invalid_idempotent_request, monthly_quota_exceeded, security_error PERMANENT; rate_limit_exceeded and daily_quota_exceeded RETRYABLE with a workspace throttle; concurrent_idempotent_requests AMBIGUOUS; unmapped 5xx AMBIGUOUS after the replay; `Retry-After` honoured (capped at one hour) | UNVERIFIED |
| Size | 40 MB per email after base64 (snippets); checked locally before the request | UNVERIFIED |
| Connection test | `GET /domains`: CONNECTED when the configured sending domain is listed with status `verified`; another status or absent is ERROR CONFIG_INVALID with the raw status. A sending-only key answers 401 `restricted_api_key` on this endpoint (third-party reports): the key is real and may send, so the test reports CONNECTED and the first send checks the domain | UNVERIFIED |
| Webhook signature | Svix scheme: `svix-id`, `svix-timestamp`, `svix-signature` (space-separated `v1,<base64>`), HMAC-SHA256 of `id.timestamp.rawBody` with the base64 key after `whsec_`, constant-time compare, +/- 5 minutes (`src/server/security/svix.ts`) | UNVERIFIED |
| Webhook routing | Per-integration URL `/api/webhooks/email/resend/<routing key>` (random `rs_...` key written by the LIVE credential save, shown on the setup page); the integration's own `webhookSecret` verifies; unknown key 404, bad or stale signature 401, both counted, nothing stored (ADR-101) | Design choice |
| Webhook events | `email.sent`, `email.delivered`, `email.bounced` (`bounce.type` Permanent suppresses `HARD_BOUNCE`; Transient does not), `email.complained` (suppresses `COMPLAINT`), `email.delivery_delayed`, opens and clicks stored only; payload `{type, created_at, data: {email_id, to[], bounce?, tags?}}`; idempotent per `(RESEND, integrationId, svix-id)`; rank merge as ADR-62; the echoed `auralead_attempt` tag resolves an AMBIGUOUS attempt | UNVERIFIED payload, tags echo UNVERIFIED |
| Inbound (receiving) | Resend has a receiving product (`email.received`, MX on a domain), but its webhook carries metadata only; the reply text and the In-Reply-To header come from the Retrieve Received Email API, whose response fields could not be confirmed. **Inbound email is not supported for this provider** in this version: `email.received` is acknowledged and not stored, and the setup page says so (ADR-102) | Not implemented, disclosed |

### SMTP (T33, checked 2026-10-20)

SMTP itself is RFC 5321 / 3207 / 4954; the client is nodemailer 10.1.1 (`SMTPConnection` and `MailComposer`, which ship their own
type declarations, so `@types/nodemailer` is not added). Tested against a fake SMTP server on 127.0.0.1 with a test-only
self-signed certificate (`tests/fixtures/email/tls/`), never a real server.

| Behaviour | What the app does | Status |
|---|---|---|
| TLS | Required: implicit TLS on 465, STARTTLS on 25, 587 and 2525 (`requireTLS`), TLS 1.2 or newer, certificate checked against the configured host; a server without STARTTLS is refused before AUTH | Fixture-tested |
| Destination | Ports 25, 465, 587 and 2525 only; the host must be a name whose every address is public unicast; the socket is pinned to the checked address (SNI and the certificate keep the name) | Design choice |
| Outcomes | 4xx at any step RETRYABLE, 5xx PERMANENT (a refused login PROVIDER_AUTH); a timeout or reset once the server accepted DATA and the body is being written is AMBIGUOUS; before that PRE_SEND | Fixture-tested |
| Message | text/plain, the unsubscribe headers, the PDF attachment, `Message-ID: <attemptId@from domain>` (also the stored provider id), no Reply-To | Fixture-tested |
| Connection test | connect, TLS, AUTH, QUIT; no MAIL FROM, no message | Fixture-tested |
| Bounces and inbound | **Bounces are not tracked and there is no inbound over SMTP**; replies go to the mailbox; disclosed on the setup page | Disclosed |
| Preference | When Resend and SMTP are both CONNECTED, Resend sends (ADR-100) | Design choice |

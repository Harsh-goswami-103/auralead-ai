# Lead-gen suite: build plan v2 (owner request, 2026-10-23)

v1 was reviewed by four independent critics (codebase fit, compliance, presentation, delivery risk);
this v2 folds in their findings. It is the spec for every implementer of this suite.

Owner request: present AuraLead AI as a working lead-generation tool for a **web-development
service** (the client). An operator (employee panel) finds businesses on Google Maps, imports
them (also from Excel/CSV), messages them on WhatsApp, chats in a WhatsApp-like interface with AI
replying inside the 24-hour window, creates/generates WhatsApp templates (brochure, utility) and
gets them approved, and hands converted leads over to the client (client panel) who closes the deal
(existing quote, PDF and accept flow).

The implementation plan stays locked; deviations are ADR-117..ADR-126 in `docs/decisions.md`.
Unchanged rules: tests first; injected clock; BigInt paise; tokens-only colours; no invented
numbers; DEMO makes zero outbound calls; LIVE never fakes a provider result; every send goes through
the outbox (`queueOutboundMessage`) and the shared eligibility check; consent rules hold (Places and
plain-import leads have no WhatsApp opt-in); mutations only via `/api/app/*` + `withRoute`.

## 0. Story

1. **Find** `/dashboard/employee/<ws>/finder`: keywords x locations, progress, results grid (name,
   category, phone, website or *No website listed*, rating, reviews, address, city, pincode, map
   link, emails when extracted), filters (No website, Has phone, Not imported), select, **Import as
   leads**, **Download Excel**. LIVE shows "Google Maps" attribution. DEMO shows Simulated.
2. **Import** `/dashboard/employee/<ws>/leads/import`: upload .xlsx/.csv, suggested column mapping,
   preview, import (job), counts and row-level reasons; **Download sample workbook**; optional
   consent column (owner-only capability, attestation, data source, notice).
3. **Reach out** (lead page panel): *Record WhatsApp opt-in* (notice text prefilled from workspace
   setting, method), **click-to-chat link** (wa.me link to the workspace WhatsApp display number +
   prefilled text, copy/QR-free), existing B2B email path; approved template single/bulk send with
   per-lead `{{1}}` name.
4. **Chat** `/dashboard/employee/<ws>/inbox` and `/dashboard/user/inbox`: WhatsApp-like thread list
   and conversation (bubbles, ticks with labels, window countdown, template-only composer when
   closed), **Automatic replies** toggle; AI answers service questions inside the window; prices,
   calls, complaints, human requests and stop escalate (Needs you).
5. **Templates** `/dashboard/employee/<ws>/templates`: person picks category; **Generate with AI**;
   header none/text/document (PDF brochure upload); body `{{n}}`; footer; buttons (STOP quick reply
   default on MARKETING); WhatsApp-bubble preview; **Submit for approval**; Pending/Approved/
   Rejected(+reason); DEMO simulated review after 30 s.
6. **Hand over**: *Hand over to client* with note + AI summary; AI stops; client sees *Handed over*
   (command center count, leads filter, inbox badge + timeline event, Acknowledge) and continues;
   operator read-only (`HANDED_OVER`). Client creates the quote (existing flow).

## 1. Decisions (ADRs appended by Foundation-A)

- **ADR-117 Spreadsheet module** (commit 91f8bea): `src/lib/spreadsheet` = XLSX writer/reader on
  `fflate@0.8.3` + RFC 4180 CSV parser; no formulas written; zip-bomb, size and row limits. Rejected
  `exceljs` (heavy tree) and npm `xlsx` (unpatched CVE on npm).
- **ADR-118 Lead Finder on Google Places API (New)** (amends ADR-13's scope note; the extension
  bridge path is unchanged). Text Search `POST https://places.googleapis.com/v1/places:searchText`
  with `X-Goog-Api-Key` and a field mask of only `places.id, displayName, primaryTypeDisplayName,
  nationalPhoneNumber, internationalPhoneNumber, websiteUri, rating, userRatingCount,
  formattedAddress, addressComponents, googleMapsUri, attributions` + `nextPageToken` (never
  reviews or photos), one HTTP call per job, up to 3 pages of 20 per query. Per-workspace encrypted
  `GOOGLE_PLACES` integration key. Google Maps Platform terms handling: (a) finder results are a
  **24-hour working copy**: `contentExpiresAt` = fetch + 24 h; `leadFinder.purge` nulls the Places
  content columns and keeps `placeId`, keyword, location, `websiteListed`, website-sourced emails,
  `importedLeadId`; expired rows show "Details expired" and **Refresh** (Place Details by id,
  `finder.run`); no latitude/longitude stored; (b) **attribution**: LIVE shows "Google Maps" and the
  returned attributions wherever Places content appears, plus the line "Results from Google Maps.
  Use is subject to the Google Maps Additional Terms of Service and the Google Privacy Policy.";
  (c) **export**: LIVE Download Excel contains place ID, a Maps link built from the place ID,
  keyword, location, imported/lead id/stage and website-sourced emails only; DEMO exports the full
  simulated columns; (d) **imported leads** keep `Lead.placeId`; Places-sourced fields (phone,
  rating, review count, address, pincode, category) carry `Lead.placesContentExpiresAt` = import +
  30 days; `leads.placesExpire` nulls them unless the contact was confirmed
  (`contactConfirmedAt/Via`: inbound WhatsApp from the number, a recorded opt-in, website email
  match, or an audited operator "Confirm details"). The ADR states this reduces risk and is not a
  licence. DEMO: deterministic simulated provider `demoPlace(seed,{keyword,location})` in
  `src/lib/demo/places.ts`, flagged `simulated`. Email extraction (opt-in per run): LIVE fetches the
  listed site's home page and up to two same-host contact pages through `safeFetch`, honours
  robots.txt, identifying User-Agent, 1 request per host at a time, 8 s and 1 MB per page, stores
  `{address, sourceUrl, kind: ROLE|PERSONAL|FREEMAIL}`, drops placeholders and the run's blacklist;
  at most 3 sites per job; DEMO addresses use the existing `@demo-leads.in` convention. New
  `LeadSource GOOGLE_PLACES` (provider key `GOOGLE_PLACES:<placeId>`; phones dedupe across sources).
  GOOGLE_PLACES is not added to the hourly health check (paid calls).
- **ADR-119 `WebsiteStatus NOT_LISTED`** (amends ADR-53): set by ingestion only when the source
  says the listing has no website (`websiteListed: false` with no URL, i.e. Places result without
  `websiteUri` when it was requested). Known value: scoring with `websitePreference 'ABSENT'`
  scores it like `VERIFIED_ABSENT`; with `'PRESENT'` it is a known 0. Enrichment never sets it and is
  a no-op for it. Label "No website listed".
- **ADR-120 File import** (amends ADR-15 for one source). `LeadSource FILE_IMPORT`,
  `ConsentSource FILE_IMPORT`. Upload is base64 JSON (5 MB file; route `maxBodyBytes` about 7 MB),
  parsed by `readTable`; `SpreadsheetError` maps to 422. Parsed rows go to
  `STORAGE_DIR/imports/<ws>/<id>.json` (never the DB) and are deleted on completion or by
  `leads.importPurge` at `expiresAt` (24 h). At most 2,000 rows per import. Rejections store row
  number + code (+ field) only. Mapping: `IMPORT_MAPPABLE_FIELDS` (`src/lib/schemas/lead-import.ts`):
  name, phone, email, website, address, city, category, rating, reviewCount, pincode, consent,
  consentDate. Header synonyms suggest a mapping. Processing: `leads.import` job, 200 rows per chunk
  through `ingestBatch`. Consent column honoured only with capability `consent.import` (OWNER only;
  not MEMBER, not seeded operators), `dataSource` OWN_CUSTOMERS or OWN_FORM_OR_EVENT (ignored for
  PUBLIC_DIRECTORY/THIRD_PARTY_LIST), a notice text containing the workspace name and "WhatsApp"
  (stored with its hash), the attestation below, a mapped consent-date column with no future dates.
  Then `captureIngestionConsent` records OPT_IN MARKETING WhatsApp consent with evidence
  `{importId,row,attestedBy,noticeHash}` but **never clears a suppression** (backfilled flag ->
  outcome `BACKFILLED_SOURCE`, audited `suppression.clear_refused`; suppressed contacts counted
  `SUPPRESSED_CONTACT`). Attestation: "I confirm that each row marked as consented is a person who,
  on the date given, agreed to receive WhatsApp messages from <business> about <purpose> after
  seeing the notice below; that <business> collected this list itself (it was not bought or
  scraped); and that I can produce the evidence on request. I understand this import will not
  re-subscribe anyone who has replied STOP." Lead export gains `format csv|xlsx`.
- **ADR-121 Operator inbox and WhatsApp-style chat** (amends ADR-65). Inbox pages in both panels;
  `/api/app/messages`, `/api/app/messages/drafts`, `/api/app/conversations/[id]/{mode,takeover,resume}`
  accept USER and EMPLOYEE with optional `workspaceSlug` (consoleContext); capabilities checked in
  the services. `--chat-*` tokens (wallpaper, incoming, outgoing, accent, tick-read, meta text) with
  contrast tests; ticks keep a text label. DEMO simulated delivered/read for its own sends through a
  `wa.demoStatus` job enqueued by a one-line hook after a DEMO settle (labelled simulated). The
  **Automatic replies** control is the existing `autoSendEnabled` setting, labelled truthfully
  ("Automatic sending: AI replies and automated pipeline sends"), capability `automation.manage`.
- **ADR-122 AI replies in the 24-hour window** (amends ADR-63; supersedes reply-guard.ts's "never
  asks a model" note). In AUTO, `classifyReplyIntent` stays the pre-gate. Only `service_faq` goes to
  the model task `conversation_reply` (workspace catalog facts only, last 12 messages as untrusted
  data, strict JSON `{reply, intent, escalate}`, output policy; a non-service_faq intent or
  `escalate:true` from the model sends `FIXED_REPLIES.handoff`). `out_of_scope`, complaint,
  human_request, stop keep ADR-63 deflection; quote_request and call_request keep their fixed
  acknowledgements and set `Conversation.escalatedAt` (feeds Needs you) while staying AUTO. The first
  automated reply in each window starts with "<Business>'s automated assistant. Reply HUMAN to talk
  to a person." Window-only; at most 4 consecutive automated replies, then escalate. LIVE without an
  AI integration keeps reply-guard fixed texts (label `reply-guard`, not a silent model fallback);
  DEMO uses `local-deterministic` (keyword-aware over the catalog, labelled "Local template").
  `reply.auto` becomes kind `ai`: read + model outside the transaction, re-check (aiMode,
  humanTakeover, handedOverAt, window, consent, latest inbound) and queue in the fenced final tx.
- **ADR-123 Template studio** (amends ADR-17, ADR-81). `WhatsAppTemplate` gains `origin`
  (SYNCED|AUTHORED), `providerTemplateId`, `rejectedReason`, `submittedBy/At`, `headerMediaId`,
  `copyGeneratorLabel`, `utilityTrigger`; `syncedAt` nullable ("Not synced yet"). Status stays a raw
  provider string; local drafts use `DRAFT` (never sendable), submit in flight `SUBMITTING`. The
  person chooses the category first; `template_copy` (AI) receives it and cannot change it; UTILITY
  requires a "sent when" trigger and shows a warning for promotional words; MARKETING templates get
  a STOP quick-reply button by default (mapped to the existing STOP payload). Header: NONE, TEXT or
  DOCUMENT (PDF brochure `MediaAsset`, 5 MB); IMAGE deferred. LIVE submit runs as a
  `wa.templateSubmit` job: SUBMITTING -> resumable upload (`appId` config field) for a document
  header -> `POST /<wabaId>/message_templates` -> PENDING + provider id; a timeout is resolved by a
  sync by name+language, never a blind retry; then `wa.templateSync` keyed
  `wa.templateSync:<integrationId>:submit:<templateId>` at least 60 s later. Sync matches authored
  rows by name+language and never counts DRAFT/SUBMITTING as missing. DEMO: PENDING then
  `wa.templateReview` after 30 s approves (or rejects names containing `reject` with a reason),
  labelled Simulated. Sending: `headerMediaId` set means the MediaAsset is the document header
  (LIVE uploads it per send to `/<phoneNumberId>/media` as today's quote PDF path does); otherwise
  DOCUMENT still means the quote PDF. Template-admin calls live on a new port
  `adapters/whatsapp/template-admin.ts` (+ `template-admin-demo.ts`), not on `WhatsAppTransport`.
  Consent: OPT_IN + MARKETING for every category (unchanged). Per-lead variables via
  `resolveLeadTemplateVariables` (sources `lead.firstName`, `lead.displayName`, `lead.city`,
  `lead.category`, `workspace.name`) in bulk and composer.
- **ADR-124 Lead handoff**: capability `leads.handoff`; `LeadHandoff` (one per lead) +
  `Lead.handedOverAt`. `handOverLead` in one tx: stageVersion CAS (to CONVERTED unless later), every
  open conversation `aiMode OFF` + `humanTakeover` with modeVersion CAS, PENDING outbound approvals
  of the lead invalidated, open pipeline execution halted, LeadHandoff row, PII-free audit
  `lead.handoff`; a second handoff is 409. `handoff.summary` ai job (DEMO local; LIVE workspace AI or
  `summaryStatus NOT_CONFIGURED`). Client: command-center count, `handedOver` leads filter, inbox
  filter + badge + timeline event, Acknowledge. Guard `assertNotHandedOver` (EMPLOYEE actors, 409
  `HANDED_OVER`) at `queueOutboundMessage` and conversation mode changes; not an eligibility reason.
- **ADR-125 Reach-out panel**: `WorkspaceSettings.whatsappOptInNotice` and `privacyContact`;
  recording a WhatsApp MARKETING opt-in requires notice text (prefilled, must contain the business
  name) and `evidence.method` (CALL_VERBAL, WRITTEN_FORM, WEBSITE_FORM, IN_PERSON, WHATSAPP_THREAD);
  click-to-chat link `https://wa.me/<displayPhoneNumber digits>?text=<prefill>` (WHATSAPP_CLOUD
  config `displayPhoneNumber`), prefill refused when it folds to a START/STOP keyword; presented for
  the business's own channels (email signature, website, card).
- **ADR-126 Presentation seed (DEMO)** (amends ADR-81): sixth workspace `codecraft-web`
  (Codecraft Web Studio, Indore), a fourth DEMO persona `client` (Aarav Mehta, owner of
  codecraft-web), the operator persona assigned there with full operator capabilities, its own
  scoring version (`websitePreference 'ABSENT'`, target categories), a SIMULATED WHATSAPP_CLOUD
  integration with seeded web-dev templates (approved, pending, rejected with reason), a finished
  simulated finder run, leads, open-window conversations, one handed-over lead; existing workspaces
  and tenant-matrix fixtures unchanged; every new time column in `REBASE_COLUMNS`.
- **Capabilities** (+5 = 20): `finder.run`, `leads.import`, `consent.import`, `templates.manage`,
  `leads.handoff`. OWNER all; MEMBER += `leads.import`; seeded operator for codecraft-web gets all
  except `consent.import`.

## 2. Schema (Foundation-A, one migration `<ts>_lead_gen_suite`, ts after 20261020820000)

Enums: `LeadSource` += GOOGLE_PLACES, FILE_IMPORT; `WebsiteStatus` += NOT_LISTED; `IntegrationKind`
+= GOOGLE_PLACES; `ConsentSource` += FILE_IMPORT; new `LeadFinderRunStatus` (QUEUED RUNNING
SUCCEEDED PARTIAL FAILED CANCELLED), `LeadImportStatus` (PREVIEW QUEUED RUNNING SUCCEEDED FAILED
EXPIRED), `ImportDataSource` (OWN_CUSTOMERS OWN_FORM_OR_EVENT PUBLIC_DIRECTORY THIRD_PARTY_LIST),
`HandoffStatus` (HANDED_OVER ACKNOWLEDGED), `TemplateOrigin` (SYNCED AUTHORED), `MediaAssetKind`
(IMAGE DOCUMENT).

New tenant models (workspaceId, `@@unique([workspaceId, id])`, index starting with workspaceId,
composite FKs, Workspace back-relations, `REQUIRED_TENANT_MODELS`, `REF_MODELS` ids):
- `LeadFinderRun`: requestKey (@@unique with workspaceId), requestedBy, keywords Json, locations
  Json, maxPerQuery Int, extractEmails Boolean, emailBlacklist Json, status, cellsTotal, cellsDone,
  resultsFound, emailsFound (Int, default 0), simulated Boolean, errorCode String?, createdAt,
  startedAt?, finishedAt?, cancelledAt?; index [workspaceId, createdAt].
- `LeadFinderResult`: runId (composite FK Restrict), placeId, keyword, location, name String?,
  category?, phoneRaw?, hasPhone Boolean, website?, websiteListed Boolean, ratingX10 Int?,
  reviewCount Int?, address?, city?, state?, pincode?, attributions Json?, emails Json, emailCount
  Int, emailStatus String, simulated Boolean, contentExpiresAt DateTime?, importedLeadId String?
  (plain column), importedAt?, createdAt; @@unique([workspaceId, runId, placeId]); indexes
  [workspaceId, runId], [workspaceId, importedLeadId], [workspaceId, contentExpiresAt].
- `LeadImport`: requestKey, requestedBy, fileName, sheetName, sha256, rowCount, header Json,
  mapping Json?, dataSource ImportDataSource?, consentAttested Boolean, consentAttestedBy?,
  consentNoticeText?, consentNoticeHash?, status, accepted, duplicates, review, rejected,
  consentRecorded (Int, default 0), rejections Json, storagePath?, createdAt, expiresAt,
  finishedAt?; index [workspaceId, createdAt].
- `LeadHandoff`: leadId (composite FK to Lead, Restrict; @@unique([workspaceId, leadId])),
  fromUserId, note String?, summary String?, summaryGeneratorLabel String?, summaryStatus String,
  status HandoffStatus, acknowledgedBy?, acknowledgedAt?, createdAt; index [workspaceId, status,
  createdAt].
- `MediaAsset`: kind, fileName, mimeType, byteSize, sha256, storagePath, uploadedBy,
  providerHandle?, providerHandleAt?, createdAt.

Columns: `Lead` += handedOverAt?, pincode?, placeId?, placesContentExpiresAt?, contactConfirmedAt?,
contactConfirmedVia String?; indexes [workspaceId, handedOverAt], [workspaceId, placeId],
[workspaceId, placesContentExpiresAt]. `WhatsAppTemplate` += origin TemplateOrigin @default(SYNCED),
providerTemplateId?, rejectedReason?, submittedBy?, submittedAt?, headerMediaId? (composite FK to
MediaAsset, Restrict), copyGeneratorLabel?, utilityTrigger?; `syncedAt` nullable. `LeadExport` +=
format String @default("csv"). `Conversation` += escalatedAt?. `WorkspaceSettings` +=
whatsappOptInNotice String?, privacyContact String?.

Migration safety: generate against a scratch DB only; then apply it on a DEMO DB seeded at the
previous migration that has Message rows referencing WhatsAppTemplate and prove row counts and
`Message.templateId` survive the table rebuild (test in `tests/integration/db/`).

## 3. Foundation-A (one implementer, serial, in the integration checkout)

Commit the plan; append ADR-117..126 to `docs/decisions.md`; the schema + migration + generate; and
every fan-out edit so the tree compiles and the existing tests pass:
- `src/lib/domain/enums.ts` mirrors (+ `tests/unit/lib/domain-enums.test.ts` names and the exact
  capability list, 20; `tests/components/admin/people-admin.test.tsx` count 20).
- `src/server/db/scoped.ts` REQUIRED_TENANT_MODELS (+5) and REF_MODELS (runId, finderResultId,
  importId, mediaAssetId, handoffId).
- `src/server/auth/guards.ts` MEMBER_CAPABILITIES += leads.import.
- Labels: `src/components/admin/people-vocabulary.ts` (CAPABILITY_LABELS x5, INTEGRATION_KIND_LABELS),
  `src/app/dashboard/employee/page.tsx` (CAPABILITY_LABELS x5, CAPABILITY_AREAS), `src/server/services/leads/csv.ts`
  (LEAD_SOURCE x2, WEBSITE_STATUS NOT_LISTED), `src/components/patterns/source-style.ts` (2, same
  labels; visual test constraints), `src/components/leads/lead-vocabulary.ts` (WEBSITE_LABELS
  NOT_LISTED = "No website listed"), `src/components/leads/ConsentChips.tsx` (FILE_IMPORT).
- Integrations: `src/lib/domain/integrations.ts` GOOGLE_PLACES catalog entry (slug google-places,
  group sources, credentialFields apiKey, demoNote contains "never contacted", prerequisites), and
  WHATSAPP_CLOUD optional config `appId`, `displayPhoneNumber`; rewrite the "never written here"
  template prerequisite; `src/lib/schemas/integrations.ts` CONFIG/CREDENTIAL rules;
  `src/components/integrations/vocabulary.ts` KIND_ICONS; count tests (7 -> 8) in
  `tests/integration/integrations/employee-overview.test.ts`, `integration-center.test.ts`.
- `syncedAt: Date | null` in `src/server/services/integrations/center.ts` and
  `src/components/integrations/TemplateTable.tsx` ("Not synced yet"); any other consumer.
- Scoring minimal compile fix: `score.ts` handles NOT_LISTED and the new sources (full behaviour and
  tests in B1 if not done here).
- Gate: typecheck, lint, `tests/unit`, `tests/integration/db`, `tests/integration/authz/tenant-matrix.test.ts`,
  `tests/integration/integrations`, `tests/components/admin`, `tests/components/leads`, the migration
  safety test. Commit.

## 4. Foundation-B (three parallel worktrees from Foundation-A, merged before the slices)

- **B1 data**: ingest fields (`pincode`, `websiteListed`, `placeId`; GOOGLE_PLACES sets
  `Lead.placeId` and `placesContentExpiresAt` = now + 30 d), normalize NOT_LISTED rule, scoring
  NOT_LISTED + GOOGLE_PLACES intent (like GMAPS_EXTENSION) + FILE_IMPORT reason, enrichment no-op,
  `leadExportRelPath(ws, id, format)`, `lead-erase.ts` coverage (LeadHandoff delete, finder results
  blanked + importedLeadId nulled, import files deleted, xlsx exports), `REBASE_COLUMNS` for every
  new time column, `src/server/services/leads/handoff-guard.ts` `assertNotHandedOver` wired into
  `queueOutboundMessage` and `conversations.ts` mode changes. Tests for each.
- **B2 AI**: `src/server/services/ai/run-task.ts` (`selectWorkspaceAi`, `runStructuredTask` with one
  repair retry; drafts.ts moved onto them, existing AI tests unchanged); `local-deterministic.ts`
  becomes a dispatcher on `task` with `src/server/adapters/ai/local/draft.ts` and a `LOCAL_TASKS`
  map with anchor comments for `conversation_reply`, `template_copy`, `handoff_summary`;
  `src/components/ai/AiProvenance.tsx` (violet only when generatorInfo kind is ai; "Local template"
  for local-deterministic) and `src/components/ai/AiActionButton.tsx`; lint-rule tests if needed.
- **B3 shared**: `src/lib/domain/whatsapp-templates.ts` sources + pure `resolveLeadTemplateVariables`;
  `src/lib/domain/lead-gen.ts` (emailStatus values, summaryStatus values READY PENDING
  NOT_CONFIGURED FAILED, template statuses DRAFT SUBMITTING, AI task names, job type names
  leadFinder.search leadFinder.emails leadFinder.purge leads.placesExpire leads.import
  leads.importPurge wa.templateSubmit wa.templateReview wa.demoStatus handoff.summary, owners
  T40..T45); `--chat-*` tokens in `src/styles/tokens.css` + `globals.css` with tokens/contrast tests;
  `RATE_LIMIT_POLICIES` += finderRun, leadImport, templateSubmit, handoff (+ exact test); anchor
  comment blocks (`// ---- lead-gen F1 Finder ----` ... F6) in `src/server/routes.manifest.ts`,
  `src/server/jobs/registry.ts` (imports and array), `src/components/metrics/activity-vocabulary.ts`,
  `src/server/adapters/registry.ts`, `tests/support/routes.ts`, `tests/unit/arch/registry-live.test.ts`;
  `src/components/integrations/sections.ts` gets an anchor comment (slices add their section with
  their page).

## 5. Slices (parallel worktrees from the merged foundation)

Every slice: own paths only + its own anchor blocks; no edits to schema, migrations, package.json;
tests first; slice gate (section 7); LIVE shows configuration gates and no demo wording; DEMO shows
Simulated and makes zero outbound calls (tripwire test); a handoff note in
`docs/handoff/lead-gen-<slice>.md` listing shared-file insertions, job types, rate-limit names,
activity labels, fixture keys and open questions. Route manifest owners: F1 T40, F2 T41, F3 T42, F4
T43, F5 T44, F6 T45. Matrix fixtures use well-formed unknown id probes, not seeded rows.

**F1 Lead Finder (ADR-118)** owns `src/server/adapters/places/**`, `src/lib/demo/places.ts`,
`src/server/services/lead-finder/**`, `src/server/jobs/handlers/lead-finder-*.ts` and
`leads-places-expire.ts`, `src/app/api/app/finder/**`, `src/app/dashboard/employee/[ws]/finder/**`,
`src/components/finder/**`, live tester entry, `tests/**/finder/**`, `tests/fixtures/places/**`.
P0: port, google-places.ts via `outboundRequest` (key scrubbed, documented-shape fixtures
`verified:false`), demo provider, registry resolver + registry-live lists, startFinderRun
(`finder.run`, caps 10 keywords x 10 locations, maxPerQuery 20/40/60, requestKey, rate limit),
`leadFinder.search` (one HTTP call per job, self-continuation, serialKey per run, priority 10),
results with filters (columns, not JSON), importFinderResults (`leads.write`, ingestBatch
GOOGLE_PLACES, `websiteListed`, attribution keyword/location), Excel export (LIVE limited columns,
DEMO full; via a requester-only download), purge job (24 h), attribution UI, page with run form,
progress (polling), results table (selection, filters, No website chip, Simulated chip), section
`finder` in WORKSPACE_SECTIONS. P1: email extraction job (LIVE safeFetch rules, DEMO
`@demo-leads.in`), cancel, Refresh expired details, `leads.placesExpire` + operator "Confirm details"
route. Tests: contract (scripted transport), services, jobs, routes/matrix, imported leads stay
NO_WHATSAPP_OPT_IN, DEMO tripwire, components.

**F2 Import/Export (ADR-120)** owns `src/lib/schemas/lead-import.ts`, `src/server/services/leads/import*.ts`,
`src/server/jobs/handlers/lead-import*.ts`, `src/app/api/app/leads/imports/**`,
`src/app/api/app/leads/sample-workbook/**`, `src/app/dashboard/employee/[ws]/leads/import/**`,
`src/components/leads/import/**`, export format in `services/leads/export.ts`,
`jobs/handlers/lead-export.ts`, the export routes and export UI control, `CAPTURE_SOURCES` /
backfill flag in `services/messaging/consent.ts`. P0: upload -> PREVIEW (storage file, header + 20
rows, suggested mapping), confirm -> job -> counts + reasons, purge, sample workbook, xlsx export.
P1: consent column path with every ADR-120 guard. Tests: synonyms, upload limits/errors, job
chunks, purge, consent never clears suppression, no attestation -> no consent, export xlsx,
lead-erase of xlsx export.

**F3 Chat + AI replies (ADR-121/122)** owns `src/components/inbox/**`, `src/app/dashboard/user/inbox/**`,
`src/app/dashboard/employee/[ws]/inbox/**`, `src/app/api/app/messages/**`, `src/app/api/app/conversations/**`,
`src/app/api/app/settings/auto-send/**`, `src/lib/schemas/inbox.ts`, `services/messaging/inbox.ts`,
`services/messaging/conversations.ts`, `services/ai/conversation-reply.ts`, `services/ai/reply-guard.ts`,
`jobs/handlers/reply-auto.ts`, `adapters/ai/local/conversation-reply.ts` (+ LOCAL_TASKS line),
`jobs/handlers/wa-demo-status.ts` + the one-line DEMO settle hook in `jobs/handlers/dispatch-run.ts`,
the existing T22 manifest entries it widens. P0: employee inbox pages (basePath/workspaceSlug
props), widened routes, WhatsApp-like UI with `--chat-*` tokens (thread list with initials, preview,
time, window badge, handed-over badge + timeline event + read-only state for EMPLOYEE from
`Lead.handedOverAt`), composer with per-lead template variables, Automatic replies control,
conversation_reply per ADR-122 with contract tests (scripted AI port) and the DEMO local branch,
escalatedAt feeding Needs you, reply cap, disclosure. P1: DEMO delivered/read ticks.

**F4 Template studio (ADR-123)** owns `services/integrations/template-authoring.ts`,
`services/integrations/media-assets.ts`, `adapters/whatsapp/template-admin*.ts`,
`services/integrations/template-sync.ts` (authored rows), `jobs/handlers/template-submit.ts`,
`template-review.ts`, `adapters/ai/local/template-copy.ts` (+ LOCAL_TASKS line),
`services/ai/template-copy.ts`, `src/app/api/app/templates/**`, `src/app/api/app/media/**`,
`src/app/dashboard/employee/[ws]/templates/**`, `src/components/templates/**`, bulk per-lead
variables in `services/bulk/bulk.ts`, header-media send in `services/messaging/dispatch.ts` +
`jobs/handlers/dispatch-run.ts` (send plan only; F3 owns the settle hook line), `templateShape`
DOCUMENT-with-asset rule in `whatsapp-templates.ts` (coordinate: B3 adds the resolver above it).
P0: draft CRUD + validation, category-first form, AI copy, preview bubble, DEMO submit + simulated
review, LIVE submit job (text/no header) with scripted Graph tests, sync of authored rows, bulk
per-lead variables, STOP button default, UTILITY trigger + promo warning, section `templates`.
P1: PDF brochure MediaAsset upload + LIVE resumable upload + document-header send.

**F5 Lead actions: handoff + reach-out (ADR-124/125)** owns `services/leads/handoff.ts`,
`services/ai/handoff-summary.ts`, `adapters/ai/local/handoff-summary.ts` (+ LOCAL_TASKS line),
`jobs/handlers/handoff-summary.ts`, `src/app/api/app/leads/[leadId]/handoff/**`,
`src/app/api/app/handoffs/**`, `src/app/api/app/leads/[leadId]/confirm-contact/**` (if F1 does not),
`src/app/api/app/settings/reach-out/**`, `src/components/handoff/**`, `src/components/reach-out/**`,
command-center count (`services/metrics/definitions.ts`, `command-center.ts`), `handedOver` leads
filter (`src/lib/schemas/leads.ts` filter lines, `services/leads/list.ts`, leads toolbar control),
the opt-in recording improvements in the consent grant service/route and its UI, and wiring of
its components into both lead pages. P0: handOverLead + routes + summary job + client surfaces +
Acknowledge; reach-out panel (record opt-in with notice + method, click-to-chat). Tests: atomicity
(CAS conflict writes nothing), second handoff 409, guard on every EMPLOYEE send path, summary DEMO
and LIVE NOT_CONFIGURED, notice must contain business name, keyword prefill refused.

**F6 Presentation (ADR-126)** owns `prisma/seed/**`, `src/lib/demo/personas*`/RoleSwitcher persona
additions, `/api/demo/session` schema, landing copy (`src/components/landing/**`: Find, Chat, Hand
over, Quote; Google Places and Excel import in Capture; no "scraped" wording; also
`employee/[ws]/leads/simulation-panel.tsx`, `extension/page.tsx`, `integrations/page.tsx` wording),
`content/docs/**` and README updates after the merge, `docs/progress.md`, `docs/integrations.md`
(Places terms check date). P0: codecraft-web seed per ADR-126 (written against the foundation schema;
finder/handoff/template rows inserted directly with seedId), client persona with tests updated,
REBASE_COLUMNS, determinism/test-reset updates. Docs after merge.

## 6. Shared files

Append inside your own anchor block only: `src/server/routes.manifest.ts`, `src/server/jobs/registry.ts`,
`src/components/metrics/activity-vocabulary.ts`, `src/server/adapters/registry.ts`,
`tests/support/routes.ts`, `tests/unit/arch/registry-live.test.ts`, `src/components/integrations/sections.ts`,
`src/server/adapters/ai/local-deterministic.ts` LOCAL_TASKS (one line). Anything else outside your
paths: note it in your handoff file and leave it to the integrator.

## 7. Worktree protocol and slice gate

Worktrees live in `C:\Users\Asus\auralead-wt\<name>` (outside OneDrive), branch `lg/<name>`,
`node_modules` is a junction to the integration checkout (never `npm install` there), `.env` copied
with `AURALEAD_DATA_DIR=C:/Users/Asus/auralead-wt/_data/<name>`. After branching or merging:
`node node_modules/prisma/build/index.js generate`. Slice gate:
`npm run typecheck`; `npx eslint <your paths> <shared files you edited>`;
`npx vitest run --maxWorkers=2 tests/unit/arch tests/unit/lib/domain-enums.test.ts tests/unit/integrations tests/unit/docs tests/integration/authz/tenant-matrix.test.ts <your test dirs>`.
No full `npm run test` in slices; no dev servers in slices; at most three slices run tests at once.

## 8. Merge order and integrator

Foundation-B merges B1, B2, B3, then the full suite once (baseline). Slices merge F5, F2, F1, F4,
F3, F6; after each: generate, typecheck, lint, arch + matrix + merged slices' tests. Integrator
writes cross-slice tests (HANDED_OVER on every send path; Places/import leads skipped
NO_WHATSAPP_OPT_IN in bulk; lead-erase of a lead with finder result + handoff + xlsx export; worker
boot with all job types), wires the lead-page components, runs the full suite alone, walks the DEMO
story in the browser on a fresh data dir, checks a fresh LIVE install.

## 9. Presentation notes (for the owner)

Run of show (10 min): problem + glossary (Operator = AuraLead team, Client = Codecraft Web Studio,
Lead = a business found on Maps) -> Finder with the No-website filter, import, Excel -> one lead's
score breakdown ("No website listed") -> template send to opted-in leads + click-to-chat -> chat:
AI answers a services question, a price question escalates, take over -> template studio, AI
generate, submit, simulated approval -> hand over (two browser profiles) -> client creates and
approves a quote, PDF, public accept page -> LIVE proof (real Places search; template on the
presenter's phone through Meta's test number) -> admin Jobs and Audit. Present from a production
build (`npm run build`, `npm run start`, `npm run start:worker`), run `npm run demo:refresh` ten
minutes before, warm every route once, 125% zoom. LIVE proof setup is the owner's: Places API key
with billing, Meta app with the WhatsApp test number and the presenter's phone as a recipient, an
Anthropic key; LIVE inbound chat needs a public HTTPS tunnel (stretch).

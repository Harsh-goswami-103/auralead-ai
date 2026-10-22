# Lead-gen suite, Foundation-B1 (data): handoff

Branch `lg/b1`, built on Foundation-A (`61b4352`). Plan section 4 "B1 data"; ADR-118, ADR-119,
ADR-120, ADR-124, ADR-126. Tests were written first. Nothing in `prisma/schema.prisma`,
`prisma/migrations/**` or `package.json` changed.

## What is built

### Ingest fields (ADR-118, ADR-119)
- `src/lib/schemas/ingest/batch.ts`: `ingestFieldsSchema` gains `pincode` (string or number),
  `websiteListed` (boolean) and `placeId` (string). `ingestBatchSchema` refuses a record whose
  `fields.placeId` and `providerId` are both given and differ (a ZodError, which routes answer as a
  400 ValidationError; nothing is written).
- `src/server/services/leads/normalize.ts`: `normalizePincode` (six digits, any Unicode digit
  script, spaces and hyphens ignored, never starting with 0; anything else is null). `NormalizedLead`
  gains `pincode` and the website status `NOT_LISTED`: set only when `websiteListed === false` and the
  website field is empty. A supplied URL wins (PRESENT_UNVERIFIED). A value that is not a usable URL
  is UNKNOWN, never NOT_LISTED. Normalization does not depend on the source.
- `src/server/services/leads/ingest.ts`: a new lead gets `pincode`. A GOOGLE_PLACES lead also gets
  `placeId` (from `providerId`, or else `fields.placeId`; the same value is used for its PROVIDER key
  `GOOGLE_PLACES:<placeId>`) and `placesContentExpiresAt` = `ctx.clock.now()` + 30 days. That date is
  set for simulated (DEMO) Places leads too. Other sources never get `placeId` or a Places expiry. A
  duplicate still never modifies the existing lead. Exported: `PLACES_CONTENT_TTL_DAYS` (30) and
  `PLACES_CONTENT_TTL_MS`.

### Scoring and enrichment (ADR-119)
- Foundation-A already finished `score.ts` (NOT_LISTED is known: full points with
  `websitePreference 'ABSENT'`, a known 0 with PRESENT; GOOGLE_PLACES gets the same source intent as
  GMAPS_EXTENSION; FILE_IMPORT has its own unknown reason, `SOURCE_FILE_IMPORT`), together with its
  unit tests. B1 adds an end-to-end test: a Places NOT_LISTED lead goes through the SCORE stage in
  DEMO without a fetch and earns 20/20 website points labelled "No website listed".
- `src/server/services/enrichment/website.ts`: `checkLeadWebsite` returns the not-checked reason
  `NOT_LISTED` (new `NotCheckedReason`) for a NOT_LISTED lead without a URL. Nothing is fetched, the
  status is kept, and the `lead.enrich` audit records `{checked:false, reasonCode:'NOT_LISTED'}`, in
  LIVE and in DEMO. Enrichment never sets NOT_LISTED.

### Export path
- `src/server/services/leads/export.ts`: `LEAD_EXPORT_FORMATS = ['csv','xlsx']`, `LeadExportFormat`, and
  `leadExportRelPath(workspaceId, exportId, format)`, which gives `exports/<ws>/<id>.<format>` and
  refuses an unknown format or ids that are not plain identifiers.
- Callers: `jobs/handlers/lead-export.ts` passes `'csv'`, because it still writes CSV bytes (CSV
  behaviour is unchanged). `lead-erase.ts` deletes a queued export under both names.

### lead:erase coverage (`src/server/services/admin/lead-erase.ts`)
- Deletes the lead's `LeadHandoff` rows (`counts.leadHandoffs`).
- Clears the Lead Finder results of the person's place. A result is the person's place when
  `importedLeadId` is one of the erased leads, or its `placeId` equals the lead's `placeId` or the
  place ID in a GOOGLE_PLACES or GMAPS_EXTENSION PROVIDER key. The erase nulls name, category,
  phoneRaw, website, ratingX10, reviewCount, address, city, state, pincode, attributions,
  `importedLeadId` and `importedAt`; sets `hasPhone` to false; sets `emails` to `[]` and `emailCount`
  to 0. It keeps placeId, keyword, location, websiteListed, emailStatus, contentExpiresAt and
  contentPurgedAt. Count: `finderResultsBlanked`.
- Imports: every LeadImport of the workspace that still holds a parsed-rows file (`storagePath`) has
  that file deleted after the commit and `storagePath` nulled. Pending imports are also ended: PREVIEW
  becomes EXPIRED and QUEUED or RUNNING becomes FAILED, each with `finishedAt` = now. Count:
  `importsEnded`.
- xlsx exports are ended exactly like CSV ones. A READY export's stored `path` is deleted. For a QUEUED
  export both `<id>.csv` and `<id>.xlsx` are deleted.
- Jobs whose payload names the handoff id or an ended import id are cancelled together with the
  person's other jobs.
- `EraseLeadResult` and the `lead.erase` tombstone gain `finderResultsBlanked` and `importsEnded`.

### Rebase (`prisma/seed/rebase.ts`)
`REBASE_COLUMNS` gains:
- `Lead`: handedOverAt, placesContentExpiresAt, contactConfirmedAt
- `WhatsAppTemplate`: syncedAt, submittedAt
- `Conversation`: escalatedAt
- `LeadFinderRun`: createdAt, startedAt, finishedAt, cancelledAt
- `LeadFinderResult`: contentExpiresAt, contentPurgedAt, importedAt, createdAt
- `LeadImport`: consentAttestedAt, createdAt, expiresAt, finishedAt
- `LeadHandoff`: acknowledgedAt, createdAt
- `MediaAsset`: providerHandleAt, createdAt

`tests/integration/seed/rebase-columns.test.ts` checks this list two ways. First it parses the schema:
every DateTime column of the five new tables and of the named columns must be listed, and every listed
column must exist and be a DateTime column. Then it runs `refreshDemo` and checks that each column
moves by exactly the shift and that nulls stay null.

### Handoff guard (`src/server/services/leads/handoff-guard.ts`, ADR-124)
- `assertNotHandedOver(tx, ctx, leadId, opts?: { initiatedBy })` throws `HandedOverError`, a
  `ConflictError` with code `HANDED_OVER`, status 409 and `safeDetails: { leadId }`. It throws only
  when `Lead.handedOverAt` is set and the acting person is an EMPLOYEE. An unknown lead is left to the
  caller.
- `isEmployeeActor(db, ctx, initiatedBy?)` decides who is acting: the ctx actor's role, or, for a job
  context with no actor, the user named by `initiatedBy`. `system:*` initiators are never refused.
- `handedOverLeadIds(db, leadIds)` is a helper for list or bulk callers.
- Where it runs, all inside the caller's transaction, so a refusal writes nothing:
  - `services/messaging/dispatch.ts`:
    - `queueOutboundMessage`, after the idempotent replay and with `initiatedBy`. This covers composer
      sends, bulk, quick replies, the pipeline and reply.auto. System sends pass.
    - `createMessageDraft`
    - `approveAndSendMessage` (the lead comes from the message's conversation)
    - `approveAndSendQuote`, before the quote is approved
  - `services/messaging/conversations.ts`: `changeMode`, which covers `setConversationAiMode`,
    `takeOverConversation` and `resumeConversationAi`.
  - `services/bulk/bulk.ts`: an operator's run reports a handed-over lead as a FAILED row with
    `HANDED_OVER` (label "Handed over to the client", added to `BULK_FAILURE_LABELS`). This applies in
    `previewBulkAction` and `requestBulkRun` (the ctx actor) and in the `bulk.run` job (the run's
    `requestedBy`). The job would otherwise throw inside a chunk and keep retrying.
- It is not an eligibility reason. `REASON_LABELS`, the dispatch preflight and their docs are
  unchanged, and a test pins that.

## Files outside the B1 list that B1 edited (merge notes)
- `src/server/services/bulk/bulk.ts`, which F4 also edits for per-lead variables. B1's changes: the
  import, one `BULK_FAILURE_LABELS` entry, the `classifyRows` signature (new last parameter
  `byEmployee`), `handedOverAt` in its select, one check after LEAD_MERGED, and the three call sites.
- `src/server/jobs/handlers/lead-export.ts` (F2): one line, `leadExportRelPath(..., 'csv')`.
- `src/server/services/messaging/dispatch.ts` (F4 adds the header-media send): the import, a header
  comment and four guard calls.
- `src/server/services/messaging/conversations.ts` (F3): the import, a header comment and one guard
  call in `changeMode`.
- `prisma/seed/rebase.ts` (F6 owns `prisma/seed/**`): the REBASE_COLUMNS entries listed above.

B1 made no shared-file anchor-block insertions and added no job types, rate-limit names, activity
labels, route-manifest entries or fixture keys.

## Notes for the slices
- **F1:** `importFinderResults` should send source GOOGLE_PLACES with `providerId: placeId` (or
  `fields.placeId`), `fields.websiteListed` and `fields.pincode`. `placesContentExpiresAt` is written
  by ingest; `leads.placesExpire` should select on it. Erased places keep their finder rows (place ID,
  keyword, location), so **Refresh** (Place Details by id) could fetch an erased person's listing
  again. Consider refusing Refresh for rows whose content was cleared by an erase. There is no erased
  marker column today; this is a question for the integrator.
- **F2:**
  - `leadExportRelPath` now needs a format. When the job writes xlsx, pass the row's format and make
    `leadExportFileName` and the download content type format-aware (both still assume csv).
  - The import job must recheck, in each chunk's fenced transaction, that the import is still RUNNING
    and that `storagePath` is set. `lead:erase` may set it FAILED, null `storagePath`, delete the file
    and cancel the job.
  - Keep the parsed-rows file in `storagePath`: the erase deletes only that path.
  - `normalizeLeadFields` honours `websiteListed` from any source, but `IMPORT_MAPPABLE_FIELDS` has
    no such column, so imports stay UNKNOWN unless F2 maps one.
- **F3:**
  - Once the inbox routes accept EMPLOYEE, `sendComposerMessage`, `saveComposerDraft` and the
    mode/takeover/resume routes answer 409 HANDED_OVER for a handed-over lead.
  - `sendComposerMessage` runs its eligibility check before `queueOutboundMessage`, so an operator in
    a closed window sees 422 SEND_REFUSED, not 409. Read `Lead.handedOverAt` for the read-only UI
    instead of relying on the error.
  - `reply.auto` runs in a job context with a `system:` initiator, so the guard never refuses it.
    ADR-122 requires it to recheck `handedOverAt` itself.
- **F5:** `handOverLead` only needs to set `Lead.handedOverAt`; the guard reads that column. Import
  `HandedOverError` / `assertNotHandedOver` from `services/leads/handoff-guard.ts`. `handOverLead`
  runs as the operator. If it reuses `takeOverConversation` or `setConversationAiMode` (which pass
  through the guard), it must call them before it sets `handedOverAt` in the same transaction, or
  update the conversations directly with the same `modeVersion` compare-and-set.
- **F6:** `REBASE_COLUMNS` for Conversation lists only `escalatedAt`. Seeded open-window conversations
  also need `createdAt` and `lastInboundProviderAt`, and Message `createdAt` and `providerTs`.
  `tests/integration/seed/rebase-columns.test.ts` accepts additions as long as they are DateTime
  columns.

## Open questions for the integrator
- Should the deviations above be recorded in `docs/decisions.md` (ADR-124 / ADR-120 notes)? B1 did not
  edit that file. They are:
  - the guard also covers drafts and quote sends;
  - job-context sends resolve the actor from `initiatedBy`;
  - bulk reports HANDED_OVER as a row failure;
  - erase clears finder rows by place ID, not only by `importedLeadId`.
- An erasure ends every pending import of the workspace, not only imports that contain the person,
  because the rows cannot be matched reliably without re-parsing. This is the same approach as the
  exports (ADR-73).

## Deferred
Nothing from plan section 4 "B1 data".

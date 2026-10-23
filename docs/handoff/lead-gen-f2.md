# Lead-gen slice F2: Import and Excel export (handoff)

Branch `lg/f2`, worktree `C:\Users\Asus\auralead-wt\f2`, from the merged foundation (`0ece53b`).
Spec: plan §5 "F2 Import/Export", ADR-120; the edges settled here are **ADR-129** (appended to
`docs/decisions.md`). Manifest owner T41.

## What was built

**P0**
- `src/lib/schemas/lead-import.ts`: `IMPORT_MAPPABLE_FIELDS`, limits (2,000 rows, 200 per chunk, 20
  preview rows, 24 h, 5 MB file, `LEAD_IMPORT_MAX_BODY_BYTES` about 7 MB), upload and confirm bodies,
  the column mapping (field -> column index), `suggestImportMapping` (header synonyms: exact names,
  then word rules, one field per column), `parseConsentDate`, `consentAttestationText`,
  `noticeProblems`, row note codes and labels, DTOs. Pure and browser-safe.
- `src/server/services/leads/import.ts`: `uploadLeadImport` (base64 -> `readTable`, 422 codes,
  PREVIEW `LeadImport`, rows file, `leads.importPurge` at `expiresAt`, audit), `getLeadImportView`,
  `listLeadImports` (requester only), `confirmLeadImport` (+ `decideImportConsent`, P1),
  `loadLeadImportPage`, `buildLeadImportSampleWorkbook`.
- `src/server/services/leads/import-files.ts`: path-guarded writer/reader/deleter of
  `STORAGE_DIR/imports/<ws>/<id>.json` (temp + rename).
- `src/server/services/leads/import-run.ts` + `src/server/jobs/handlers/lead-import.ts`: `leads.import`
  (one job per 200-row chunk through `ingestBatch`, source FILE_IMPORT, batch `import:<id>:<chunk>`,
  record `import:<id>:row:<n>`; re-checks RUNNING + `storagePath` right before ingesting, as the
  baseline asked; counts each chunk once; last chunk SUCCEEDED + file deleted) and
  `leads.importPurge` (PREVIEW -> EXPIRED + file deleted at expiry; QUEUED/RUNNING deferred 1 h while a chunk job is queued or running, otherwise FAILED `IMPORT_STALLED` + file deleted).
- Routes: `POST/GET /api/app/leads/imports`, `GET /api/app/leads/imports/[importId]`,
  `POST /api/app/leads/imports/[importId]/confirm`, `GET /api/app/leads/sample-workbook`.
- Page `/dashboard/employee/[ws]/leads/import` with `src/components/leads/import/**`: drag and drop +
  file input, mapping selects with suggestions, preview table, data source select, opt-in section
  (owner only), confirm, polling progress, result with counts and grouped row reasons, recent
  imports, Download sample workbook, the file instructions in the page copy (never in the sheet).
- Lead export `format csv|xlsx`: `LeadExportBody.format` (default csv), `LeadExportDto.format`,
  `requestLeadExport` (reuse compares the format), `buildLeadExportRows` / `buildLeadExportFile`
  (xlsx from `LEAD_CSV_HEADER` / `leadCsvRow`, sheet "Leads"), the job writes `.xlsx`,
  `leadExportFileName(..., format)`, the download route's content type, and a "File type" control in
  `LeadExportPanel` ("Download Excel" / "Download CSV").

**P1 (consent path, every ADR-120 guard)**
- `services/messaging/consent.ts`: `FILE_IMPORT` in `CAPTURE_SOURCES`; backfilled sources;
  FILE_IMPORT capture re-reads the attested `LeadImport` (`mapping.formId`), evidence
  `{responseId, importId, row, attestedBy, noticeHash}`, `recordedBy` = the attesting owner; a
  suppressed contact gets no record (`SUPPRESSED_CONTACT`). New none-reasons `NOT_ATTESTED`,
  `SUPPRESSED_CONTACT`.
- `services/messaging/suppression.ts` (outside the listed paths, see below):
  `clearSuppressionForConsent(..., { backfilled })` answers `BACKFILLED_SOURCE`, audited
  `suppression.clear_refused`; `ReoptInConsent.id` may be null for that pre-check.
- Confirm: ignored for no attestation / no `consent.import` / not-own data source; 422 for a
  missing opt-in or date column, a notice without the business name or WhatsApp, an edited
  attestation, a future opt-in date (ADR-129).

## Shared-file insertions (inside the F2 anchor blocks only)

| File | Insertion |
|---|---|
| `src/server/routes.manifest.ts` | 5 entries, owner T41 (below) |
| `src/server/jobs/registry.ts` | import `leadImportJob, leadImportPurgeJob` from `./handlers/lead-import`; both in `JOB_DEFINITIONS` |
| `src/components/metrics/activity-vocabulary.ts` | `lead.import.upload`, `lead.import.confirm`, `lead.import.complete`, `lead.import.failed`, `lead.import.expire` |
| `tests/support/routes.ts` | fixture `imports.unknownImportId` = `importmatrixprobe00000000` |

## Edits outside the owned paths (for the integrator to review)

- `src/lib/schemas/leads.ts` (export block, lines ~148-176 only): `LEAD_EXPORT_FORMATS`,
  `LeadExportFormat`, `LEAD_EXPORT_FORMAT_LABELS`, `LeadExportBody.format`, `LeadExportDto.format`.
  F5 edits the filter lines of the same file; the hunks do not overlap.
- `src/server/services/messaging/suppression.ts`: the `backfilled` option of
  `clearSuppressionForConsent` (ADR-120 names the function; it lives here, not in consent.ts).
- `tests/components/leads/scoring-and-export.test.tsx`: the export fixture gained `format: 'csv'`.
- `docs/decisions.md`: ADR-129 appended.

## Names

- Job types: `leads.import` (payload v1 `{importId, chunk}`, key `leads.import:<id>:<chunk>`,
  priority 10, kind default), `leads.importPurge` (payload v1 `{importId}`, key
  `leads.importPurge:<id>`, run at `expiresAt`).
- Rate limit: `leadImport` on upload and confirm, key `lead-import:<userId>:<workspaceSlug|active>`.
- Audit actions: `lead.import.upload`, `lead.import.confirm`, `lead.import.complete`,
  `lead.import.failed`, `lead.import.expire`; consent reuses `consent.capture` and
  `suppression.clear_refused` (reason code `BACKFILLED_SOURCE`); exports add `format` to
  `lead.export.request`.
- Manifest entries (T41): page `/dashboard/employee/[ws]/leads/import` (capability `leads.read`, the
  upload gated without `leads.import`); `/api/app/leads/imports` POST + GET; `/api/app/leads/imports/[importId]`
  GET; `/api/app/leads/imports/[importId]/confirm` POST (all `leads.import`); `/api/app/leads/sample-workbook`
  GET (any signed-in USER or EMPLOYEE: fictitious data only).
- Fixture key: `imports.unknownImportId`.

## Baseline issues addressed to F2 (docs/progress.md)

- `leadExportFileName` and the download content type are format-aware now.
- The import job re-checks RUNNING and `storagePath` before ingesting each chunk (tested with
  `lead:erase` between chunks and with a status change left without a cancelled job).

## For the integrator

1. **Link the import page** from the employee lead console (not an F2 file):
   `src/app/dashboard/employee/[ws]/leads/page.tsx`, PageHeader `actions`, e.g. a secondary
   `Link` "Import leads" (lucide `FileUp`) to `/dashboard/employee/${slug}/leads/import`.
2. Activity labels outside the F2 block now read slightly wrong for imports:
   `suppression.clear_refused` "Opt-out kept (consent was older)" (also used for
   `BACKFILLED_SOURCE`; suggest "Opt-out kept (the consent could not clear it)") and
   `consent.capture` "Consent captured from a form" (suggest "Consent recorded from a form or an
   attested import").
3. `content/docs` rate-limit table lacks `leadImport` (already on F6's list).
4. The cross-slice "import leads skipped NO_WHATSAPP_OPT_IN" is covered for imports in
   `tests/integration/import/import-consent.test.ts` (eligibility check after an import without
   attestation).

## Deferred / open

- A chunk job that dies without its settle (a thrown error such as a missing SUPPRESSION_PEPPER, or the lease reaper at max attempts) leaves the import showing Queued or Importing until `leads.importPurge` ends it at its expiry (FAILED `IMPORT_STALLED`, rows deleted). Ingestion errors end it at once.
- Opt-in dates are day-first, ISO or an Excel serial; month-name dates (`14 Sep 2026`) get a `CONSENT_DATE_INVALID` row note and no consent.
- No client-panel (USER) import page; the routes accept USER (an owner's own workspace) so one can
  be added later with the same components.
- The rows file holds every column (the mapping is chosen after upload) until it is deleted at
  completion or 24 h; no schema change requested.
- Header synonyms are English only (no Hindi headers).

## Tests

`tests/unit/import/**`, `tests/integration/import/**` (upload, job, consent, page, tripwire, xlsx
export), `tests/components/import/**`, plus the touched `tests/components/leads/scoring-and-export.test.tsx`.

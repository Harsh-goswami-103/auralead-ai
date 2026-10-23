# Lead-gen F4: Template studio (ADR-123, ADR-131)

Branch `lg/f4`, route-manifest owner T43. P0 and P1 are both done. Rules that differ from the ADR text are in ADR-131 (appended at the end of `docs/decisions.md`).

## What was built

**P0**
- `src/lib/domain/template-authoring.ts` (framework-free): draft type, Meta's limits and the studio rules in `checkTemplateDraft(draft, { forSubmit })`. Errors block saving (name `[a-z0-9_]` up to 512, language, header TEXT up to 60 chars and one `{{1}}`, body up to 1024 with sequential `{{1}}..{{n}}`, footer up to 60, up to 3 quick replies or up to 2 URL and 1 phone button in Meta's grouping order, one-line texts) or, with `forSubmit`, the submission (example for every variable, document for a DOCUMENT header, UTILITY trigger). Warnings never block: promotional words on UTILITY, a MARKETING template without the Stop button, a header variable the app cannot fill, and (P1) a brochure on UTILITY.
- `src/lib/schemas/templates.ts`: route bodies, `draftOf`, media upload body.
- `src/server/services/integrations/template-authoring.ts`: `getTemplateStudio`, `createTemplateDraft`, `updateTemplateDraft`, `deleteTemplate`, `submitTemplate`, `runTemplateSubmit` (job), `runTemplateReview` (job). `templates.manage` is checked in the service.
- `src/server/services/ai/template-copy.ts` (`template_copy` through `selectWorkspaceAi` and `runStructuredTask`; the category is fixed by the person and the output is checked: variables only as `{{n}}`, no prices) and the local DEMO branch `src/server/adapters/ai/local/template-copy.ts` (web-development oriented, deterministic), registered in `LOCAL_TASKS`.
- Port `src/server/adapters/whatsapp/template-admin.ts` (Graph: create, delete by name, resumable upload) and `template-admin-demo.ts` (simulated WhatsApp Manager, zero network), resolved in `adapters/registry.ts` by `whatsAppTemplateAdmin` (LIVE never gets the demo admin).
- Submission. DEMO: PENDING at once, `wa.templateReview` 30 s later approves, or rejects a name containing `reject` with a reason; audits `simulated:true`; the UI says Simulated. LIVE: SUBMITTING and one `wa.templateSubmit` job; success stores the provider id and PENDING, then `wa.templateSync` 60 s later. A timeout, 5xx, 2xx without an id or "name exists" leaves SUBMITTING and the sync resolves it by name and language (never a blind retry); a definite refusal returns the row to DRAFT with the mapped reason (`TEMPLATE_SUBMIT_FAILURE_LABELS`).
- `template-sync.ts` (authored rows only): matches by name and language, stores status, `rejectedReason` and category; DRAFT is never touched, SUBMITTING is never counted missing.
- Routes, page `/dashboard/employee/[ws]/templates`, `src/components/templates/*` (status chips with icon and label, category-first form, variable insert buttons, buttons editor, Generate with AI through `AiActionButton` (local variant in DEMO, configuration gate in LIVE), `TemplatePreview` WhatsApp bubble on the `--chat-*` tokens, Save draft, Submit for approval, Delete). LIVE without WhatsApp shows a configuration gate.
- Bulk (`services/bulk/bulk.ts`): body positions mapped to a lead or business source are resolved per lead by `resolveLeadTemplateVariables`; typed values stay the `BulkRun` params (so the idempotent re-request compares equal); a handed-over lead is a FAILED `HANDED_OVER` row in an operator's run. `BulkTemplateVariables` now uses `TEMPLATE_VARIABLE_MAX_LENGTH` (the carried issue from the baseline).

**P1**
- `src/server/services/integrations/media-assets.ts` and `POST /api/app/media`: base64 JSON, route body cap 5 MB as base64 plus envelope (413), decoded at most 5 MB (413), `application/pdf` and a `.pdf` name, `%PDF-` magic bytes (422), stored at `STORAGE_DIR/media/<workspaceId>/<assetId>.pdf` with size and sha256 checked on every read; audit `media.upload` has size and hash prefix only (never the file name).
- DOCUMENT header with `headerMediaId` in the draft, the editor (pick from the library or upload), the preview and `templateComponentsOf`.
- Submission with a document header: DEMO uploads to the simulated admin (handle in `example.header_handle`); LIVE does the resumable upload on the WHATSAPP_CLOUD config `appId`, then creates the template with the handle. No `appId` is 422 `INTEGRATION_NOT_CONFIGURED` before anything changes; a failed upload creates nothing at Meta and returns the row to DRAFT (`MEDIA_UPLOAD_FAILED`); a missing or altered file is `MEDIA_MISSING`.
- Send time: `SendPlan.headerDocument` (`services/messaging/dispatch.ts`) and `sendPlan()` in `jobs/handlers/dispatch-run.ts` upload the brochure per send like the quote PDF (a template with `headerMediaId` sends its brochure; without one a DOCUMENT header is still the quote PDF). A changed file on disk fails the send as ARTIFACT_INTEGRITY.
- `templateShape(components, parameterFormat, { headerMediaId })` reports `documentSource` (`'media' | 'quote' | null`).

## Shared-file insertions (all inside the F4 anchor blocks)
- `src/server/routes.manifest.ts`: pages and routes below.
- `src/server/jobs/registry.ts`: `templateSubmitJob`, `templateReviewJob` (+ imports).
- `src/components/metrics/activity-vocabulary.ts`: labels below.
- `src/server/adapters/registry.ts`: imports, `TemplateAdmin`, `whatsAppTemplateAdmin`, `liveTemplateAdmin`.
- `tests/support/routes.ts`: fixture `templates.unknownTemplateId`.
- `tests/unit/arch/registry-live.test.ts`: import, `DEMO_MODULES` (`template-admin-demo.ts`), `LIVE_MODULES` (`template-admin.ts`), `LIVE_FUNCTIONS` (`liveTemplateAdmin`), runtime describe block.
- `src/components/integrations/sections.ts`: `{ segment: 'templates', label: 'Templates', icon: MessageSquareText }`.
- `src/server/adapters/ai/local-deterministic.ts`: `template_copy: generateLocalTemplateCopy` (one line).

Edits outside anchors, all inside paths the plan gives to F4: `src/lib/domain/whatsapp-templates.ts` (`templateShape` third parameter, `documentSource`), `src/lib/schemas/bulk.ts` (the 200 limit constant), `src/server/services/bulk/bulk.ts`, `src/server/services/messaging/dispatch.ts` (the `SendPlan.headerDocument` field and its preflight lookup), `src/server/jobs/handlers/dispatch-run.ts` (only the first lines of `sendPlan()`; F3's settle-hook line is untouched, so a textual conflict is unlikely), `src/server/services/integrations/template-sync.ts`.

Small edits outside F4's paths, made in the review pass because each closes a gap in F4's own feature (merge risk is a line each): `src/server/adapters/whatsapp/cloud-api.ts` (`listTemplates` asks for `rejected_reason`; the field list is the only change), `src/server/services/approvals/queue.ts` (the quotation's template list leaves out templates with a brochure), `docs/integrations.md` (rows for F4's Graph calls and the new list field), `tests/integration/contract/templates-sync.test.ts` (one assertion: the field list).

## Job types, keys, rate limits, activity labels
- `wa.templateSubmit` (`LEAD_GEN_JOB_TYPES.templateSubmit`): key `wa.templateSubmit:<templateId>:<submittedAt ms>`. `wa.templateReview`: key `wa.templateReview:<templateId>:<submittedAt ms>`, 30 s after submit, DEMO only. `wa.templateSync` (existing type): key `wa.templateSync:<integrationId>:submit:<templateId>:<submittedAt ms>`, at least 60 s after a LIVE submission. The `:<submittedAt ms>` suffix is the one difference from the ADR's literal key (ADR-131: the key is unique for ever).
- Rate limit `templateSubmit` (20 an hour per workspace) on the submit route; 429 with Retry-After.
- Audit actions and labels: `template.draft.create`, `template.draft.update`, `template.draft.delete`, `template.delete`, `template.submit` (QUEUED, FAILED, DENIED, simulated), `template.review` (simulated), `media.upload`.

## Routes (manifest owner T43; roles USER and EMPLOYEE, `templates.manage`, `workspaceSlug` in the body)
- page `/dashboard/employee/[ws]/templates`
- `POST /api/app/templates` (create draft), `POST /api/app/templates/generate`, `POST /api/app/templates/[templateId]` (update draft), `POST /api/app/templates/[templateId]/submit`, `POST /api/app/templates/[templateId]/delete`, `POST /api/app/media`.
- Matrix probes use the well-formed unknown id fixture `templates.unknownTemplateId` and workspace B's slug.

## Fixtures and tests
- `tests/fixtures/whatsapp/template-admin/*` (`SOURCES.json` marks every Graph shape `verified:false`, read from documentation snippets only; they need one live check, `docs/integrations.md`).
- Tests: `tests/unit/templates/*`, `tests/unit/ai/template-copy.test.ts`, `tests/integration/templates/*` (DEMO, LIVE with a scripted Graph transport, document header DEMO and LIVE, routes), `tests/integration/contract/template-admin.test.ts`, `tests/integration/bulk/bulk-template-variables.test.ts`, `tests/components/templates/*`, `tests/unit/arch/registry-live.test.ts`.

## Open questions for the integrator
1. **Quote PDF with a brochure template.** A template with its own brochure cannot carry a quotation (one document header, one document): `approveAndSendQuote` refuses it with 422 `TEMPLATE_HAS_OWN_DOCUMENT`, and the approval queue (`channelOption`) no longer offers it for a quotation (ADR-131). Any other composer that offers templates for a QUOTE_READY send should do the same (F3). The integration centre (`center.ts`) still reports every DOCUMENT header as `documentHeader: true` (nothing renders it today); changing that is outside F4's paths.
2. **Composer per-lead variables (F3).** F3 calls `resolveLeadTemplateVariables` itself; the bulk path is the reference (`variableResolver` in `bulk.ts`).
3. **F6 seed.** Rows seeded for the presentation workspace that are templates written here need `origin: 'AUTHORED'`; `copyGeneratorLabel` is `local-deterministic` for DEMO copy. The rate-limit table in `content/docs` still lacks `templateSubmit` (already listed under F6 in the baseline note).
4. **Backups.** `STORAGE_DIR/media/**` is not part of `db:backup` (same as the quote PDFs); a restored database whose media files are gone reports `MEDIA_MISSING` at submit and at send, never a silent skip.
5. **Graph shapes** for create, delete and the resumable upload are from documentation snippets and unverified until one live check with a real WABA and app ID. The same check settles the `rejected_reason` field of the template list (documented as a non-default field; it is asked for by name) and the `anyOf: [string, null]` form of the `template_copy` output schema.
6. **Wording elsewhere (F6).** `integrations/[kind]/page.tsx` ("Authored and approved in WhatsApp Manager"), `TemplateSyncButton.tsx`, `integrations/vocabulary.ts` and the `BulkSendPanel` / approval gate texts still say templates only come from WhatsApp Manager; they should point to the studio too (`/dashboard/employee/[ws]/templates`). Not F4's files.
7. **Bulk panel values are positional.** `BulkSendPanel` (not an F4 file) maps its value lines to `{{1}}`, `{{2}}`, ... by line, so for a template whose first position is filled from the lead the operator still has to type a stand-in first line before the value for `{{2}}`; the service ignores a typed value for a mapped position. The panel should list only the manual positions (`bulk-options.ts` would need to return each template's sources).
8. **No cap on the media library.** An operator with `templates.manage` can upload any number of 5 MB PDFs and there is no delete route yet; a per-workspace cap goes with the delete route.

## Review pass (fixes made after the first handoff)
- LIVE sync never saw Meta's reason: `rejected_reason` is not a default field of the template list, so the request now names it (`listTemplates`); authored rows and rows the sync creates keep the reason and provider id.
- A quotation through a template with its own brochure used to send the brochure and mark the quote sent without delivering it: now 422 `TEMPLATE_HAS_OWN_DOCUMENT`, and the approval queue does not offer such templates.
- Deleting a rejected template in LIVE deleted it at Meta before finding that sends were recorded against it: the check now comes first.
- `template_copy` output schema writes optional texts as `anyOf: [string, null]` and has a test for the strict subset; a LIVE test runs `generateTemplateCopy` against the real Anthropic adapter on a mock transport (request data, repair call, no price in the catalog, no local fallback).

## Deferred (not in P0 or P1)
IMAGE and VIDEO headers; header variables filled at send; URL buttons with a variable; editing an APPROVED template at Meta; deleting a brochure from the library (no route yet, the file and row stay); the free-form document reply for a brochure inside the 24-hour window (ADR-97 path, F3's reply flow).

## Slice gate (run on this branch, after the review pass)
- `npm run typecheck`: exit 0.
- `npx eslint` on every TypeScript file changed since `0ece53b` plus the new test file (54 files): exit 0, no findings.
- `npx vitest run --maxWorkers=2 tests/unit/arch tests/unit/lib/domain-enums.test.ts tests/unit/integrations tests/unit/docs tests/integration/authz/tenant-matrix.test.ts tests/unit/templates tests/unit/ai tests/integration/templates tests/integration/contract/template-admin.test.ts tests/integration/bulk tests/components/templates`: 35 files, 853 tests, all passed (the known `tests/unit/arch/lint-rules.test.ts` timeout did not occur in this run).
- Regression over the shared code F4 touches (`tests/integration/dispatch messaging integrations contract security approvals ai leads`, `tests/unit/lib`): 64 files, 651 tests, all passed.

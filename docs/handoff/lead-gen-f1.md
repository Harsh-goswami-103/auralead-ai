# Lead-gen F1: Lead Finder (handoff)

Branch `lg/f1` (worktree `C:\Users\Asus\auralead-wt\f1`), built from the merged foundation
(`0ece53b`). Spec: plan §5 F1, ADR-118, ADR-119; implementation choices in **ADR-128**
(`docs/decisions.md`). P0 and P1 are both done.

## What was built

**Adapter (`src/server/adapters/places/`)**
- `port.ts`: the places port (`searchText`, `getPlace`), the ADR-118 field mask once
  (`PLACES_SEARCH_FIELD_MASK` = the twelve `places.*` fields + `nextPageToken`;
  `PLACES_DETAILS_FIELD_MASK` unprefixed), `placesTextQuery` (`<keyword> in <location>`),
  `placesMapsLink(placeId, query)` (Maps URLs with `query_place_id`), failure kinds.
- `google-places.ts` (LIVE): Text Search `POST https://places.googleapis.com/v1/places:searchText`
  with `{textQuery, pageSize: 20, pageToken?, languageCode: "en", regionCode: "IN"}`, headers
  `X-Goog-Api-Key` and `X-Goog-FieldMask`; Place Details `GET /v1/places/<id>`; `checkConnection`
  (IDs only). Through `outboundRequest`; key scrubbed from every text; errors classified (400
  `API_KEY_INVALID` auth, 400 invalid-argument, 403 permission, 404, 429 with Retry-After, 5xx,
  thrown). City/state/PIN from `addressComponents` (locality, administrative_area_level_1,
  postal_code). `PLACES_CHECKED_ON = '2026-10-23'`.
- `demo.ts`: the simulated directory behind the port (page tokens `demo-page-<n>`).
- `src/lib/demo/places.ts`: pure `demoPlace(seed, {keyword, location})`, `demoPlacesPage`,
  `demoPlacesTotal` (24 to 60 per query), `demoPlaceById` (Refresh), `demoWebsiteEmails`
  (`@demo-leads.in`). Category from the keyword, city from the location (Indore and Bhopal
  localities and PIN codes, known cities with state and PIN prefix, generic otherwise), demo-style
  mobiles (1 in 8 none), about half without a website, ratings and review counts (1 in 10 unrated).
  Place IDs `ChIJdemo-<query hash>-<index>`. Websites `https://<slug>.demo-leads.in`.
- Fixtures: `tests/fixtures/places/documented-shape/` (10 files + `SOURCES.json`, every file
  `verified: false`, `checked: 2026-10-23`, fictitious data).

**Services (`src/server/services/lead-finder/`)**: `schemas.ts` (pure zod + `FINDER_LIMITS`,
error labels, Google terms line), `provider.ts` (`resolveWorkspacePlaces`, `placesConfigured`),
`jobs.ts` (enqueue helpers), `runs.ts` (start, cancel, list, run view, DTOs, erased detection),
`search.ts` (the search job's settle), `purge.ts`, `import.ts`, `export.ts`, `refresh.ts`,
`email-extract.ts` (pure rules), `emails.ts` (crawl + settle), `places-expire.ts` (sweep and
"Confirm details"), `tester.ts` (connection test), `view.ts` (page model).

**Jobs** (`src/server/jobs/handlers/`): `lead-finder-search.ts`, `lead-finder-purge.ts`,
`lead-finder-emails.ts`, `leads-places-expire.ts`.

**Routes** (`src/app/api/app/finder/**`, `src/app/api/app/leads/[leadId]/confirm-contact/`):
- `POST /api/app/finder/runs` (start; `finder.run`), `GET /api/app/finder/runs` (list; `leads.read`)
- `GET /api/app/finder/runs/[runId]?noWebsite=1&hasPhone=1&notImported=1&page=` (`leads.read`)
- `POST /api/app/finder/runs/[runId]/import` (`leads.write`)
- `GET /api/app/finder/runs/[runId]/export` (`leads.export`, requester only, xlsx attachment, audited)
- `POST /api/app/finder/runs/[runId]/cancel` (`finder.run`)
- `POST /api/app/finder/runs/[runId]/refresh` (`finder.run`; Place Details, at most 10)
- `POST /api/app/leads/[leadId]/confirm-contact` (`leads.write`; operator "Confirm details")

**Page and components**: `/dashboard/employee/[ws]/finder` (`leads.read`): run form, polling runs
list with progress bars, results grid with filters, selection, Import selected, Download Excel,
Refresh details, Google Maps attribution (LIVE) or Simulated chip (DEMO), configuration gate to
`/dashboard/employee/<ws>/integrations/google-places` in LIVE without a key.
`src/components/finder/`: `FinderRunForm`, `FinderRunsList`, `FinderResults`,
`PlacesAttribution`, `ConfirmContactButton` (for the lead pages), `finder-vocabulary.ts`.

## Shared-file insertions (all inside the F1 blocks unless noted)

| File | Insertion |
|---|---|
| `src/server/adapters/registry.ts` | imports (places demo, google-places, port); resolvers `resolvePlacesProvider`, `placesCheckClient`, LIVE branch `livePlacesClient`; types `PlacesSeams`, `PlacesResolveInput` |
| `tests/unit/arch/registry-live.test.ts` | import; DEMO_MODULES `places/demo.ts`; LIVE_MODULES `places/google-places.ts`; LIVE_FUNCTIONS `livePlacesClient`; runtime cases (status x credential, DEMO) |
| `src/server/jobs/registry.ts` | imports and `JOB_DEFINITIONS`: the four F1 jobs |
| `src/server/routes.manifest.ts` | 8 entries, owner T40 (page + 7 API routes) |
| `tests/support/routes.ts` | fixture keys `finder.unknownRunId`, `finder.unknownResultId`, `finder.unknownLeadId` |
| `src/components/metrics/activity-vocabulary.ts` | 10 labels (below) |
| `src/components/integrations/sections.ts` | icon import `ScanSearch`; section `{ segment: 'finder', label: 'Lead finder' }` |
| `src/server/services/integrations/live-testers.ts` (**outside anchors**, F1's "live tester entry") | `places?: PlacesSeams` in `LiveAdapterDeps`; `GOOGLE_PLACES: placesTester(...)` in `liveConnectionTesters` (not in `HEALTH_CHECKED_KINDS`: a test is a paid call) |
| `docs/decisions.md` | ADR-128 appended |

## Job types, limits, audit actions

- Jobs: `leadFinder.search` (fetch, priority 10, `serialKey run:<runId>`, key
  `leadFinder.search:<runId>:<cell>:<page>`), `leadFinder.emails` (fetch, same serial key, at most 3
  results), `leadFinder.purge` (default, end of the expiry's hour bucket, key
  `leadFinder.purge:<runId>:<hourBucket>`), `leads.placesExpire` (default, end of the day bucket,
  key `leads.placesExpire:<workspaceId>:<dayBucket>`).
- Rate limit: `finderRun` (per workspace, `workspace:<id>`), taken only for a new request key.
  Active runs per workspace: 2 (409 `FINDER_RUN_LIMIT`).
- Audit actions (labels added): `finder.run.start`, `finder.run.finish`, `finder.run.cancel`,
  `finder.import`, `finder.export`, `finder.results.purge`, `finder.results.refresh`,
  `finder.emails.extract`, `lead.places_expire`, `lead.contact_confirm`. Summaries carry counts and
  codes only (no terms, names, phones or addresses).
- Run error codes: `PLACES_NOT_CONFIGURED`, `PLACES_CREDENTIAL_UNREADABLE`, `PLACES_AUTH`,
  `PLACES_PERMISSION`, `PLACES_RATE_LIMITED`, `PLACES_UNAVAILABLE`, `PLACES_UNREACHABLE`,
  `PLACES_INVALID_ARGUMENT`, `PLACES_REJECTED`, `MODE_MISMATCH`.

## For the integrator (requests; not edited here, outside F1's paths)

1. `tests/components/integrations/source-actions.test.tsx:99` lists the workspace sections
   verbatim; it now ends with "Lead finder" (where F1's entry sits in its anchor block). Update it
   with the merged list when moving Lead finder to the front of `WORKSPACE_SECTIONS` (the story
   order), and expect the other slices to touch the same line.
2. Done in the F1 review (one line, outside F1's paths): `src/server/services/admin/lead-erase.ts`
   `FINDER_RESULT_BLANK` now also clears `contentPurgedAt`, so a place erased after its 24-hour
   purge is recognised as erased and never refreshed (ADR-128). Keep it when merging.
3. Wire `ConfirmContactButton` into both lead pages (it needs `placesContentExpiresAt`,
   `contactConfirmedAt`, `contactConfirmedVia` in the lead read models), and show
   `PlacesAttribution` (LIVE) next to lead fields that came from Places (ADR-118 (b)).
4. F6 seed: grant `finder.run` to the codecraft operator (the base seed's `employee` persona does
   not hold it, so other workspaces show the permission gate); seed the finished run with
   `requestedBy` = the operator (only the requester gets Download Excel), `simulated: true`,
   `contentExpiresAt` relative to now, place IDs from `demoPlace`/`demoPlacesPage` (so DEMO Refresh
   works), and add to `REBASE_COLUMNS`: LeadFinderRun `createdAt/startedAt/finishedAt/cancelledAt`,
   LeadFinderResult `createdAt/importedAt/contentExpiresAt/contentPurgedAt`, Lead
   `placesContentExpiresAt/contactConfirmedAt`.
5. Docs (F6): `docs/integrations.md` Places API (New) shapes are UNVERIFIED (documented-shape
   fixtures, checked 2026-10-23); the rate-limit table needs `finderRun`; the data-and-privacy
   retention table needs finder results (24 h content, place ID kept) and Places fields on leads
   (30 days unless confirmed).
6. Activity icons: `finder.*` has no family in `FAMILIES`, so it falls back to the History icon.

## Added in the F1 review

- robots.txt answers follow RFC 9309: 4xx or a non-text file means no rules, 5xx or 429 means
  "unreachable" (site BLOCKED, nothing else requested), no answer means FAILED.
- Refresh replaces the whole copy (attributions Google no longer sends are cleared).
- A repeated start request key with another search is a 409, not the first run handed back.
- `FinderRunDto.emailsPending` (websites still waiting for their email check): the runs list keeps
  polling a finished run until it is 0, because the last pages' email jobs finish after the search.
- Filter links use `aria-current` instead of `aria-pressed` (not allowed on links).

## Open questions

- The email crawler's User-Agent is `AuraLeadBot/1.0 (+<app origin>/docs/bot)`, the convention the website
  enrichment already uses, but no `/docs/bot` page exists yet (F6 docs could add one that says what the bot
  reads and how to opt out through robots.txt).
- Lead CSV/XLSX exports (F2) still write every lead column; for an unconfirmed Places lead the
  review suggested exporting the place ID and link instead of the Places-sourced fields within the
  30 days. Not F1's file.
- `contactConfirmedVia WEBSITE_EMAIL` is never set by F1 (an email from the business's site does
  not confirm the Places phone or address); F3/F5 set INBOUND_WHATSAPP and RECORDED_OPT_IN.
- The DEMO 24-hour lifecycle also applies to seeded presentation rows; `npm run demo:refresh`
  must rebase `contentExpiresAt` (item 4).

## Deferred

Nothing from the F1 P0/P1 list. Not built: a runs-history page beyond the latest 10 runs,
pagination of more than 200 selected results in one import (the grid selects per page of 50).

## Gate (last run on this branch, after the F1 review)

`npm run typecheck` exit 0; `npx eslint` on the F1 paths, the shared files and `lead-erase.ts` clean;
`npx vitest run --maxWorkers=2 tests/unit/arch tests/unit/lib/domain-enums.test.ts tests/unit/integrations tests/unit/docs tests/integration/authz/tenant-matrix.test.ts tests/unit/finder tests/integration/finder tests/components/finder`
plus `tests/components/integrations`, `tests/integration/integrations`, `tests/integration/ops/lead-erase.test.ts`,
`tests/unit/lib/lead-gen.test.ts`, `tests/integration/messaging`, `tests/unit/messaging`, `tests/integration/jobs`,
`tests/unit/jobs`: 69 files, 1176 tests passed.

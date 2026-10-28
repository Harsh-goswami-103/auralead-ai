# Progress

Plan: [`implementation-plan.md`](implementation-plan.md) (milestones §11, checklist §15). Decisions: [`decisions.md`](decisions.md). Implementer handoff notes: [`handoff/`](handoff/).

## Status

| Milestone | Tasks | State | Date |
|---|---|---|---|
| M1 Foundation | T01-T09 | Done, exit gate green | 2026-10-16 |
| M2 Core lead-to-quote slice | T10-T17 | Done, exit gate green | 2026-10-16 |
| M3 Messaging | T18-T24 | Done, code gate green | 2026-10-16 |
| M4 Panels and visual | T25-T31 | In progress: UI v2 redesign and T30 landing landed early (ADR-66) | 2026-10-20 |
| M5 Integrations | T32-T36 | Not started | |
| M6 Hardening, docs, verify | T37-T39 | Not started | |
| Lead-gen suite (owner request, ADR-117 to ADR-135) | B1-B3, F1-F6 | Merged and documented; full-suite run, browser walk and live provider checks pending | 2026-10-23 |

## M1 Foundation (T01-T09)

What exists:
- Toolchain at exact pins (plan §2): Next 16.4.1, React 19.3.1, TS 5.9.3, Prisma 7.10.0 + better-sqlite3 adapter, Tailwind 4.3.3, Vitest 5, Playwright 1.64, ESLint 10.12.0 with eslint-config-next 16.4.1 (the ESLint 9 fallback was not needed).
- One env loader and validated config (`src/lib/env-load.ts`, `src/lib/config.ts`), data paths outside OneDrive (`src/lib/paths.ts`), `npm run setup` that generates the secrets (LIVE by default since ADR-116).
- Windows spike passed with no fallback (ADR-02a): prebuilt native modules, WAL/busy_timeout/foreign_keys on every connection, exactly-once job claim across two OS processes.
- Full Prisma schema and migrations (ADR-47), tenant-scoped DB layer, `withTx` with busy retry.
- Core lib: money (BigInt paise, half-up), clock, errors and HTTP mapping, redaction, domain enums.
- Security primitives: envelope encryption with key ring, CSRF, rate limits, HMAC helpers, contact keys (T05).
- Auth, sessions, request context, `withRoute`, audit, boot checks; DEMO needs the setup-generated secrets too (T06).
- Persistent job runtime and worker: claim, lease fencing, heartbeat, retry, DEAD, restart safety (ADR-48).
- Design tokens, shadcn primitives, app shell, role switcher (DEMO only), GatedAction, status badges (ADR-49).
- Deterministic seed, `db:reset` / `demo:refresh`, route manifest, generated tenant matrix, built-app E2E harness and smoke suite (ADR-50).

Exit gate, run 2026-10-16:
| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run test` | 61 files, 662 tests passed, 0 skipped |
| `npx playwright test --project=smoke` | 4/4 passed (health 200; switcher opens each panel with seeded data; role cannot open another panel; LIVE build has no switcher or persona route) |
| Stub/secret scan | no TODO/placeholder/empty handlers; no secrets or DB files in the repo |

Checklist §15: R3, R5, R35, R43, P19, E10 ticked; R1, R2, R6, R7, R38, R39, R41, AT4, AT5, O4, P20, E3, E5, E11, E12 ticked for their M1 part (`[~]`).

## M2 Vertical slice (T10-T17)

What exists:
- Ingestion core: `ingestBatch` with normalization (E.164, never invented emails), contact-key dedupe (race-safe across processes), MergeReview, per-record results, batch idempotency, consent capture from mappings (P1), Maps leads get no WhatsApp consent (ADR-51).
- Single pipeline orchestrator: `pipeline.advance` executor with a stage registry and `PipelineStageRun` idempotency; INGESTION, SCORE (enrich then score) and DRAFT stages registered; APPROVAL waits visibly until T23.
- Source simulators for Sheets, Meta and Maps (`/api/demo/simulate/[source]`), webhook persistence with scopeKey idempotency and encrypted processing payload plus purge job (ADR-54).
- Explainable heuristic scoring, website enrichment through `safeFetch` (SSRF-hardened) (ADR-53).
- Pricing catalog with versioning, tax and discount settings, server-side totals, User Pricing page (ADR-52).
- AI port with local deterministic generator and fixture-tested Anthropic/OpenAI adapters; strict schemas, price/discount/tax strip-and-flag, injection corpus, LIVE never falls back silently; `--ai` colour token lint rule added (ADR-55).
- Quote lifecycle: versions, item snapshots, 7x7 state machine, approval CAS, share links, expiry sweeper, Quotations pages (ADR-56).
- Real react-pdf quotation with embedded Inter (₹), public `/quote/[token]` with all states, view beacon, idempotent accept (ADR-57).
- Employee lead console: list, detail, generate draft, create quote, approve, PDF download; one correlation chain end to end (ADR-58).

Exit gate, run 2026-10-16:
| Check | Result |
|---|---|
| `npm run typecheck` / `npm run lint` | exit 0 / exit 0 |
| `npm run test` | 105 files, 1144 tests passed, 0 skipped |
| Playwright smoke | 4/4 |
| Playwright `tests/e2e/public`, `tests/e2e/slice` (w1440) | 4/4 |
| Independent slice exercise (temp data dir, `next start` + built worker over HTTP) | Maps lead simulated, pipeline settled in ~1 s (score 47, draft READY), quote Q-0001 v1 approved, PDF 23.7 KB starting `%PDF-` containing ₹10,030.00 = DB total, single GST line, DEMO watermark; no phone number in logs |
| Stub/secret scan | none found |

Checklist §15: R7, R11, R12, R13, R15, R16, R17, R19, R20, AT5, AT6, AT7, P8, P16, E1 fully ticked; M2 parts of R1, R14, R18, R22, R31, R32, AT2, AT3, O5, P1, P15, E2, E9, E11, R41 ticked `[~]`.

## M3 Inbox, approvals, dispatch, suppression (T18-T24)

What exists:
- Eligibility evaluator (all reasons in plan order, deferrable vs skip), 24 h window rule, consent grants and B2B attestations (D4), append-only Suppression history, SuppressionJournal producer and reconcile job (ADR-59).
- Dispatch outbox with approve-and-send, version binding, payload-hash staleness, claimToken fencing, superseded-settle CAS, failure classes, AUTO_SEND_DISABLED check, ESLint ban on adapter calls inside `withTx` (ADR-60).
- WhatsApp and email webhooks (DEMO simulation), synchronous Stop/unsubscribe that cancels queued sends in the same request, START re-opt-in, quick replies with stable payload ids, call requests, status rank-merge (ADR-62).
- Conversations, human takeover checked at dispatch, automated reply guard (ADR-63).
- Bulk actions with preflight; APPROVAL and DELIVERY pipeline stages; `npm run pipeline:resume` (ADR-61).
- Admin job/webhook inspector, ambiguity resolution, fresh re-authentication, global outbound pause, `db:backup` / `db:restore` with journal replay, `lead:erase` (ADR-64).
- Inbox, approval queue and quote hand-over UI including mark-sent-manually (P15) (ADR-65).

Exit gate, run 2026-10-16:
| Check | Result |
|---|---|
| `npm run typecheck` / `npm run lint` | exit 0 / exit 0 |
| `npm run test` | 158 files, 1753 tests passed, 0 skipped |
| Playwright smoke (fresh DEMO + LIVE builds) | 4/4 |
| Playwright public, slice, inbox, approvals, quotes (w1440) | 8/8 |
| Independent HTTP exercise (built app + worker, temp data dir, network spy + netstat) | Sheets lead with consent drafted; quote sent over WhatsApp as Simulated with zero app network connections; inbound opened the window; STOP blocked further sends (422 SUPPRESSED) and cancelled a queued send synchronously; Maps lead skipped NO_WHATSAPP_OPT_IN with 0 attempts; global pause held sends QUEUED until resume; no PII in logs |

The verifier fixed one bug: when outbound was paused, a send that was also ineligible was recorded with the pause as its reason; non-deferrable reasons now come first (`src/server/services/messaging/dispatch.ts`, regression in `tests/integration/jobs/pause-honored.test.ts`).

Checklist §15: 32 more rows fully ticked (R1, R6, R18, R21, R23-R25, R28, R29, R40, R45, AT9-AT12, O1-O3, O5, P3, P4, P11, P13, P15, P20, E3-E6, E8, E9, E11); M3 parts of R4, R22, R27, R31-R33, R42, AT8, AT13, P1, P2, E7 ticked `[~]`.

## UI v2 "Aurora" redesign (owner request, 2026-10-20; ADR-66)

What exists:
- Palette v2 and the visual foundation:
  - Tokens and Tailwind theme with per-panel signature hues (client aura, operator zest, admin flare).
  - Restyled shadcn primitives: gradient primary with visible focus, NativeSelect, Textarea, animated dialogs and sheets, toned toasts.
  - Motion presets.
  - `src/components/visual/**`: aurora backdrops, comet border, border beam, spotlight and tilt cards, reveal and stagger, animated beams, marquee with a pause button, meteors and sparkles; every effect has a reduced-motion resting frame and pauses offscreen.
  - Shared patterns: `PageHeader`, `SectionCard`, `StatTile`, `SourceChip`.
- Procedural 3D aura (R3F) in `src/components/visual/aura/**`: the landing hero, the /login and /invite backdrop, and the command-center tile at >= 1440 px. It renders an SSR poster first, loads through `next/dynamic` after idle, has a visual budget, and falls back to the poster on context loss.
- Landing `/` (T30, built early): hero, labelled pipeline diagram, feature bento, ROI calculator, principles strip. Not yet built: `visual-budget.spec.ts` and the panel previews.
- Branded not-found, root `error` and `global-error`, per-panel error boundaries, and the app icon.
- Every panel page redesigned on the shared patterns.
- UI bugs fixed, from the audit and from the adversarial review (32 findings, each confirmed by two verifiers):
  - 390 px overflow on the client home and pricing;
  - hidden focus;
  - raw codes shown to people;
  - AI labels on template text;
  - endless refresh loops;
  - the pause banner ignoring `outbound.lock`;
  - WCAG touch targets, label-in-name and focus return;
  - public quote alignment and no-JS issues.

Gate, run 2026-10-20 (Linux container):
| Check | Result |
|---|---|
| `npm run typecheck` / `npm run lint` | exit 0 / exit 0 |
| `npm run test` | 190 files, 2017 tests passed (270 new). 6 failures, the same as before the redesign and specific to this container: `with-tx-retry` x4 (SQLite busy timing), `spike/teardown` (Windows process tree), `seed/determinism` (the generated `.env` pins `NEXT_PUBLIC_APP_MODE`) |
| Page crawl (48 views: every reachable page at 1440 and 390, three personas) | 0 console errors, 0 page errors, 0 horizontal overflow (before: 2 overflowing pages and a favicon 404 on every page) |
| axe WCAG 2.0/2.1 A+AA (12 scans) | 0 violations |
| Playwright on production builds (DEMO + LIVE) | 16/16: smoke and w1440 (smoke, approvals, inbox takeover and window boundary, public quote states, manual share, lead-to-PDF slice); `visual/webgl-fallback.spec.ts` 6/6 across reduced-motion, no-webgl, w390, w768, w1440 and w1920 (poster only where the budget is off, WebGL mounted elsewhere) |
| three.js isolation (build output) | the three chunk is referenced only by the dynamic-import manifests of `/`, `/login`, `/invite/[token]` and `/dashboard/user` (tile); no route loads it initially, and the operator and admin panels never reference it |

## LIVE by default (owner request, 2026-10-22; ADR-116)

- A fresh `npm ci` + `npm run setup` is a LIVE install: `APP_MODE=live` in `.env.example`, LIVE when `APP_MODE` is unset, no seed and no demo wording on the landing page or `/docs`. DEMO is an explicit development opt-in (`APP_MODE=demo`), unchanged in behaviour.
- `prisma.config.ts` resolves only the data paths, so `prisma generate` in `npm ci` no longer needs the secrets.
- README quick start is the LIVE install; DEMO moved under "Development mode".

## Lead-gen suite: foundation baseline (2026-10-23)

Integration checkout `claude/lead-gen-suite`. Foundation-A (`7d703e9`, `61b4352`), then Foundation-B merged with `git merge --no-ff` in plan order, no conflicts:
- `c9f21b4` merge `lg/b1` (data: ingest fields, erase coverage, rebase columns, handoff guard)
- `e2a5d95` merge `lg/b2` (AI: `run-task`, local task dispatcher, `AiProvenance`, `AiActionButton`)
- `d7a1cb5` merge `lg/b3` (shared constants, per-lead template variables, chat tokens, rate limits, anchor blocks)
- `c24d1a6` integration: the dispatcher test reads the AI task names from `LEAD_GEN_AI_TASKS`; ADR-127 records the Foundation-B deviations the implementers left to the integrator.

Baseline at `d7a1cb5`, run alone on Windows 11 (Node 22.23.2) after `prisma generate`, nothing else running (`c24d1a6` then changed one test assertion and docs; typecheck, lint and that file, 11/11, pass):
| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run test` | 290 files, 3257 tests, all passed, 0 failed, 0 skipped (187 s) |

No failing files. Known flake: `tests/unit/arch/lint-rules.test.ts` can hit its 5 s timeout under heavy parallel load; it passed in this run. The container-only failures listed under the Aurora gate (`with-tx-retry`, `spike/teardown`, `seed/determinism`) do not occur on Windows.

Carried to the slices (details in `docs/handoff/lead-gen-b1.md`, `-b2.md`, `-b3.md`):
- **F1:** an erased place keeps its finder rows (place ID, keyword, location), so Refresh could fetch the listing again; there is no erased marker column (a schema request if needed). "Lead finder" goes first in `WORKSPACE_SECTIONS`; the integrator reorders it after the F1 merge.
- **F2:** `leadExportFileName` and the download content type still assume csv. The import job must recheck in every chunk that the import is RUNNING and `storagePath` is set, because `lead:erase` can end it mid-run.
- **F3:** take the read-only state from `Lead.handedOverAt` (an operator in a closed window gets 422 `SEND_REFUSED` before the guard's 409). `reply.auto` runs with a `system:` initiator, which the guard never refuses, so it must recheck `handedOverAt` itself (ADR-122).
- **F4:** B1 edited `services/bulk/bulk.ts` (`classifyRows` gained a last parameter `byEmployee`) and `messaging/dispatch.ts` (four guard calls). `BulkTemplateVariables` still hard-codes 200 instead of `TEMPLATE_VARIABLE_MAX_LENGTH`.
- **F5:** `handOverLead` must call the takeover and mode functions before it sets `handedOverAt` (the guard refuses the operator afterwards), or update conversations directly under the `modeVersion` compare-and-set.
- **F6:** `REBASE_COLUMNS` lists only `escalatedAt` for Conversation; seeded open-window chats need Conversation `createdAt`, `lastInboundProviderAt` and Message `createdAt`, `providerTs`. The rate-limit table in `content/docs` lacks `finderRun`, `leadImport`, `templateSubmit` and `handoff`.
- **AI tasks (F3, F4, F5):** `LOCAL_TASKS` anchors are single lines (one entry under each), not begin/end blocks; use the names in `LEAD_GEN_AI_TASKS`. Activity icons (`FAMILIES`) have no anchor, so a new action prefix falls back to the History icon. `defaultAiDeps()` duplicates `defaultDraftDeps()` (kept for existing importers).

## Lead-gen suite: slices merged (2026-10-23)

The six slice branches were merged into `claude/lead-gen-suite` with `git merge --no-ff` in plan order. After each merge: `prisma generate`, `npm run typecheck`, `eslint` on the files the merge changed, and vitest on `tests/unit/arch`, `tests/unit/lib`, `tests/unit/docs`, `tests/integration/authz`, `tests/integration/db` plus every test file the slices had added or changed so far.
| Merge | Commit | Conflicts and how they were resolved |
|---|---|---|
| F5 handoff and reach-out | `6f79953` | none |
| F2 import and export | `5466e7f` | `docs/decisions.md` only (both slices appended an ADR): kept both, ADRs in number order |
| F1 Lead Finder | `7d32ac0` | `docs/decisions.md` only: same |
| F4 template studio | `b95f901` | `docs/decisions.md` (same) and `adapters/ai/local-deterministic.ts` (the two slices' import lines at the same spot: kept both; the `LOCAL_TASKS` lines sat in their own anchors). The merge left the section-nav test without "Templates": `c4980e3` |
| F3 chat and AI replies | `712ea5d` | `docs/decisions.md` (same) and `tests/components/integrations/source-actions.test.tsx` (F3 compares the nav with `WORKSPACE_SECTIONS`, F1 and F4 had edited the literal list: kept F3's form and listed every section) |
| F6 presentation seed and copy | `cbc009d` | `docs/decisions.md` only: same |

Every other shared file (`routes.manifest.ts`, `jobs/registry.ts`, `activity-vocabulary.ts`, `adapters/registry.ts`, `tests/support/routes.ts`, `registry-live.test.ts`, `sections.ts`, `LOCAL_TASKS`, `approvals/queue.ts`, `dispatch-run.ts`, `bulk.ts`, `leads.ts`, `consent.ts`) merged without a conflict through the anchor blocks.

Integration work after the merges (ADR-134):
- **Fix, flaky test (`59e7c30`):** `tests/integration/finder/run-flow.test.ts` ("reports how many websites are still being checked") listed the 10 newest runs, but every run of the file is created at the same fixed instant, so which runs were in the list depended on a random id order (failed about 1 run in 6). The test now creates its runs a minute later.
- **Section order:** Lead finder, Leads, Inbox, Templates, Approvals, Integrations, Pipeline, Sheets, Meta, Extension (`SECTION_ORDER`); the nav now shows on the Leads, Import and Approvals pages as well.
- **Lead pages:** F5's hand-over action and reach-out panel (already wired by F5), F1's Places attribution and "Confirm details" (`LeadPlacesNotice`, `LeadProfileDto.places`) on the operator lead page, the client lead page and the Leads sheet, F5's handoff card on the client lead page and in the sheet, F2's "Import leads" link in the employee Leads header.
- **Seed alignment:** the seeded summary was plain text (the client panel reads JSON `{asked, promised, nextStep}`); the seeded AI answers, opt-in evidence and handoff audits now equal what the services write, and a test recomputes them (`presentation-alignment.test.ts`). F4's trigger `MEETING_BOOKED` already matched the seed. The operator persona already held every capability except `consent.import`, and `REBASE_COLUMNS` already listed the finder and Places lead dates.
- **Seeded finder results survive the presentation:** their `contentExpiresAt` is the fetch time + 365 days (real runs keep 24 hours) and no purge job is queued for the seeded run. `demo:refresh` moves the date with the rest; the seeded Places leads keep the 30-day rule. A database seeded before this merge still needs `npm run db:reset` (`db:seed` leaves a seeded database alone, and the pack is new).
- **Shared fixes from the slice notes:** the export filter `handedOver` (same-export reuse, audit, panel), `HANDED_OVER` run reason, "Needs you" icon for `handedOverLeads`, activity feed link for Lead targets, activity labels for `consent.capture` and `suppression.clear_refused`, the docs rate-limit table (`finderRun`, `leadImport`, `templateSubmit`, `handoff`), the public `/docs/bot` page the crawler's User-Agent points to.
- **New cross-slice tests:** `tests/integration/seed/presentation-alignment.test.ts`, the wiring block of `presentation-pages.test.ts`, `tests/integration/leads/export-handed-over.test.ts`, `tests/unit/jobs/lead-gen-registry.test.ts` (every lead-gen job type registered once: the worker-boot check without a process).

- **Cross-slice tests (ADR-135):** `tests/integration/lead-gen/` holds six files that compose the slices with the real services, the production handlers and the real DB harness: `handed-over-paths` (an operator is refused on the composer, drafts, approval and quotation sends, bulk rows and the mode, takeover and resume routes after a real `handOverLead`, the client owner is not, and `reply.auto` sends nothing), `consent-invariants` (Places and unattested imports are skipped NO_WHATSAPP_OPT_IN; an attested import records OPT_IN and never clears a STOP), `erase-cross-slice` (`lead:erase` of a lead with a finder result, handoff, summary, chat and xlsx export), `worker-boot` (every lead-gen job type registered once, and claimed by a real `worker/index.ts` process), `demo-story` (find, import three, opt in one, template, bulk send, inbound, AUTO reply, hand over, acknowledge, with zero outbound) and `live-gates` (no Places, WhatsApp or AI integration means configuration errors, never simulated data). They exposed two defects, both fixed: a thread opened after a handoff started with the AI able to answer (`newConversationMode`), and the five DEMO tripwires armed in `beforeAll` were restored by `restoreMocks` before the first test, so they could never fail (`tests/support/tripwire.ts`, armed per test and asserted).

Left for the next stages: the full suite run alone; the walk of the DEMO story in a browser on a fresh data dir (the landing flow, the finder, the chat, both lead pages and the client panel have never been looked at in a browser); a fresh LIVE install; the presenter section of `docs/runbooks.md`; unverified provider shapes (Places, Graph template calls) stay `verified: false` until one live check. The in-app documentation, the README and `docs/integrations.md` were written afterwards (next section).

## Lead-gen suite: documentation, what shipped, deferred and known limits (2026-10-23)

Documentation step (docs-only commit after the integration commits):
- **In-app docs (`content/docs`).** Five new pages in sidebar order after Roles and panels: `/docs/lead-finder`, `/docs/import-and-export`, `/docs/inbox-and-ai-replies`, `/docs/template-studio`, `/docs/reach-out-and-handoff`. Updated: roles-and-panels (the five capabilities, the member column, the new pages of both panels), messaging-rules (`FILE_IMPORT`, the opt-in rules, Places and import leads, `HANDED_OVER`, Automatic sending), lead-to-quote-workflow (sources, `NOT_LISTED` scoring, handoff stage), data-and-privacy (storage folder, retention rows for finder results 24 h, Places fields on leads 30 days, import rows, lead exports, handoff notes, brochures; erasure; exports), security (uploads and crawling), going-live (setup of the Places, WhatsApp and AI integrations), troubleshooting, limitations, and getting-started (four personas, six businesses, the Codecraft walkthrough). LIVE views carry no demo wording: every DEMO statement sits in a block with `appliesTo: ['DEMO']`.
- **Honesty tests.** `tests/unit/docs/content.test.ts` gained a "lead-gen docs facts match the code" block: the limits, retention periods, caps, the attestation, the disclosure line, the capability table with its member column and the DEMO guide's personas and businesses are compared with the constants in the code, so a change there fails the test.
- **README** (features, the presentation seed and personas, the presenter steps, the page list; quick start unchanged) and **`docs/integrations.md`** (Google Places API (New): checked 2026-10-23, verification level fixture-tested, not live-verified, billing tier and Google's terms recorded as not checked; template authoring endpoints with their level; the lead-gen AI tasks).

What shipped (merged on `claude/lead-gen-suite`; ADR-117 to ADR-135):
| Area | State |
|---|---|
| Spreadsheet module (`src/lib/spreadsheet`, ADR-117) | XLSX writer and reader on `fflate` 0.8.3, RFC 4180 CSV, size, zip-bomb, row and column limits |
| Lead Finder (F1, ADR-118, ADR-119, ADR-128) | Google Places API (New) adapter with a simulated directory in DEMO; 10 keywords by 10 locations; 24-hour working copy and purge; attribution; Places fields on leads for 30 days unless confirmed ("Confirm details"); email search with robots.txt; limited Excel; `NOT_LISTED` |
| File import and export (F2, ADR-120, ADR-129) | Upload, preview, mapping, chunked job, row reasons, sample workbook, the attested consent column that never clears a Stop, lead export as CSV or Excel |
| Inbox and AI replies (F3, ADR-121, ADR-122, ADR-130) | Operator inbox in the chat look, Automatic sending, `conversation_reply` for service questions only, disclosure, 24-hour window, reply cap of 4, `escalatedAt` in Needs you, simulated ticks in DEMO |
| Template studio (F4, ADR-123, ADR-131) | Category-first form, AI copy, STOP button, UTILITY trigger, PDF brochure headers, LIVE submit job and sync, DEMO review after 30 s, per-lead variables in bulk and the composer |
| Handoff and reach-out (F5, ADR-124, ADR-125, ADR-127, ADR-132) | `handOverLead` in one transaction, summary job, client surfaces with Acknowledge, the `assertNotHandedOver` guard, recorded opt-in with notice and method, click-to-chat link |
| Presentation (F6, ADR-126, ADR-133, ADR-134) | Codecraft Web Studio seed, the `client` persona, landing story flow, 365-day seeded finder content |
| Foundation | One migration, five capabilities (20 in all), four rate limits, shared constants and anchor blocks |
| Tests | Slice tests, cross-slice tests (`tests/integration/lead-gen/`, ADR-135), the armed DEMO outbound tripwire |

Deferred (built for later, not in this delivery):
- **Browser and acceptance work:** the full suite run alone, a browser walk of the DEMO story on a fresh data dir, a fresh LIVE install, `npm run test:e2e` for the new pages, a look at the landing flow at 125% zoom, and the presenter section of `docs/runbooks.md`.
- **Live verification:** every Places and template-authoring request shape, the `rejected_reason` field and the `anyOf` output schema of `template_copy` (`docs/integrations.md`). Google's Maps Platform terms and the Places pricing tier of the field mask were not re-read.
- **F1:** a runs-history page beyond the latest 10 runs; importing more than 200 selected results in one request (the grid selects per page of 50).
- **Contact confirmation (ADR-118 (d), closed by ADR-136).** An inbound WhatsApp message from a Places lead's number (not a Stop) now sets `contactConfirmedAt` and `INBOUND_WHATSAPP` (`messaging/inbound.ts`), and the 30-day sweep also leaves alone a lead that was handed over, has a quote or has a conversation the customer wrote in. `WEBSITE_EMAIL` is still never set.
- **F2:** a Client-panel import page (the routes accept an owner; the page is Operator-only, so the consent column is reachable only by an operator whose assignment includes `consent.import`); month-name opt-in dates; Hindi header synonyms; a chunk job that dies without reporting leaves the import on Queued or Importing until the 24-hour cleanup.
- **F3:** an "Open chat" link from the operator lead page to its thread; `approveAndSendMessage` does not clear the `escalatedAt` column (the inbox read model treats the approved send as settling it).
- **F4:** IMAGE and VIDEO headers, header variables filled at send, link buttons with a variable, editing an approved template, deleting a brochure (and a cap on the library), the free-form document reply for a brochure inside the window, and a bulk panel that lists only the typed positions.
- **F5/F6:** hiding the "Simulate a lead source" cards for Codecraft Web Studio; rendering the DEMO click-to-chat link as text only.

Known limits (also in `/docs/limitations`):
- **Hand-over guard.** It stops sends and conversation controls for operators, not stage moves or lead edits. A `pipeline.advance` job whose stage handler is already running at the moment of a handoff can still queue one `system:pipeline` send; a stage the handoff has already stopped is no longer revived by a job that started later (ADR-136), and the later stages do not run.
- **Places content.** A lead export writes the lead's stored columns, so a Places lead's phone, address and rating are in it until they expire after 30 days. This reduces risk and is not a licence.
- **Wording.** The stale 'templates come only from WhatsApp Manager' strings were reworded (ADR-136) and `tests/unit/presentation/wording.test.ts` forbids them. The integration center still reports every DOCUMENT header as `documentHeader: true` (nothing renders it today).
- **DEMO.** `npm run db:seed` leaves a seeded database alone, so a database seeded before the pack needs `npm run db:reset` once; `npm run demo:refresh` also moves the rows a rehearsal created. The Places leads of the seeded workspace keep the 30-day rule.
- **Backups.** `db:backup` does not include the storage folder: brochures (`media/`), lead exports and quotation PDFs are copied by hand; a restored database without its brochure files reports `MEDIA_MISSING` at submit and at send.

## Unresolved / carried forward

- `npm run test:e2e`: specs exist for smoke, the panel flows and `visual/webgl-fallback`; the rest of the visual projects (responsive, a11y, states) get specs in T31. In this Linux container Playwright 1.64's own browser build is not installed; the run above used the preinstalled Chromium through a throwaway config with `launchOptions.executablePath`.
- `RoleSwitcher` has no Landing or Docs entries; `/` now exists (ADR-66), `/docs` arrives in T37.
- `npm audit`: 9 high advisories, all in transitive dev tooling (eslint plugin `braces`, prisma's `deepmerge-ts`/`mysql2`); the only offered fix is a downgrade. Re-check at T38.
- npm warns about peer ranges for nested ESLint plugins declaring `eslint ^9`; lint works and every lint fixture passes.
- Preview-feature caveat (ADR-47): never call `findUnique`/`upsert` on the partial-unique keys of PricingVersion or Suppression; use `findFirst` with the predicate.
- Load-sensitive timeouts (fixed in the lead-gen final gate): the unit project now has the same 60 s test and hook budget as integration, because `tests/unit/arch/lint-rules.test.ts` and `live-bundle.test.ts` hit the old 5 s default when the full suite ran on a loaded host. `tests/integration/jobs/heartbeat.test.ts` now starts observing the heartbeat row and the extended lease before it spawns worker B; both facts exist only while the 6 s job runs. All three passed alone and failed only under CPU oversubscription.

- DEMO has no WhatsApp integration or approved template yet, so quote-over-WhatsApp cannot be shown through the UI; ADR-17 says DEMO seeds approved and rejected templates. Assigned to M4 (T28 integration center).
- Approve-and-send (`/api/app/approvals/[id]/send`) accepts an ineligible lead and leaves the skip to dispatch preflight, while the composer refuses upfront with 422. Safe, but inconsistent; fixed in the M4 follow-up.
- The E2E harness's `prisma migrate deploy` contacts `checkpoint.prisma.io`; set `CHECKPOINT_DISABLE=1` in the harness env (M4 follow-up).
- STOP does not set `withdrawnAt` on ConsentRecords; the active Suppression row is what blocks sends (by design, ADR-37).

## Next step

M4: T25-T30 in parallel (metrics, leads UI, branding, employee panel, admin panel, landing), then T31 responsive, accessibility and hostile-input pass.

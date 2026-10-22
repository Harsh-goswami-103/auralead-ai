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

## Unresolved / carried forward

- `npm run test:e2e`: specs exist for smoke, the panel flows and `visual/webgl-fallback`; the rest of the visual projects (responsive, a11y, states) get specs in T31. In this Linux container Playwright 1.64's own browser build is not installed; the run above used the preinstalled Chromium through a throwaway config with `launchOptions.executablePath`.
- `RoleSwitcher` has no Landing or Docs entries; `/` now exists (ADR-66), `/docs` arrives in T37.
- `npm audit`: 9 high advisories, all in transitive dev tooling (eslint plugin `braces`, prisma's `deepmerge-ts`/`mysql2`); the only offered fix is a downgrade. Re-check at T38.
- npm warns about peer ranges for nested ESLint plugins declaring `eslint ^9`; lint works and every lint fixture passes.
- Preview-feature caveat (ADR-47): never call `findUnique`/`upsert` on the partial-unique keys of PricingVersion or Suppression; use `findFirst` with the predicate.
- `tests/unit/arch/lint-rules.test.ts` can hit its 5 s timeout under heavy parallel CPU load; passes alone and in the full gate runs.

- DEMO has no WhatsApp integration or approved template yet, so quote-over-WhatsApp cannot be shown through the UI; ADR-17 says DEMO seeds approved and rejected templates. Assigned to M4 (T28 integration center).
- Approve-and-send (`/api/app/approvals/[id]/send`) accepts an ineligible lead and leaves the skip to dispatch preflight, while the composer refuses upfront with 422. Safe, but inconsistent; fixed in the M4 follow-up.
- The E2E harness's `prisma migrate deploy` contacts `checkpoint.prisma.io`; set `CHECKPOINT_DISABLE=1` in the harness env (M4 follow-up).
- STOP does not set `withdrawnAt` on ConsentRecords; the active Suppression row is what blocks sends (by design, ADR-37).

## Next step

M4: T25-T30 in parallel (metrics, leads UI, branding, employee panel, admin panel, landing), then T31 responsive, accessibility and hostile-input pass.

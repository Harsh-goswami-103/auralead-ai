# Progress

Plan: [`implementation-plan.md`](implementation-plan.md) (milestones §11, checklist §15). Decisions: [`decisions.md`](decisions.md). Implementer handoff notes: [`handoff/`](handoff/).

## Status

| Milestone | Tasks | State | Date |
|---|---|---|---|
| M1 Foundation | T01-T09 | Done, exit gate green | 2026-10-16 |
| M2 Core lead-to-quote slice | T10-T17 | Done, exit gate green | 2026-10-16 |
| M3 Messaging | T18-T24 | Next | |
| M4 Panels and visual | T25-T31 | Not started | |
| M5 Integrations | T32-T36 | Not started | |
| M6 Hardening, docs, verify | T37-T39 | Not started | |

## M1 Foundation (T01-T09)

What exists:
- Toolchain at exact pins (plan §2): Next 16.4.1, React 19.3.1, TS 5.9.3, Prisma 7.10.0 + better-sqlite3 adapter, Tailwind 4.3.3, Vitest 5, Playwright 1.64, ESLint 10.12.0 with eslint-config-next 16.4.1 (the ESLint 9 fallback was not needed).
- One env loader and validated config (`src/lib/env-load.ts`, `src/lib/config.ts`), data paths outside OneDrive (`src/lib/paths.ts`), `npm run setup` that generates demo secrets.
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

## Unresolved / carried forward

- `npm run test:e2e` runs only the smoke project with content so far; the visual projects get specs in T30-T31.
- ESLint rule still to add: the ban on adapter imports inside `withTx` callbacks (first adapter-calling job, T19). The `--ai` token rule landed in T14.
- `RoleSwitcher` has no Landing or Docs entries until `/` (T30) and `/docs` (T37) exist.
- `npm audit`: 9 high advisories, all in transitive dev tooling (eslint plugin `braces`, prisma's `deepmerge-ts`/`mysql2`); the only offered fix is a downgrade. Re-check at T38.
- npm warns about peer ranges for nested ESLint plugins declaring `eslint ^9`; lint works and every lint fixture passes.
- Preview-feature caveat (ADR-47): never call `findUnique`/`upsert` on the partial-unique keys of PricingVersion or Suppression; use `findFirst` with the predicate.
- P15 mark-sent-manually route (APPROVED to SENT, sentVia MANUAL_LINK) is owed by T22 under `/api/app/quotes/**`.
- Quote status moves in T19/T22 must go through `nextQuoteStatus` so invalid moves give 409.
- A stage halted with STAGE_HANDLER_MISSING (APPROVAL today) resumes only via a new `pipeline.advance` job under a different key (T23).
- `tests/unit/arch/lint-rules.test.ts` can hit its 5 s timeout under heavy parallel CPU load; passes alone and in the full gate runs.

## Next step

M3, T18: consent and eligibility service, suppression history and SuppressionJournal producer, then T19-T24 per plan §11.

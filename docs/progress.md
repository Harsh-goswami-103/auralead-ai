# Progress

Plan: [`implementation-plan.md`](implementation-plan.md) (milestones §11, checklist §15). Decisions: [`decisions.md`](decisions.md). Implementer handoff notes: [`handoff/`](handoff/).

## Status

| Milestone | Tasks | State | Date |
|---|---|---|---|
| M1 Foundation | T01-T09 | Done, exit gate green | 2026-10-16 |
| M2 Core lead-to-quote slice | T10-T17 | Next | |
| M3 Messaging | T18-T24 | Not started | |
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

## Unresolved / carried forward

- `npm run test:e2e` runs only the smoke project with content so far; the visual projects get specs in T30-T31.
- ESLint rules still to add: the `--ai` token restriction and the ban on adapter imports inside `withTx` callbacks (plan §3, §12). They belong to whichever task first adds AI components (T14) and the first adapter-calling job (T19).
- `RoleSwitcher` has no Landing or Docs entries until `/` (T30) and `/docs` (T37) exist.
- `npm audit`: 9 high advisories, all in transitive dev tooling (eslint plugin `braces`, prisma's `deepmerge-ts`/`mysql2`); the only offered fix is a downgrade. Re-check at T38.
- npm warns about peer ranges for nested ESLint plugins declaring `eslint ^9`; lint works and every lint fixture passes.
- Preview-feature caveat (ADR-47): never call `findUnique`/`upsert` on the partial-unique keys of PricingVersion or Suppression; use `findFirst` with the predicate.

## Next step

M2, T10: ingestion service and the single pipeline orchestrator (normalize, dedupe to review, consent capture P1, `pipeline.advance` executor), then T11-T17 per plan §11.

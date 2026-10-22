# AuraLead AI

The plan is locked: [`docs/implementation-plan.md`](docs/implementation-plan.md). Decisions and deviations: [`docs/decisions.md`](docs/decisions.md) (append an ADR for any deviation). Scope: [`docs/PRD.md`](docs/PRD.md). Status: [`docs/progress.md`](docs/progress.md).

## Environment
- Windows 11, Node 22.23.2 (`.nvmrc`), npm 10.9.8. Repo path has a space and is OneDrive-synced: quote paths everywhere.
- Install with `npm ci` only. Every version is exact (plan §2); add packages with `npm install --save-exact`.
- In tests, spawn `process.execPath`, never `npm.cmd`.

## Commands (verified in T01)
| Command | What it does |
|---|---|
| `npm run setup` | Writes `.env` from `.env.example`, generating demo secrets; never overwrites existing keys |
| `npm run db:path` | Prints the resolved SQLite file (`--url` for the `file:` URL, `--json` for all paths) |
| `npm run db:migrate` / `db:deploy` | `prisma migrate dev` / `prisma migrate deploy` (T02) |
| `npm run db:seed` / `db:reset` / `demo:refresh` | Deterministic DEMO seed; reset wipes app tables and reseeds (refuses LIVE); refresh re-bases time fixtures without changing ids (T09) |
| `npm run pipeline:resume` | Enqueues one `pipeline.advance` per execution halted at a stage that now has a handler (STAGE_HANDLER_MISSING, e.g. APPROVAL before T23); idempotent (T23) |
| `npm run db:backup` | `VACUUM INTO` copy of this mode's DB into BACKUP_DIR plus a `.json` manifest (sha256, backup time, migrations) (T24) |
| `npm run db:restore -- --latest --yes` | Stop web and worker first. Writes `outbound.lock`, restores in one transaction, marks in-flight sends AMBIGUOUS, replays the SuppressionJournal, stays paused until resumed in Platform admin > Jobs (T24) |
| `npm run lead:erase -- --workspace <slug> --lead <id> --reason "<ref>" --yes` | Erases a lead's personal data; suppression keys kept, `contactPlain` nulled, PII-free `lead.erase` tombstone (T24) |
| `npm run admin:bootstrap -- --email <address>` | LIVE only. Prints a single-use invite link that creates the first SUPER_ADMIN (refuses once one exists); `--recover` prints a one-hour password reset link for an existing administrator (ADR-67, ADR-68) |
| `npm run creds:rotate` | Stop web and worker first. Re-encrypts every integration credential and webhook processing payload under CREDENTIALS_ACTIVE_KID; keep the old key in CREDENTIALS_KEYRING until it reports "Remaining under other kids: 0"; idempotent; exits 1 while anything is left or unreadable (T32) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `eslint .` (flat config, ESLint 10 + eslint-config-next 16.4.1) |
| `npm run test` | Vitest, all projects (unit, integration, components); runs with `TZ=America/New_York` |
| `npm run test:unit` / `test:integration` / `test:components` | One Vitest project |
| `npm run test:e2e` | Playwright (Chromium only; `npx playwright install chromium`) |
| `npm run dev` / `build` / `start` / `worker` | Next dev, full build (prisma generate, next build, tsup worker), next start, worker via tsx. Defined in T01; runnable once the schema (T02), app shell (T08) and worker (T07) exist |

Slice gate before finishing any task: `npm run typecheck && npm run lint && npm run test`.

## Invariants
- One env file, one loader: `.env` via `src/lib/env-load.ts` (real env wins). Call it first in every entry point. No `.env.local`.
- Config is validated in `src/lib/config.ts` (`getConfig()` / `parseConfig()`). `APP_MODE` is read only there and in `src/server/adapters/registry.ts`.
- Data lives outside the repo: `%LOCALAPPDATA%\auralead\<mode>\` (`app.db`, `storage\`, `backups\`, `journal\`, `outbound.lock`), resolved by `src/lib/paths.ts`. Test DBs go in `os.tmpdir()`.
- Import boundaries (plan §3), enforced by ESLint and `tests/unit/arch/*`: `src/lib` is framework-free; services/adapters/jobs/security/pdf never import `next/*` or `server-only`; the DB layer only from `src/server`, `worker`, `prisma/seed`, `scripts`, `tests`; adapters never import services.
- No `Date.now()` / argument-less `new Date()` in `src/server/**` or `worker/**`: use the injected clock.
- UI: no empty handlers, no `dangerouslySetInnerHTML`, no TODO or "coming soon", glow utilities only in `src/components/visual/**`. Gate controls with `GatedAction` only for configuration, permission, mode or eligibility (plan §12).
- UI v2 "Aurora" (ADR-66): colors only from tokens (`src/styles/tokens.css`), panel hue via `[data-panel]`; decorative effects and three.js only in `src/components/visual/**` (three only in `visual/aura`, behind `next/dynamic`); pages compose `PageHeader`, `SectionCard`, `StatTile`, `SourceChip`. No count-ups or invented numbers; status is icon + label; violet is AI only.
- Money is BigInt paise; mutations go through `/api/app/*` and `/api/admin/*` route handlers, never Server Actions.
- Stop web and worker before `prisma generate` or `migrate` (Windows file locks).
- Tests first; no stubs, no skipped tests. Never fake a provider result.

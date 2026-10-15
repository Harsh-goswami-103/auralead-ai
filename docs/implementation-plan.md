# AuraLead AI: Implementation Plan (locked)

Status: LOCKED 2026-10-15. Owner: lead engineer. Source of scope: [`PRD.md`](PRD.md). Decisions and deviations: [`decisions.md`](decisions.md) (ADR numbers cited as `ADR-nn`).
Review inputs: [`reviews/ceo-review.md`](reviews/ceo-review.md) (ledger M1, M2, O1-O6) and [`reviews/ceo/99-critic.md`](reviews/ceo/99-critic.md) (rulings C1-C20, remedies P1-P20, assumptions A1-A42). Where an older review file conflicts with a C-ruling, the ruling wins, and this plan already applies it. The eng-review outside voice findings E1-E12 (Codex, 2026-10-15) are accepted and applied throughout; see §15.5. Test file paths in this plan supersede the paths proposed in the review files.

Changing anything in this file requires a new ADR in `decisions.md` and a `progress.md` note.

---

## 0. How implementer agents use this plan

1. Take the lowest-numbered task whose dependencies are done (or a task marked parallel-safe with one in flight).
2. Write the listed tests first. They must fail for the right reason before implementation starts.
3. Implement until the listed tests pass, then run the slice gate: `npm run typecheck && npm run lint && npm run test`.
4. Update `docs/progress.md` (what was done, commands run, unresolved issues, exact next step) and tick the matching rows in section 15 with the test path.
5. Never edit files owned by a parallel task in flight (ownership is listed per task). Shared files (`prisma/schema.prisma`, `src/server/routes.manifest.ts`, `prisma/seed/**`, `package.json`) are append-only during parallel work, and merge conflicts there are resolved by the later task.
6. Do not add scope. If a requirement looks impossible, record it in `progress.md` and stop that thread; do not stub it (section 12, O4).

---

## 1. Environment facts

| Fact | Consequence |
|---|---|
| Windows 11, Node 22.23.2, npm 10.9.8, git bash available | All scripts must run under PowerShell and git bash. Spawn `process.execPath`, never `npm.cmd`, in tests. |
| Repo path `C:\Users\Asus\OneDrive\Documents\projects\mini project` contains a space and is OneDrive-synced | Quote paths in every npm script. Never put the DB, storage, backups or test DBs in the repo. `.gitattributes` sets `* text=auto eol=lf` so HMAC fixtures are byte-stable. |
| OneDrive corrupts SQLite WAL files and locks `-wal`/`-shm` | Data dir defaults to `%LOCALAPPDATA%\auralead\<mode>\` (A5): `app.db`, `storage\`, `backups\`, `journal\` (SuppressionJournal, E8), `outbound.lock`. Overrides: `AURALEAD_DATA_DIR`, `DATABASE_URL`, `STORAGE_DIR`, `BACKUP_DIR`. Boot logs a warning if any resolved path contains `OneDrive`. Test DBs live in `os.tmpdir()/auralead-test-<runId>/`. |
| Native modules: better-sqlite3, @node-rs/argon2, sharp | Prebuilt binaries only, no node-gyp. Verified by the M1 spike (T02). All three are listed in `serverExternalPackages`. Stop web and worker before `prisma generate` or `migrate` (EPERM on locked files). |
| Google_Map_Extractor original copy at `~/Downloads/Google_Map_Extractor (1)/` (MV3 v21.0), plus a license-stripped copy | Decision M1/D3: copy-agnostic bridge, no vendor code committed (ADR-13). |

---

## 2. Stack (exact pins, verified on the npm registry 2026-10-15)

All versions are exact in `package.json` (no `^` or `~`). `package-lock.json` is committed. Install with `npm ci`. Package manager: npm 10.9.8. Runtime: Node 22.23.2 (`"engines": { "node": ">=22.12 <23" }`, `.nvmrc` = `22.23.2`).

### 2.1 Runtime dependencies

| Package | Version | Notes |
|---|---|---|
| next | 16.4.1 | App Router. Turbopack is the default for dev and build. `middleware.ts` is replaced by `src/proxy.ts` (Node runtime). Route handler and page `params` are Promises (`const { token } = await params`). `next lint` is gone; lint runs `eslint .`. |
| react, react-dom | 19.3.1 | r3f 9.8.2 requires `react >=19 <19.4`. Do not bump to 19.4 without bumping r3f. |
| typescript (dev) | 5.9.3 | Not 7.x (native compiler, tooling risk). typescript-eslint 8.71.2 supports `<6.1`. ADR-03. |
| prisma (dev), @prisma/client, @prisma/adapter-better-sqlite3 | 7.10.0 | Not 8.0 rc. `prisma.config.ts`, generator `provider = "prisma-client"` with explicit `output`, `PrismaBetterSqlite3` adapter. ADR-02. |
| better-sqlite3 | 12.11.1 | The adapter 7.10.0 depends on `^12.6.0`. Do not take 13.x (latest) until the adapter allows it. |
| dotenv | 18.0.8 | Prisma 7 does not auto-load `.env`. Used only inside `src/lib/env-load.ts` (E12), which `prisma.config.ts`, `next.config.ts`, the worker, the seed and every script call first. |
| tailwindcss, @tailwindcss/postcss | 4.3.3 | Tokens via CSS `@theme` (no `tailwind.config.ts`). |
| tw-animate-css | 1.4.0 | shadcn Tailwind 4 animation preset. |
| radix-ui | 1.8.1 | Unified Radix package used by current shadcn output. The shadcn CLI (`npx shadcn@4.21.5`) is run once per component, not installed. Verify generated imports in T08. |
| class-variance-authority 0.7.1, clsx 2.1.1, tailwind-merge 3.7.0 | as listed | shadcn utilities. |
| lucide-react | 1.57.0 | Icons. |
| sonner | 2.0.8 | Toasts. |
| cmdk | 1.1.1 | Command palette. |
| zod | 4.6.7 | One schema set in `src/lib/schemas/**` shared by forms and routes. |
| react-hook-form | 7.90.0 | With @hookform/resolvers 5.9.1 (Zod 4 resolver). |
| @tanstack/react-table | 8.21.3 | 9.3.1 is the latest stable, but shadcn data-table patterns target the v8 API (`useReactTable`). Pinned to 8.x; T26 records whether v9 works with the generated components and opens an ADR only if switching. ADR-01. |
| @tanstack/react-query | 5.104.3 | Client data fetching and polling. |
| zustand | 5.0.15 | Shared client UI state only (selection, panel toggles). Never server data. |
| recharts | 3.10.1 | Needs `react-is` 19.3.1. Lazy-loaded per route. |
| three | 0.186.1 | Landing hero and the optional command-center tile only. |
| @react-three/fiber | 9.8.2 | |
| @react-three/drei | 10.7.9 | |
| motion | 14.3.0 | The only animation library. No GSAP, no Lenis. |
| @xyflow/react | 12.12.0 | Pipeline editor. Keep attribution visible. |
| @react-pdf/renderer | 4.9.0 | Quote PDFs in the worker (C1). |
| @node-rs/argon2 | 2.2.2 | argon2id, prebuilt Windows binary. |
| sharp | 0.35.5 | Logo re-encode (P7). |
| libphonenumber-js | 1.13.15 | E.164, default region IN. |
| @anthropic-ai/sdk | 0.134.0 | Server only. |
| openai | 7.34.0 | Server only. |
| resend | 6.33.0 | Server only. |
| nodemailer | 10.1.1 | SMTP. T33 checks whether v10 ships types; add `@types/nodemailer` 8.0.2 only if it does not. |
| google-auth-library | 11.3.0 | Sheets service-account JWT (P14). |
| pino | 10.4.0 | Structured logs, no transports. `pino-pretty` 13.2.0 as a dev pipe only. |
| undici | 8.12.2 | `safeFetch` uses the package's own `request` with an `Agent` whose `connect.lookup` pins the validated IP. Never mix the package `Agent` with global `fetch`. |
| ipaddr.js | 2.5.0 | Public-unicast check for SSRF. |
| server-only | 0.0.1 | Only in `src/app/**` server modules and `src/server/auth/session.ts`. |

### 2.2 Dev and test dependencies

| Package | Version | Notes |
|---|---|---|
| vitest | 5.0.5 | Needs vite `^6.4 or ^7 or ^8`. |
| vite | 8.3.4 | |
| @vitejs/plugin-react | 6.1.2 | Component tests. |
| vite-tsconfig-paths | 6.1.1 | `@/` alias in tests. |
| jsdom | 30.1.3 | Component test environment. |
| @testing-library/react | 16.3.3 | |
| fast-check | 4.10.2 | Property tests (money, rank merge, shuffle). Fixed seed. |
| @playwright/test | 1.64.1 | Chromium only (A-test 6.14). `npx playwright install chromium`. |
| @axe-core/playwright | 4.14.0 | a11y checks. |
| pdfjs-dist | 6.4.299 | PDF text extraction in AT6 parity tests. |
| get-port | 7.2.0 | Free ports for E2E. |
| tsx | 4.23.15 | Runs the worker, seed and scripts in dev. |
| tsup | 9.0.0 | Bundles `worker/index.ts` to `dist/worker.js`. |
| concurrently | 10.0.6 | `npm run dev:all`. |
| eslint | 10.12.0 | Flat config. If `eslint-config-next` 16.4.1 fails on ESLint 10 in T01, fall back to the latest 9.x and record it in ADR-01. |
| eslint-config-next | 16.4.1 | |
| typescript-eslint | 8.71.2 | |
| @eslint/js | 10.0.1 | |
| @types/node 22.20.5, @types/react 19.3.0, @types/react-dom 19.3.0 | as listed | |

### 2.3 Next 16 specifics every task must respect

- `src/proxy.ts` only sets `x-request-id`, security headers and the demo banner flag. It never authorizes, rate-limits or reads the DB (12.3: do not rely on middleware/proxy for limits or authz).
- Every route handler sets `export const runtime = 'nodejs'` and `export const dynamic = 'force-dynamic'` where it reads cookies, bodies or the DB.
- `next.config.ts`: `serverExternalPackages: ['better-sqlite3', '@prisma/adapter-better-sqlite3', '@node-rs/argon2', 'sharp', '@react-pdf/renderer']`, security headers, `poweredByHeader: false`. No `output: 'standalone'` until a deploy is authorized.
- Mutations go through route handlers under `/api/app/*` and `/api/admin/*` wrapped by `withRoute()`. No Server Actions for mutations (one CSRF model, HTTP-testable tenant matrix). ADR-26.

---

## 3. Repo layout

```
.
├── CLAUDE.md                      verified commands, invariants, links (kept short)
├── README.md
├── .env.example                   every key, with demo-safe defaults; no secrets
├── .env                           gitignored; written by `npm run setup` (E12); the only env file
├── .gitattributes                 * text=auto eol=lf
├── .nvmrc                         22.23.2
├── package.json / package-lock.json
├── next.config.ts  postcss.config.mjs  eslint.config.mjs  tsconfig.json
├── vitest.config.ts               projects: unit, integration (node), components (jsdom)
├── playwright.config.ts           projects: smoke, w390, w768, w1440, w1920, reduced-motion, no-webgl
├── prisma.config.ts               Prisma 7 config (schema path, migrations, seed, datasource url)
├── prisma/
│   ├── schema.prisma              SQLite source of truth
│   ├── migrations/                includes hand-written partial unique indexes
│   ├── seed/                      index.ts, fixtures/*.ts (deterministic, SEED_NOW)
│   └── postgres/                  generated PG schema (T37 docs; scripts/gen-pg-schema.ts)
├── src/
│   ├── proxy.ts                   request id + headers only
│   ├── app/                       THIN: parse -> ctx -> service -> map result
│   │   ├── (public)/page.tsx                 landing
│   │   ├── (public)/docs/[[...slug]]/page.tsx
│   │   ├── (public)/quote/[token]/page.tsx   share-token gated quote
│   │   ├── (public)/unsubscribe/[token]/page.tsx
│   │   ├── (auth)/login/page.tsx  (auth)/invite/[token]/page.tsx
│   │   ├── dashboard/user/{page,leads,leads/[leadId],inbox,inbox/[conversationId],pricing,quotations,quotations/[quoteId],quotations/new}
│   │   ├── dashboard/employee/{page,approvals}
│   │   ├── dashboard/employee/[ws]/{leads,leads/scoring,sheets,meta,extension,approvals,integrations,pipeline}
│   │   ├── dashboard/admin/{page,workspaces,workspaces/[id],people,productivity,audit,jobs,webhooks}
│   │   └── api/
│   │       ├── app/**             session + CSRF tenant API
│   │       ├── admin/**           super admin API (reason field on mutations)
│   │       ├── webhooks/{google-sheets,meta-ads,gmaps-extension,whatsapp,email/[provider]}/route.ts
│   │       ├── quote-share/[token]/{view,accept,pdf}/route.ts
│   │       ├── quotes/[id]/pdf/route.ts   authenticated download
│   │       ├── unsubscribe/route.ts
│   │       ├── demo/{session,simulate/[source]}/route.ts      404 unless APP_MODE=demo
│   │       ├── test/{clock,reset}/route.ts                    404 unless demo + flag + token
│   │       └── health/route.ts
│   ├── server/
│   │   ├── boot.ts                env validation, mode checks, OneDrive warning, LIVE refusals
│   │   ├── db/                    client.ts (adapter + PRAGMAs), tx.ts (withTx + busy retry),
│   │   │                          scoped.ts (tenant extension + assertSameWorkspace, E10),
│   │                          fence.ts (claimToken fence, E5), raw/claim-job.ts (all raw SQL)
│   │   ├── auth/                  session.ts, password.ts, context.ts, guards.ts, demo-personas.ts
│   │   ├── security/              secrets.ts (AES-GCM keyring), csrf.ts, rate-limit.ts, raw-body.ts,
│   │   │                          hmac.ts, tokens.ts, safe-fetch.ts, contact-key.ts, safe-href.ts
│   │   ├── services/              the ONLY writers of state; (ctx, input) signatures
│   │   │   ├── leads/             ingest.ts normalize.ts dedupe.ts merge-review.ts stage.ts export.ts
│   │   │   ├── scoring/           score.ts config.ts
│   │   │   ├── enrichment/        website.ts
│   │   │   ├── pricing/           catalog.ts compute-totals.ts settings.ts branding.ts
│   │   │   ├── quotes/            state-machine.ts versioning.ts share.ts render-model.ts accept.ts
│   │   │   ├── approvals/         approvals.ts payload-hash.ts
│   │   │   ├── messaging/         eligibility.ts window.ts consent.ts suppression.ts suppression-journal.ts dispatch.ts
│   │   │   │                      delivery-state.ts conversations.ts inbound.ts quick-replies.ts
│   │   │   ├── ai/                drafts.ts proposal.ts output-policy.ts reply-guard.ts context-builder.ts
│   │   │   ├── campaigns/  call-requests/  integrations/  pipeline/  bulk/
│   │   │   ├── audit/record.ts    metrics/*.ts   admin/*.ts   jobs-admin/*.ts
│   │   ├── adapters/              ports + implementations; registry.ts is the only mode switch
│   │   │   ├── ai/{port,anthropic,openai,local-deterministic}.ts
│   │   │   ├── whatsapp/{port,cloud-api,demo,media,error-map,limits}.ts
│   │   │   ├── email/{port,resend,smtp,demo}.ts
│   │   │   ├── meta/{port,graph,demo}.ts  sheets/{port,google,demo}.ts
│   │   │   ├── storage/local-fs.ts  http/outbound.ts (DEMO tripwire)
│   │   │   └── registry.ts
│   │   ├── jobs/                  queue.ts registry.ts reaper.ts backoff.ts handlers/*.ts
│   │   ├── pdf/                   QuotePdf.tsx fonts/ (Inter TTF + OFL) render.ts
│   │   ├── routes.manifest.ts     every route + actors + fixture ids (feeds tenant matrix and AT1 crawl)
│   │   └── testing/pause.ts       named pause points, no-op unless NODE_ENV=test
│   ├── lib/                       framework-free, importable anywhere
│   │   env-load.ts clock.ts config.ts paths.ts money.ts phone.ts ids.ts errors/ logger.ts redact.ts
│   │   correlation.ts format/ schemas/ domain/enums.ts
│   ├── components/
│   │   ├── ui/                    shadcn output
│   │   ├── patterns/              StatusBadge GatedAction EmptyState ErrorState LoadingSkeleton
│   │   │                          PartialNotice ConfirmDialog BulkResultSummary ModeBanner RoleSwitcher
│   │   │                          WorkspaceChip ConsentChips ScoreBreakdown
│   │   ├── quote/QuoteDocument.tsx
│   │   └── visual/                HeroGlobe GlobePoster useVisualBudget (only place for glow/WebGL)
│   ├── styles/tokens.css
│   └── generated/prisma/          Prisma 7 client output (gitignored, generated on install/build)
├── worker/index.ts                loop, heartbeat, reaper, graceful shutdown (SIGINT, SIGTERM, SIGBREAK)
├── extension-bridge/              saas-sync.js options.html options.js PATCH-GUIDE.md examples/*.json README.md
├── scripts/                       db-path.ts setup.ts db-backup.ts db-restore.ts demo-refresh.ts
│                                  creds-rotate.ts lead-erase.ts gen-pg-schema.ts verify.mjs capture-previews.ts
├── tests/
│   ├── unit/                      pure modules, FixedClock, no I/O
│   ├── integration/               real SQLite file per test file in os.tmpdir(); includes contract/ and chaos/
│   ├── components/                jsdom component tests
│   ├── e2e/                       Playwright against the built app + worker
│   └── support/                   db harness, fixtures, fake providers, fake chrome.*, spawn helpers
└── docs/                          PRD, plan, decisions, progress, integrations, deployment, runbooks, architecture
```

Import rules (ESLint `no-restricted-imports` plus `tests/unit/arch/import-boundaries.test.ts` walking the graph):

- `src/lib/**` imports nothing from `src/server`, `src/app`, `next/*`, `server-only`, Prisma.
- `src/server/services|adapters|jobs|security|pdf/**` never import `next/*` or `server-only` (5.3; the worker would crash).
- `@/generated/prisma` and `src/server/db/**` are importable only from `src/server/**`, `worker/**`, `prisma/seed/**`, `scripts/**`, `tests/**`.
- `src/server/adapters/**` never import `src/server/services/**`.
- `APP_MODE` is read only in `src/lib/config.ts` and `src/server/adapters/registry.ts` (grep test).
- `Date.now()` and argument-less `new Date()` are banned outside `src/lib/clock.ts` in `src/server/**` and `worker/**`.
- Adapter imports are banned inside `withTx` callbacks (lint rule on the callback body: no `adapters/` symbols, no `await` of network calls).
- Glow utilities (`shadow-[0_0_`, `drop-shadow`) only in `src/components/visual/**`; `--ai` token only in AI components.
- `onClick={() => {}}`, empty handlers and `TODO` are lint errors in `src/app/**` and `src/components/**`.

---

## 4. Architecture

```
 BROWSERS / CALLERS
 +-----------+ +----------------+ +---------------+ +----------------+ +--------------------------+
 | Landing,  | | Panels         | | /quote/[token]| | MV3 extension  | | Meta, WhatsApp, Resend,  |
 | /docs     | | user/emp/admin | | (share token) | | Bearer alx_... | | Apps Script (HMAC)       |
 +-----+-----+ +-------+--------+ +-------+-------+ +-------+--------+ +------------+-------------+
       |      cookie + CSRF |   no cookies |                |   signed raw body        |
 ======v====================v==============v================v==========================v=========
 NEXT.JS 16 (one process, one APP_MODE, runtime=nodejs everywhere)
   src/proxy.ts: x-request-id, headers. NO authz, NO rate limit, NO DB.
   src/app/api/** withRoute(): raw body/size cap -> auth (session | token | signature) -> rate limit
                  -> CSRF (cookie mutations only) -> zod -> ctx -> service -> typed result -> HTTP
   RSC pages read through services with ctx (never Prisma directly)
 ------------------------------------------------------------------------------------------------
   server/auth (ctx)  ->  server/services (state + audit)  ->  lib (pure: money, window, rank...)
                                  |                \
                                  v                 -> server/adapters/registry -> ports -> demo | live impl
                     server/db (scoped Prisma, withTx, raw/claim-job)
 ================================|===============================================================
                                 v
           +---------------------------------------------+
           | SQLite file  %LOCALAPPDATA%\auralead\<mode>\app.db |
           | WAL, busy_timeout=5000, foreign_keys=ON      |  one writer at a time, two processes
           +---------------------------------------------+
                                 ^
 ================================|===============================================================
 WORKER (npm run worker | node dist/worker.js), no HTTP listener
   loop: reaper (C8) -> claim (single UPDATE...RETURNING) -> handler(job ctx) -> settle (claimToken fence)
   handlers call the SAME services; provider HTTP never inside a DB transaction
   PDF: @react-pdf/renderer -> STORAGE_DIR/quotes/... + QuoteArtifact(sha256)
   heartbeat row every 10 s; honors SystemSetting.outboundPaused OR outbound.lock OR OUTBOUND_PAUSED=1
```

Allowed dependency direction: `app -> server/auth -> server/services -> lib`; `services -> adapters (via registry ports) -> security/safe-fetch, adapters/http/outbound`; `services -> server/db`; `worker -> server/jobs -> server/services`. Demo simulators call `services.*` exactly as webhooks and adapters do (PRD "same application services").

### 4.1 Request context

```ts
// src/server/auth/context.ts (types live in src/lib/domain/context.ts)
type Ctx = {
  kind: 'user' | 'job' | 'system' | 'public' | 'webhook';
  correlationId: string;              // from x-request-id or generated; stored on Job, AuditEvent, JobAttempt
  causationId?: string;               // parent job or request
  mode: 'demo' | 'live';              // from boot config, never from cookie/query
  actor: { userId: string; role: 'USER' | 'EMPLOYEE' | 'SUPER_ADMIN'; isDemo: boolean } | null;
  workspaceId: string | null;         // resolved server-side: Session.activeWorkspaceId checked against
                                      // Membership, or [ws] slug checked against EmployeeAssignment,
                                      // or Job.workspaceId, or Integration lookup for webhooks
  capabilities: ReadonlySet<Capability>;
  maxDiscountBps: number | null;      // actor's cap (owner: workspace hard limit)
  elevated?: { reason: string; auditEventId: string };   // super admin drilldown only
  clock: Clock;
  db: ScopedDb;                       // tenant-scoped Prisma when workspaceId is set
};
```

Rules: built only by `getRequestContext(req)`, `getJobContext(job)`, `getWebhookContext(integration)`, `publicContext()` or `adminContext(ctx, targetWorkspaceId, reason)` (writes the AuditEvent before returning). Every service function signature is `(ctx, input)`. Browser-supplied `workspaceId`, `role` or `userId` in a body or query is ignored; a mismatch with the resolved context returns 404 (A6). Cross-tenant reads return 404, in-tenant capability failures return 403.

### 4.2 Modes (C20, ADR-04)

- `APP_MODE=demo|live` read once at boot. One process serves one mode and opens one DB file (`<DATA_DIR>/<mode>/app.db`). `Workspace.mode` is kept and checked as defense in depth by simulators and the adapter registry.
- DEMO: seeded identities, role switcher on every route (P19), simulators, deterministic AI by default, demo transports, `adapters/http/outbound.ts` throws `OutboundBlockedInDemo` for every host (zero outbound, tested).
- LIVE: role switcher, `/api/demo/**` and `/api/test/**` are absent (404, and the switcher component is excluded at build time via `NEXT_PUBLIC_APP_MODE`). Boot refuses to start without `CREDENTIALS_KEYRING`, `SUPPRESSION_PEPPER`, `SESSION_SECRET`, `SHARE_NONCE_KEY`, or with `AURALEAD_TEST_CONTROL=1`. Missing provider credentials produce `IntegrationNotConfigured` results, never a demo transport.

### 4.3 Worker and jobs (A8, C7, C8, C9)

- Separate process: `npm run worker` (`tsx worker/index.ts`; env loaded by `src/lib/env-load.ts`, E12), production `node dist/worker.js`. Refuses to start with pending migrations. Concurrency 1 by default (config up to 4 for provider-bound types).
- Claim is one statement in `server/db/raw/claim-job.ts`:

```sql
UPDATE "Job" SET status='RUNNING', claimToken=?, leaseUntil=?, attempts=attempts+1, startedAt=?, updatedAt=?
WHERE id = (
  SELECT id FROM "Job"
  WHERE status='QUEUED' AND runAt <= ?
    AND (serialKey IS NULL OR serialKey NOT IN (SELECT serialKey FROM "Job" WHERE status='RUNNING' AND serialKey IS NOT NULL))
  ORDER BY priority, runAt LIMIT 1)
AND status='QUEUED'
RETURNING *;
```

  Zero rows means the race was lost; loop. Dates are bound as parameters in the same representation Prisma writes (verified in T02). Same SQL runs on PostgreSQL; `FOR UPDATE SKIP LOCKED` is the documented PG upgrade.
- Lease fencing (E5, ADR-39): every job-driven write transaction (preflight, settle, fail, and any domain write a handler makes) starts with `fenceJob(tx, jobId, claimToken)` in `server/db/fence.ts`, a write-first `UPDATE "Job" SET updatedAt=? WHERE id=? AND claimToken=? AND status='RUNNING'`. Zero rows throws `LeaseLostError`, which rolls back the whole transaction before any domain write and before any provider call. Handlers never write domain state outside a fenced transaction.
- Lease 60 s, extended by heartbeat every 20 s for long jobs. Worker heartbeat row every 10 s.
- Reaper (C8), every loop: for each `RUNNING` job with `leaseUntil < now`, in one transaction: if a `DispatchAttempt` for that job is `SENDING`, set the attempt `AMBIGUOUS` and the job `DEAD(reason=AMBIGUOUS)`; otherwise set the job `QUEUED` with backoff. Never requeue a job holding a SENDING attempt.
- Backoff `min(base * 2^n, cap)` plus jitter; max attempts per type (send 5, ai 3, fetch 8, pdf 3, default 5); then `DEAD` with a redacted error. Deferrals (pause, throttle, cap) settle as `QUEUED` with a later `runAt` and refund the attempt counter.
- `Job.idempotencyKey` UNIQUE. Scheduled work (quote expiry sweep, quality checks, purge) is enqueued with a time-bucket key (`quote-expiry:2026-10-15T10`), so duplicate schedulers never double-run.
- `Job.serialKey = conversationId` for dispatch and reply jobs (per-conversation ordering).
- Payloads carry IDs and `payloadVersion`, never secrets. Unknown `payloadVersion` goes `DEAD`.
- No timers or detached promises in handlers or routes (`no-floating-promises` lint).
- Shutdown on SIGINT, SIGTERM, SIGBREAK: stop claiming, finish the current job up to 25 s, exit. Correctness never depends on shutdown hooks (Windows `taskkill /F` sends nothing).
- Synchronous exception (C9, ADR-06): Stop (WhatsApp quick reply `AL_QR_STOP_V1` or STOP keyword list) and email unsubscribe are processed inside the verified webhook or unsubscribe route transaction: insert `WebhookEvent`, insert `Suppression`, cancel `QUEUED` DispatchAttempts and their jobs for that contact and channel, write the AuditEvent; after commit the same suppression service appends the SuppressionJournal entry (E8). Everything else in webhooks is verify, persist, enqueue, 200.
- Webhook persistence (E1, E2, ADR-35, ADR-36): `WebhookEvent` keeps two payloads. `payloadRedacted` is the inspector view. `processingPayload` is the full parsed body encrypted with AES-256-GCM under the credentials key ring (AAD = `webhookEventId`), so a worker restart between persist and process still has the contact data it needs. It is purged (`processingPurgedAt`) by `webhook.purge` after successful processing plus the retention window (default 7 days; failed or unrouted events keep it until resolved or 30 days). Idempotency is scoped by the authenticated source: UNIQUE `(provider, scopeKey, externalKey)` where `scopeKey` is the routed `integrationId`, else the authenticated `workspaceId` (extension token), else `unrouted`.
- Pipeline orchestration (E9, ADR-43): ingestion enqueues only `pipeline.advance`, never downstream jobs directly. The executor reads the lead's pinned `PipelineConfigVersion`, runs the next stage, and records each stage in `PipelineStageRun` (UNIQUE executionId + stage), so replays and restarts cannot run a stage twice.

### 4.4 Outbox (C7, ADR-05)

One table `DispatchAttempt`. Every outbound provider mutation (WhatsApp send, email send) goes through it. Meta campaign status changes use the analogous `CampaignAction` row (same SENDING-before-call rule).

Dispatch handler, three short transactions, no network inside any. Every transaction after the claim begins with the claimToken fence (E5); a lost lease aborts before any write or provider call.
1. Claim (statement above).
2. Preflight tx (fenced): `loadEligibilityInput` + `evaluateDispatchEligibility` (section 7) using the persisted `sendIntent` of the attempt (E4), approval `payloadHash` recompute (O3), quote version current, PDF artifact present when attached. Fail: attempt `SKIPPED` or `CANCELLED` with a reason code, or deferral (attempt stays `QUEUED`, job `runAt` later). Pass: attempt `SENDING`, committed. Pause point `P2`.
3. Provider call (outside tx). Pause point `P3`.
4. Settle tx (fenced): attempt `SENT` + `providerMessageId` (UNIQUE), Message projection, lead stage forward-only, job `SUCCEEDED`, audit. Quote CAS (E6, ADR-40): `UPDATE Quote SET status='SENT' WHERE id=? AND currentVersionId = attempt.quoteVersionId AND status='APPROVED'`; if zero rows (the quote was revised or re-approved meanwhile), set only `QuoteVersion.sentAt` on the attempt's version, audit `quote.sent_superseded_version`, and leave the Quote untouched.
5. Failure outcomes (E7, ADR-41), each a fenced settle with `DispatchAttempt.failureClass`:
   - `PRE_SEND`: definite failure before the request was written (DNS, connect refused, TLS before write). Attempt FAILED, job requeued with backoff, the retry creates attempt N+1 and re-runs preflight.
   - `RETRYABLE`: definite provider rejection that is safe to repeat (HTTP 429, 5xx with no-write evidence per the error map, SMTP 4xx). Attempt FAILED(RETRYABLE, reason), job requeued with backoff (honoring `Retry-After`; 429 also sets the workspace or pair throttle window so later preflights defer), attempt N+1 re-runs preflight. Bounded by the job's max attempts, then DEAD.
   - `PERMANENT`: non-retryable 4xx per the error map. Attempt FAILED(PERMANENT, reason), job SUCCEEDED (handled), item back to review where applicable.
   - Timeout or reset after the request was written: attempt `AMBIGUOUS`, job `DEAD(AMBIGUOUS)`, no retry.

AMBIGUOUS is resolved only by a matching status webhook (positive evidence: `providerMessageId` or the echoed `biz_opaque_callback_data = attemptId`, field UNVERIFIED) or by an operator ("Mark delivered" or "Verified not delivered, requeue", typed reason, audited, requeue re-runs preflight). A missing echo never auto-resolves to "not sent" (12.3).

---

## 5. Data model (Prisma, SQLite source of truth)

Conventions: IDs are `cuid2` strings (never sequential in URLs). Tables singular PascalCase. Enum values UPPER_SNAKE. All money columns are `BigInt` named `*Paise` (C11, ADR-07); domain type `bigint`; DTOs serialize as decimal strings. Rates are `Int` basis points (`*Bps`). Times are `DateTime` UTC named `*At`. Every tenant-owned model, including child rows such as `PriceEntry`, `QuoteItem`, `JobAttempt` and `PipelineStageRun`, has `workspaceId` (required, or nullable only on system-job rows) and an index starting with it (E10, ADR-42). Services validate every referenced id (serviceId, quoteId, leadId, conversationId, templateId, pricingVersionId) against `ctx.workspaceId` inside the transaction with `assertSameWorkspace(tx, ctx, refs)` (throws `TenantScopeError`, 404). Where Prisma and SQLite allow it, child relations use composite foreign keys `(workspaceId, parentId) -> parent(workspaceId, id)` backed by `@@unique([workspaceId, id])` on the parent; T03 verifies which relations Prisma 7 accepts and records the rest as service-enforced. JSON columns (`Json`) are never filtered on; filterable data gets real columns. Partial unique indexes that Prisma cannot express are hand-written SQL in migrations, marked `-- PARTIAL UNIQUE`.

### 5.1 Enums

```
AppMode            DEMO LIVE
GlobalRole         USER EMPLOYEE SUPER_ADMIN
MembershipRole     OWNER MEMBER
UserStatus         INVITED ACTIVE DISABLED
WorkspaceStatus    ACTIVE SUSPENDED
SalesStage         NEW CONTACTED REPLIED QUOTE_SENT CONVERTED LOST
LeadSource         GOOGLE_SHEETS META_ADS GMAPS_EXTENSION WHATSAPP_INBOUND EMAIL_INBOUND MANUAL
WebsiteStatus      UNKNOWN PRESENT_UNVERIFIED REACHABLE UNREACHABLE BLOCKED VERIFIED_ABSENT
SourceRecordStatus ACCEPTED DUPLICATE REVIEW REJECTED UNRETRIEVABLE
ImportBatchStatus  RECEIVED PROCESSING COMPLETED PARTIAL FAILED
MergeReviewStatus  OPEN MERGED KEPT_SEPARATE DISMISSED
ContactKeyKind     PHONE EMAIL PROVIDER
Channel            WHATSAPP EMAIL
ConsentPurpose     MARKETING SERVICE_CONVERSATION
ConsentBasis       OPT_IN INBOUND_MESSAGE B2B_ATTESTED
ConsentSource      SHEETS_FORM META_FORM INBOUND_MESSAGE START_KEYWORD MANUAL_EVIDENCE EMPLOYEE_ATTESTATION
SuppressionReason  STOP_BUTTON STOP_KEYWORD UNSUBSCRIBE HARD_BOUNCE COMPLAINT MARKETING_STOPPED MANUAL
QuoteStatus        DRAFT APPROVED SENT VIEWED ACCEPTED EXPIRED CANCELLED
DiscountKind       NONE PERCENT_BPS FLAT_PAISE
ApprovalKind       QUOTE_VERSION OUTBOUND_MESSAGE PRICING_REVIEW
ApprovalStatus     PENDING APPROVED REJECTED INVALIDATED
ConversationAiMode OFF DRAFT AUTO
MessageDirection   IN OUT
MessageStatus      DRAFT PENDING SENT DELIVERED READ FAILED UNKNOWN NOT_SENT
DispatchState      QUEUED SENDING SENT FAILED SKIPPED AMBIGUOUS CANCELLED
DispatchFailureClass PRE_SEND RETRYABLE PERMANENT
SendIntent         MANUAL_SINGLE BULK AUTOMATED CUSTOMER_REQUESTED_REPLY
PipelineStage      INGESTION SCORE DRAFT APPROVAL DELIVERY
StageRunStatus     PENDING RUNNING DONE SKIPPED FAILED
JournalAction      STOP CLEAR
JobStatus          QUEUED RUNNING SUCCEEDED DEAD CANCELLED
JobAttemptOutcome  SUCCEEDED RETRYABLE FATAL AMBIGUOUS LEASE_LOST DEFERRED
IntegrationKind    WHATSAPP_CLOUD EMAIL_RESEND EMAIL_SMTP META_ADS GOOGLE_SHEETS AI_ANTHROPIC AI_OPENAI
IntegrationStatus  NOT_CONFIGURED CONFIGURED_UNVERIFIED VERIFYING CONNECTED DEGRADED ERROR REVOKED SIMULATED
WebhookProvider    META_ADS WHATSAPP GOOGLE_SHEETS GMAPS_EXTENSION RESEND DEMO
WebhookStatus      RECEIVED PROCESSED FAILED UNROUTED PENDING_CORRELATION ORPHAN
CallRequestStatus  OPEN CONTACTED DONE CANCELLED
CallRequestSource  QUICK_REPLY MANUAL
CampaignActionState PENDING SENDING SUCCEEDED FAILED UNKNOWN SIMULATED
QuoteViewKind      FETCH BEACON
AuditResult        SUCCESS DENIED FAILED
PipelineApprovalMode HUMAN POLICY_AUTO
```

`RETRY_WAIT` is a UI label for `QUEUED` with future `runAt` (C7). "Delivery unknown" is the UI copy for `AMBIGUOUS` / `UNKNOWN`. Template status, template category, quality rating and messaging limit are stored as raw provider strings, never enums (12.3).

### 5.2 Identity, tenancy, settings

| Model | Key fields | Constraints and indexes |
|---|---|---|
| Workspace | id, slug, name, mode AppMode, planLabel String, timezone default `Asia/Kolkata`, status, automationPaused Bool, automationPauseReason String?, createdAt | slug UNIQUE |
| WorkspaceSettings | workspaceId (PK/FK), autoSendEnabled Bool=false, emailB2bAttestationEnabled Bool=false (M2), emailFallbackEnabled Bool=false, taxLabel String?, taxBps Int?, taxMode [NONE, CONFIGURED] (explicit), maxDiscountBps Int, quoteValidityDays Int=15, gstin String?, brandColor, logoPath?, termsText, bookingUrl String? (https only, P4), internalWaDailyCap Int?, internalEmailDailyCap Int?, currencyDisplay fixed INR, updatedAt, updatedBy | 1:1 |
| SystemSetting | id=1, outboundPaused Bool, outboundPausedAt, outboundPausedBy, outboundPauseReason | singleton. Worker also honors `STORAGE_DIR/outbound.lock` and `OUTBOUND_PAUSED=1` (O1) |
| User | id, email (lowercased), name, globalRole, status, passwordHash?, isDemo Bool, failedLoginCount Int, lockedUntil?, createdAt, lastLoginAt | email UNIQUE |
| Session | id, userId, tokenHash, activeWorkspaceId?, mode AppMode, createdAt, lastSeenAt, idleExpiresAt, absoluteExpiresAt, ipHash, userAgent, revokedAt?, reauthAt? | tokenHash UNIQUE; (userId, revokedAt) |
| Invite | id, email, tokenHash, globalRole, workspaceId?, membershipRole?, createdBy, expiresAt (72 h), redeemedAt? | tokenHash UNIQUE |
| Membership | id, userId, workspaceId, role MembershipRole, createdAt | (userId, workspaceId) UNIQUE; (workspaceId) |
| EmployeeAssignment | id, employeeUserId, workspaceId, capabilities Json (string[] of Capability), maxDiscountBps Int?, active Bool, createdBy, createdAt | (employeeUserId, workspaceId) UNIQUE; (workspaceId, active) |
| TestClock | id=1, offsetMs BigInt, frozenAt? | exists in every DB; read only when DEMO + test-control flag + token (A40) |

Capabilities (`src/lib/domain/enums.ts`): `leads.read`, `leads.write`, `leads.export`, `drafts.generate`, `quotes.edit`, `pricing.override`, `approvals.decide`, `dispatch.send`, `automation.manage`, `integrations.manage`, `campaigns.control`, `extension.manage`, `sheets.manage`, `scoring.manage`, `pipeline.manage`. Workspace OWNER holds all within own workspace. Super admin acts on tenant data only through `adminContext` (audited).

### 5.3 Leads and ingestion

| Model | Key fields | Constraints and indexes |
|---|---|---|
| Lead | id, workspaceId, displayName, nameNormalized, category?, phoneE164?, phoneRaw?, alternatePhones Json, emailNormalized?, website?, websiteStatus, address?, city?, rating Decimal-as-Int (x10)?, reviewCount?, salesStage, stageVersion Int, score Int?, scoreReasons Json, unknownInputs Json, scoreConfigVersionId?, pipelineConfigVersionId (pinned at ingestion, O5), firstSource LeadSource, simulated Bool, mergedIntoLeadId?, createdAt, updatedAt | (workspaceId, salesStage, createdAt); (workspaceId, score); (workspaceId, nameNormalized); (workspaceId, phoneE164); (workspaceId, emailNormalized); (workspaceId, createdAt, id) for keyset |
| LeadContactKey | id, workspaceId, leadId, kind ContactKeyKind, value (E.164, normalized email, or `source:providerId`) | (workspaceId, kind, value) UNIQUE (G-NORM-1); (leadId) |
| LeadSourceRecord | id, workspaceId, leadId?, importBatchId?, source, externalId (leadgen_id, sheet event id, extension sourceRef), status SourceRecordStatus, reasonCode?, rawPayloadRedacted Json, mappingVersion?, attribution Json (ad, form, campaign, sheet, keyword), extractedAt?, receivedAt | (workspaceId, source, externalId) UNIQUE; (importBatchId); (leadId) |
| ImportBatch | id, workspaceId, source, externalBatchId (extension batchId, sheet sync run id), extensionTokenId?, bodyHash, status, counts Json {received, accepted, duplicate, review, rejected}, simulated Bool, createdAt, completedAt? | (workspaceId, source, externalBatchId) UNIQUE |
| MergeReview | id, workspaceId, sourceRecordId, candidateLeadIds Json, status, resolvedBy?, resolvedAt?, resolution Json? | (workspaceId, status, createdAt) |
| ConsentRecord | id, workspaceId, leadId, contactKey (HMAC, same as Suppression), channel, purpose, basis, source, evidence Json {formId, responseId, questionKey, messageId, attestedBy, note}, noticeTextHash?, noticeVersion?, collectedAt (evidence time, provider or form submission time), recordedAt, recordedBy?, withdrawnAt?, withdrawalMethod? | (workspaceId, leadId, channel, collectedAt); (workspaceId, contactKey, channel) |
| Suppression | id, workspaceId, channel, contactKey = HMAC-SHA256(SUPPRESSION_PEPPER, normalized contact) (C17), contactPlain? (nulled on lead erasure), reason, sourceEventId?, createdAt, clearedAt?, clearedByConsentId?, journaledAt?, clearJournaledAt? (E8) | Append-only history (E3, ADR-37): PARTIAL UNIQUE (workspaceId, channel, contactKey) WHERE clearedAt IS NULL (at most one active row); index (workspaceId, channel, contactKey, createdAt). A Stop while a row is active is a no-op plus audit; a Stop after a clear inserts a new active row. Survives lead merge and deletion |
| ScoringConfigVersion | id, workspaceId, version Int, weights Json (Zod-validated), active Bool, createdBy, createdAt | (workspaceId, version) UNIQUE; PARTIAL UNIQUE (workspaceId) WHERE active |
| SheetMapping | id, workspaceId, integrationId, version Int, headerFingerprint, fieldMap Json, consentMapping Json? {column, truthyValues[], channel, purpose, noticeText, noticeTextHash} (P1), active Bool | (integrationId, version) UNIQUE |
| MetaFormMapping | id, workspaceId, integrationId, formId, fieldMap Json, consentMapping Json? (P1) | (integrationId, formId) UNIQUE |

### 5.4 Pricing and quotes

| Model | Key fields | Constraints and indexes |
|---|---|---|
| Service | id, workspaceId, code, name, description, unitLabel, defaultTimelineDays?, maxDiscountBps Int?, archivedAt? | (workspaceId, code) UNIQUE |
| PricingVersion | id, workspaceId, version Int, active Bool, note, createdBy, createdAt | (workspaceId, version) UNIQUE; PARTIAL UNIQUE (workspaceId) WHERE active |
| PriceEntry | id, workspaceId, pricingVersionId, serviceId, unitPricePaise BigInt, minQty Int=1, maxQty Int=10000 | (pricingVersionId, serviceId) UNIQUE; (workspaceId); composite FKs to PricingVersion and Service on (workspaceId, id) where supported |
| Quote | id, workspaceId, leadId, number (Q-0001 per workspace), status QuoteStatus, currentVersionId, currentVersionNo Int, needsPricingReview Bool, sentVia [DISPATCH, MANUAL_LINK]?, validUntil (copy of current version), acceptedVersionId?, createdBy, createdAt, updatedAt | (workspaceId, number) UNIQUE; (workspaceId, status, updatedAt); (leadId) |
| QuoteVersion | id, workspaceId, quoteId, versionNo, pricingVersionId, snapshot Json (service names, unit prices, rules, branding refs), scopeText, timelineText, discountKind, discountValue BigInt (bps or paise), taxLabel, taxBps, subtotalPaise, discountPaise, taxablePaise, taxPaise, totalPaise (all BigInt, persisted, never recomputed at render), validUntil, sentAt? (set by dispatch settle even when the version is superseded, E6), aiPolicyFlags Json, reviewReasons Json, createdBy, createdAt | (quoteId, versionNo) UNIQUE |
| QuoteItem | id, workspaceId, quoteVersionId, serviceId, serviceNameSnapshot, unitLabel, qty Int, unitPricePaise BigInt, lineTotalPaise BigInt, position Int | (quoteVersionId, position) UNIQUE; (workspaceId); serviceId validated by assertSameWorkspace |
| QuoteShare | id, workspaceId, quoteId, quoteVersionId, tokenHash (sha256 of 32 random bytes base64url, C2), expiresAt (<= validUntil, P16), revokedAt?, supersededAt?, createdBy, createdAt | tokenHash UNIQUE; (quoteVersionId) |
| QuoteViewEvent | id, workspaceId, quoteShareId, quoteVersionId, kind QuoteViewKind, uaClass [browser, link_preview, bot, unknown], ipHash, createdAt | (quoteShareId, createdAt) |
| QuoteAcceptance | id, workspaceId, quoteId, quoteVersionId, acceptorName, ipHash, userAgent, acceptedAt | quoteVersionId UNIQUE (idempotent accept) |
| QuoteArtifact | id, workspaceId, quoteVersionId, path (under STORAGE_DIR), sha256, bytes Int, renderedAt | quoteVersionId UNIQUE |
| Approval | id, workspaceId, kind, status, quoteId?, quoteVersionId?, messageId?, payloadHash? (O3: sha256 of canonical JSON {channel, destinationKey, templateName, templateLang, variables, body, subject, attachment {quoteVersionId, artifactSha256}}), flags Json (customer_requested, ai_price_ignored, ...), requestedAt, decidedBy?, decidedAt?, invalidatedAt?, invalidationReason? | (workspaceId, status, requestedAt); PARTIAL UNIQUE (quoteVersionId) WHERE kind='QUOTE_VERSION' AND status='APPROVED'; PARTIAL UNIQUE (messageId) WHERE status IN ('PENDING','APPROVED') |

### 5.5 Messaging

| Model | Key fields | Constraints and indexes |
|---|---|---|
| Conversation | id, workspaceId, leadId, channel, contactKey, aiMode ConversationAiMode=DRAFT, humanTakeover Bool, modeVersion Int, lastInboundProviderAt? (monotone max, C19), lastInboundMessageId?, unansweredOutboundCount Int (12.3), emailThreadToken? (P5), createdAt | (workspaceId, lastInboundProviderAt); (workspaceId, leadId, channel); PARTIAL UNIQUE (workspaceId, leadId, channel) WHERE open |
| Message | id, workspaceId, conversationId, direction, kind [TEXT, TEMPLATE, DOCUMENT, EMAIL, INTERACTIVE_REPLY], body?, subject?, templateId?, variables Json?, quoteVersionId?, status MessageStatus (projection), statusRank Int, providerMessageId?, providerTs?, generatorLabel? (anthropic, openai, local-deterministic, human), simulated Bool, replyToInboundId?, modeVersionAtCreate?, sendIntent SendIntent? (outbound only, E4), initiatedBy (userId or `system:<jobType>`)?, createdBy?, createdAt | (provider, providerMessageId) UNIQUE where not null; (conversationId, createdAt) |
| MessageStatusEvent | id, workspaceId, messageId?, providerMessageId, status (raw), rank, providerTs, errorCode?, anomaly Bool, receivedAt | (providerMessageId, status) UNIQUE |
| DispatchAttempt | id, workspaceId, messageId, quoteVersionId?, approvalId?, channel, attemptNo, state DispatchState, sendIntent SendIntent (copied from Message, immutable, E4), initiatedBy, failureClass DispatchFailureClass? (E7), idempotencyKey, jobId, providerMessageId?, reasonCode?, errorRedacted?, resolvedBy?, resolvedAt?, resolutionNote?, createdAt, updatedAt | idempotencyKey UNIQUE; (messageId, attemptNo) UNIQUE; (workspaceId, state); (jobId) |
| CallRequest | id, workspaceId, leadId, conversationId?, source, status, requestedAt, handledBy?, handledAt?, sourceEventId? | (workspaceId, status, requestedAt); sourceEventId UNIQUE (replay creates 0) |
| WhatsAppTemplate | id, workspaceId, integrationId, name, language, category (raw), status (raw), components Json, variableSchema Json, intent [FIRST_TOUCH, QUOTE_READY, FOLLOW_UP, CALL_ACK]?, variableMap Json, categoryHistory Json, syncedAt | (integrationId, name, language) UNIQUE |

### 5.6 Campaigns, integrations, extension

| Model | Key fields | Constraints and indexes |
|---|---|---|
| Campaign | id, workspaceId, integrationId?, providerCampaignId, name, currency (ad account, P6), configuredStatus (raw), effectiveStatus (raw), lastSyncedAt?, simulated Bool | (workspaceId, providerCampaignId) UNIQUE |
| CampaignMetricSnapshot | id, workspaceId, campaignId, dateStart, dateStop, spendMinor BigInt (ad-account currency minor units), leads Int, cplMinor BigInt?, attributionSetting?, asOf | (campaignId, dateStart, dateStop) UNIQUE |
| CampaignAction | id, workspaceId, campaignId, targetStatus, state CampaignActionState, providerResultRedacted?, requestedBy, idempotencyKey, createdAt, resolvedAt? | idempotencyKey UNIQUE |
| Integration | id, workspaceId, kind, status IntegrationStatus, config Json (non-secret: phoneNumberId, wabaId, businessPortfolioId, pageId, adAccountId, sheetId, fromDomain, modelId), secrets (ciphertext `v1.<kid>.<nonce>.<ct>.<tag>`, AAD `workspaceId|integrationId|field`, A33), secretLast4 Json, lastCheckedAt?, lastErrorCode?, lastErrorRedacted?, qualityRaw?, messagingLimitRaw?, limitsCheckedAt?, verifiedAt? | (workspaceId, kind) UNIQUE; config lookup columns `routingKey` (phone_number_id or page_id) UNIQUE where not null |
| ExtensionToken | id, workspaceId, name, prefix (`alx_<keyId>`), secretHash (sha256), scopes Json=['ingest:gmaps'], allowedExtensionId?, createdBy, createdAt, lastUsedAt?, expiresAt?, revokedAt? | prefix UNIQUE |
| WebhookEvent | id, workspaceId?, provider, integrationId?, scopeKey (routed integrationId, else authenticated workspaceId, else `unrouted`; E2), externalKey (leadgen `meta:{page}:{leadgen}`, `wa:{msgId}`, `wa:{wamid}:{status}`, svix-id, sheets eventId, extension batchId), bodySha256, payloadRedacted Json (inspector view), processingPayload String? (AES-256-GCM ciphertext of the parsed body, credentials key ring, AAD = webhookEventId; E1), processingPurgedAt?, status, attempts Int, result Json? (stored per-record results for replay), simulated Bool, receivedAt, processedAt? | (provider, scopeKey, externalKey) UNIQUE; (status, receivedAt); (workspaceId, receivedAt); (processingPurgedAt, processedAt) |
| WebhookRejection | id, workspaceId?, provider, reason, day (date), count Int | (provider, workspaceId, reason, day) UNIQUE (written on rejection only) |

### 5.7 Jobs, audit, pipeline

| Model | Key fields | Constraints and indexes |
|---|---|---|
| Job | id, workspaceId? (null only for system jobs), type, payload Json, payloadVersion Int, status JobStatus, priority Int, runAt, attempts Int, maxAttempts Int, claimToken?, leaseUntil?, startedAt?, finishedAt?, serialKey?, idempotencyKey, cancelRequestedAt?, deadReason?, lastErrorCode?, lastErrorRedacted?, retrySafe Bool, correlationId, causationId?, createdAt, updatedAt | idempotencyKey UNIQUE; (status, runAt, priority); (workspaceId, status); (serialKey, status) |
| JobAttempt | id, workspaceId? (copied from Job), jobId, attemptNo, startedAt, finishedAt?, outcome, errorCode?, errorRedacted?, providerHttpStatus?, providerRequestId?, durationMs?, correlationId | (jobId, attemptNo) UNIQUE |
| WorkerHeartbeat | workerId (PK), pid, hostname, version, mode, startedAt, lastBeatAt, currentJobId? | |
| AuditEvent | id, workspaceId?, actorUserId?, actorKind [USER, EMPLOYEE, SUPER_ADMIN, SYSTEM, WORKER, WEBHOOK, PUBLIC], action (e.g. `quote.approve`), targetType, targetId, result AuditResult, summary Json (redacted field names, never PII values), crossWorkspace Bool, reason?, correlationId, simulated Bool, createdAt | (workspaceId, createdAt); (actorUserId, createdAt); (targetType, targetId); (action, createdAt) |
| PipelineConfigVersion | id, workspaceId, version Int, graph Json (5 fixed stage kinds, DAG order), approvalMode PipelineApprovalMode, active Bool, createdBy, createdAt | (workspaceId, version) UNIQUE; PARTIAL UNIQUE (workspaceId) WHERE active |
| PipelineExecution | id, workspaceId, leadId, pipelineConfigVersionId (pinned, O5), currentStage PipelineStage, updatedAt | leadId UNIQUE |
| PipelineStageRun | id, workspaceId, executionId, stage PipelineStage, status StageRunStatus, outputRef Json? (e.g. scoreVersion, draft messageId, quoteId, approvalId, dispatchAttemptId), jobId?, startedAt?, finishedAt?, reasonCode? | (executionId, stage) UNIQUE (E9 idempotency); (workspaceId, status) |

SuppressionJournal (E8, ADR-38) is a file, not a table: `<DATA_DIR>/<mode>/journal/suppressions-YYYYMMDD.jsonl`, one JSON line per event `{ journalId, workspaceId, contactKey, channel, action: STOP|CLEAR, reason, createdAt, sourceEventId, suppressionId, consentId? }`, appended with fsync by `messaging/suppression-journal.ts` after the Suppression transaction commits. Each Suppression row carries `journaledAt?`; if the append fails, `journaledAt` stays null and the `suppression.journalReconcile` job re-exports unjournaled rows from the DB (idempotent by `journalId`). The journal lives outside the DB file and is never replaced by a restore.

### 5.8 SQLite to PostgreSQL differences (for `docs/deployment.md`, T37)

| Area | SQLite (now) | PostgreSQL (later) |
|---|---|---|
| Provider literal | `prisma/schema.prisma` provider sqlite; one migrations folder per provider | `scripts/gen-pg-schema.ts` emits `prisma/postgres/schema.prisma` + `@db.*` annotations; new baseline migration at cutover; `@prisma/adapter-pg` 7.10.0 |
| Money | `BigInt` = INTEGER (64-bit) | `BigInt` = int8. No change needed (C11). |
| Enums | TEXT | native enums; new values need their own migration |
| JSON | TEXT | jsonb; rule "never filter on JSON" keeps parity |
| DateTime | adapter storage format (verified in T02) | timestamptz(3); raw SQL binds `Date` parameters only |
| Case-insensitive search | normalized columns (`nameNormalized`) | same columns; optional pg_trgm later |
| Partial unique indexes | hand SQL in migrations | same SQL, re-added in the PG baseline |
| Job claim | single `UPDATE ... RETURNING` | same, plus optional `FOR UPDATE SKIP LOCKED` in the subquery; dialect switch only in `db/raw/claim-job.ts` |
| Identifiers | case-insensitive | raw SQL always quotes `"Job"` |
| Rate limiter | in-process (single instance) | shared store (PG or Redis) required for more than one instance |
| Storage | local FS under STORAGE_DIR | object storage behind `adapters/storage` port |
| Data migration | n/a | `scripts/migrate-sqlite-to-pg.ts`: FK order, 1,000-row batches, string IDs preserved, row counts and `SUM(totalPaise)` per workspace verified; cutover under global outbound pause |

---

## 6. State machines

### 6.1 Quote (`services/quotes/state-machine.ts`, exhaustive 7x7 table test)

| From | To | Trigger | Guard / side effects |
|---|---|---|---|
| (new) | DRAFT | create (from proposal or manual) | v1 created; totals computed and persisted |
| DRAFT | DRAFT | edit | new version N+1 |
| DRAFT | APPROVED | approve(expectedVersion) | CAS on `currentVersionNo = expected AND status = DRAFT`; `needsPricingReview = false`; `validUntil > now`; Approval row with payloadHash where a message is attached |
| APPROVED | DRAFT | material edit (items, qty, price, discount, tax, scope, timeline, validity) | in one tx: version N+1, Approval INVALIDATED, QUEUED DispatchAttempts CANCELLED(`SUPERSEDED`), shares superseded |
| APPROVED | SENT | dispatch settled, or "Copy link" / "Mark as sent manually" (P15, `sentVia = MANUAL_LINK`) | settle CAS requires `currentVersionId = attempt.quoteVersionId AND status = APPROVED`; a send settling for a superseded version sets only that `QuoteVersion.sentAt` and leaves the Quote unchanged (E6); creating a share link alone does not transition |
| SENT | VIEWED | beacon POST after 2 s visible, non-preview UA (C4) | label "Opened (may be automated)" |
| SENT, VIEWED | ACCEPTED | accept POST (C5) on current version, `now < validUntil` | QuoteAcceptance UNIQUE(versionId); lead stage CONVERTED (forward-only); repeat returns same receipt |
| SENT, VIEWED | DRAFT | revise | version N+1; old shares superseded (410) |
| APPROVED, SENT, VIEWED | EXPIRED | `now >= validUntil` | sweeper job + lazy check on read and accept |
| EXPIRED | DRAFT | revise and reissue | new version, new validUntil |
| DRAFT, APPROVED, SENT, VIEWED | CANCELLED | cancel | shares revoked (404, C3) |

Invalid (throws `InvalidTransitionError`, route 409, audited): any transition out of ACCEPTED or CANCELLED, DRAFT to SENT/VIEWED/ACCEPTED, APPROVED to VIEWED (a beacon on APPROVED records an event plus the hint "Mark as sent?"), VIEWED to SENT, EXPIRED to ACCEPTED, accept on a non-current version, approve with a stale expectedVersion.

### 6.2 Job (C7)

| From | To | Trigger |
|---|---|---|
| (new) | QUEUED | enqueue (idempotencyKey UNIQUE; duplicate enqueue returns existing) |
| QUEUED | RUNNING | claim statement |
| QUEUED | CANCELLED | operator cancel; Stop tx; takeover; material edit; superseded |
| RUNNING | SUCCEEDED | settle with matching claimToken |
| RUNNING | QUEUED | retryable failure with attempts < max (runAt = now + backoff); deferral (attempt refunded); reaper with no SENDING attempt |
| RUNNING | DEAD | max attempts; fatal error; reaper with a SENDING attempt (`deadReason = AMBIGUOUS`) |
| RUNNING | CANCELLED | `cancelRequestedAt` observed between steps before any SENDING write |
| DEAD | QUEUED | operator safe retry (only when `retrySafe` or the linked attempt was resolved by an operator); audited |

Invalid: SUCCEEDED or CANCELLED to anything; any automatic transition out of DEAD.

### 6.3 DispatchAttempt (C7, C8)

| From | To | Trigger |
|---|---|---|
| (new) | QUEUED | approve-and-send tx, auto-send policy, retry after a PRE_SEND or RETRYABLE failure (attempt N+1); `sendIntent` and `initiatedBy` persisted at creation (E4) |
| QUEUED | QUEUED | deferral: pause, provider throttle, internal cap (job runAt moves) |
| QUEUED | SENDING | preflight passed, committed before the provider call |
| QUEUED | SKIPPED | preflight failed: `SUPPRESSED`, `NO_WHATSAPP_OPT_IN`, `NO_EMAIL_BASIS`, `ATTESTED_MANUAL_ONLY`, `AUTO_SEND_DISABLED`, `HUMAN_TAKEOVER`, `APPROVAL_STALE`, `WINDOW_CLOSED`, `TEMPLATE_NOT_APPROVED`, `QUALITY_PAUSED` |
| QUEUED | CANCELLED | Stop or unsubscribe tx; material edit; operator |
| SENDING | SENT | provider 2xx with providerMessageId |
| SENDING | FAILED(PERMANENT) | non-retryable 4xx (reason from `error-map.ts`); job settles, item back to review where applicable |
| SENDING | FAILED(RETRYABLE) | definite safe-to-repeat rejection: HTTP 429, 5xx with no-write evidence per the error map, SMTP 4xx (E7); job requeued with backoff and `Retry-After`; attempt N+1 created on retry and re-runs preflight |
| SENDING | FAILED(PRE_SEND) | definite failure before the request was written (DNS, connect refused, TLS); job requeued; attempt N+1 re-runs preflight |
| SENDING | AMBIGUOUS | timeout or reset after write; reaper with expired lease (C8) |
| AMBIGUOUS | SENT | matching status webhook (positive evidence) or operator "Mark delivered" |
| AMBIGUOUS | FAILED | operator "Verified not delivered" (typed reason); optional requeue creates attempt N+1 through full preflight |

Invalid: SENT, FAILED, SKIPPED, CANCELLED to anything (a retry is always a new attempt row, never a transition of the old one); AMBIGUOUS to QUEUED or SENDING automatically (no blind resend). Every transition after QUEUED is written in a claimToken-fenced transaction (E5). `131049` maps to FAILED(`RECIPIENT_FREQUENCY_CAP`), back to review, manual retry allowed only after 24 h (C16). `131026` maps to FAILED(`UNDELIVERABLE`), no retry, no suppression. All provider codes live in `adapters/whatsapp/error-map.ts` with a check date and are UNVERIFIED until checked (12.3).

### 6.4 Message delivery rank (C10)

| Incoming | Current rank | Result |
|---|---|---|
| sent (1), delivered (2), read (3) | lower than incoming | apply; `statusRank = incoming` |
| sent, delivered, read | equal or higher | no state change; event stored |
| read before delivered | any lower | READ; `deliveredAt` null, shown "implied" |
| failed | <= sent (1) | FAILED |
| failed | >= delivered (2) | no state change; event stored with `anomaly = true`; inspector flag |
| any, unknown providerMessageId | n/a | WebhookEvent `PENDING_CORRELATION`, `status.apply` retried with backoff 5 times over 10 min, then `ORPHAN` |

Every raw event is appended to `MessageStatusEvent` (UNIQUE providerMessageId+status). Apply is `UPDATE ... WHERE providerMessageId = ? AND statusRank < ?`.

---

## 7. Eligibility contract (A10, one function)

```ts
// src/server/services/messaging/eligibility.ts
export type DispatchKind = 'WA_TEMPLATE' | 'WA_FREEFORM' | 'EMAIL';
export type EligibilityInput = {
  kind: DispatchKind;
  sendIntent: SendIntent;                     // persisted on Message/DispatchAttempt at creation (E4); never inferred
  globalPaused: boolean; workspaceAutomationPaused: boolean; qualityPaused: boolean;
  pipelineApprovalMode: 'HUMAN' | 'POLICY_AUTO';   // of the lead's pinned PipelineConfigVersion
  suppression: { channel: Channel; createdAt: Date } | null;   // the ACTIVE row (clearedAt IS NULL), E3
  consents: Array<{ channel; purpose; basis; collectedAt: Date; withdrawnAt: Date | null }>;
  conversation: { humanTakeover: boolean; modeVersion: number; lastInboundProviderAt: Date | null } | null;
  expectedModeVersion?: number;               // automated replies
  template?: { statusRaw: string; approved: boolean; category: string } | null;
  emailAddressValid: boolean; integrationReady: boolean;
  workspace: { emailB2bAttestationEnabled: boolean; autoSendEnabled: boolean };
  internalCapRemaining: number | null;
};
export type EligibilityResult = {
  eligible: boolean; deferrable: boolean; mode: 'template' | 'freeform' | 'email' | 'none';
  reasons: ReasonCode[]; windowEndsAt: Date | null;
};
export function evaluateDispatchEligibility(input: EligibilityInput, clock: Clock): EligibilityResult;
export function loadEligibilityInput(tx, ctx, { leadId, channel, kind, conversationId }): Promise<EligibilityInput>;
```

The same function backs the bulk pre-flight counts, the approval queue badge, the composer eligibility line and the dispatch preflight (which re-runs it inside the preflight transaction with the attempt's persisted `sendIntent`, E4). UI code never computes eligibility. "Automated" below means `sendIntent = AUTOMATED`; "bulk" means `sendIntent = BULK`. `CUSTOMER_REQUESTED_REPLY` (a reply to a QUOTE or CALL quick reply, P3, P4) counts as automated when it is sent without a human approval. Check order and reason codes:

1. `GLOBAL_PAUSED` (deferrable). 2. `WORKSPACE_PAUSED` (automated only, deferrable). 2a. `AUTO_SEND_DISABLED` (E4, ADR-45): an automated attempt is skipped when `autoSendEnabled` is now false, or when the attempt was created by a POLICY_AUTO approval node and the pinned pipeline's approval mode is no longer POLICY_AUTO; it is evaluated at dispatch, so disabling auto-send stops already queued automated work. 3. `SUPPRESSED`. 4. Consent: WA template needs an un-withdrawn `OPT_IN` consent on WHATSAPP with purpose MARKETING (`NO_WHATSAPP_OPT_IN`); WA free-form needs any WHATSAPP consent including `INBOUND_MESSAGE` (P13) plus an open window; EMAIL rules below. 5. `HUMAN_TAKEOVER` or `MODE_CHANGED` (automated only). 6. `QUALITY_PAUSED` (automated WA only; manual approved sends pass, A15). 7. Template: `TEMPLATE_NOT_APPROVED`; free-form: `WINDOW_CLOSED`. 8. `NOT_CONFIGURED` (LIVE integration not CONNECTED). 9. `CAP_REACHED` (deferrable, labelled "Internal cap, not a provider limit").

WhatsApp window (C19, A13): `windowOpen(now) = lastInboundProviderAt != null && now < lastInboundProviderAt + 24h` (strict, safety margin 0). `lastInboundProviderAt` is updated only as `max(existing, inbound.providerTs)` from valid inbound messages (text, media, interactive or button reply including quick replies). Template sends, status webhooks, quote link opens, echoes and outbound free-form never touch it. Provider `131047` is the rescue path: FAILED(`WINDOW_CLOSED`), item back to review or to an eligible template draft, never resent as free-form.

Email eligibility (M2, ADR-14): requires a valid address, no EMAIL suppression, a CONNECTED email integration in LIVE, and a basis:
- `OPT_IN` email consent: manual, bulk and automated sends allowed (automated still passes check 2a).
- `B2B_ATTESTED` (employee attestation with actor, time, note; only when `emailB2bAttestationEnabled`, default false): manual single send only. Rejected with `ATTESTED_MANUAL_ONLY` unless `sendIntent = MANUAL_SINGLE`. Never a fallback target.
- WhatsApp consent never counts (`NO_EMAIL_BASIS`).
- Every marketing-type email carries a signed unsubscribe link (`/unsubscribe/[token]`, `List-Unsubscribe` and `List-Unsubscribe-Post` headers). Unsubscribe is synchronous (C9).

WhatsApp throttling defers by default. Email fallback runs only when `emailFallbackEnabled` and the email side is independently eligible for an automated send (so attested B2B never qualifies).

Consent capture at ingestion (P1, ADR-15): a Sheets mapping or Meta form mapping may define a consent field (column or question key, truthy values, verbatim notice text whose sha256 is stored). A truthy value creates `ConsentRecord(channel, purpose, basis=OPT_IN, source=SHEETS_FORM|META_FORM, evidence={formId, responseId, questionKey}, noticeTextHash, collectedAt=submission time)`. No mapping, a falsy value or a missing column creates nothing. Maps extension leads never get WhatsApp consent. Manual grants require purpose, source and evidence timestamp (Zod) and cannot use the Maps source. Inbound WhatsApp creates `INBOUND_MESSAGE` / `SERVICE_CONVERSATION` consent only (P13).

Re-opt-in after Stop (O2, E3, ADR-15, ADR-37): the active suppression is cleared only by a new `OPT_IN` ConsentRecord whose `collectedAt` is strictly newer than the latest Stop for that contact and channel (the newest Suppression row's `createdAt`, active or cleared). Backfilled, delayed or undated evidence never clears it. A `START` keyword inbound with providerTs after the latest Stop creates such a record. Clearing sets `clearedAt` and `clearedByConsentId` on the active row, writes an AuditEvent and a `CLEAR` journal entry (E8); rows are never deleted. A later Stop inserts a new active row, so Stop, START, Stop, then a delayed consent older than the second Stop stays suppressed.

Suppression writes (Stop, unsubscribe, bounce, complaint, 131050, manual, clear) all go through `messaging/suppression.ts`, which commits the row and then appends the SuppressionJournal entry (section 5.7, E8). No other code writes Suppression rows.

---

## 8. Quote math contract (A1, AT5)

Module `src/lib/money.ts` (pure, `bigint` only, no floats):

```
lineTotal   = qty * unitPricePaise                       exact
subtotal    = sum(lineTotal)
discount    = PERCENT_BPS: mulDivHalfUp(subtotal, bps)   FLAT_PAISE: value (must be <= subtotal)
taxable     = subtotal - discount
tax         = mulDivHalfUp(taxable, taxBps)              taxMode NONE -> 0 (explicit setting required)
total       = taxable + tax
mulDivHalfUp(a, bps) = (a * bps + 5000n) / 10000n        (a >= 0, floor division; half-up at paise)
```

Each derived amount is rounded once. Discount is document-level on the subtotal; tax is on the discounted subtotal; one configured tax line ("Quotation, not a tax invoice", P8).

AT5 fixture (`tests/unit/money/quote-math.test.ts`, every intermediate asserted):

| Step | Paise |
|---|---|
| 2 x 1,000,000 | 2,000,000 |
| subtotal | 2,000,000 |
| discount 10% (1000 bps) | 200,000 |
| taxable | 1,800,000 |
| tax 18% (1800 bps) | 324,000 |
| total | 2,124,000 (`formatINR` gives `₹21,240.00`) |

Rounding cases (`rounding.test.ts`): taxable 25 at 1800 bps gives 5 (banker's would give 4); subtotal 5 at 1000 bps gives 1; 75 at 1800 gives 14; 333 at 1800 gives 60; qty 9,999 x 99,999,999 exact. Property test (fast-check, fixed seed, 500 runs): `total == subtotal - discount + tax`, all non-negative integers, line order independent.

Discount limits (`discount-limits.test.ts`): effective limit = min(`WorkspaceSettings.maxDiscountBps`, `Service.maxDiscountBps` of every line that sets one). At the limit: accepted. Limit + 1 bp by a human: 422 `DISCOUNT_OVER_LIMIT`. Above the actor's own cap (`EmployeeAssignment.maxDiscountBps`, no `pricing.override`): 403 plus audit `result=DENIED`. Negative, above 10000 bps, or flat above subtotal: 422. Sanity cap: total above ₹100 crore (10^11 paise, configurable) routes to review.

AI (C12): the proposal schema contains only service IDs, quantities, scope and timeline. Keys named like price, discount or tax are stripped before validation, `aiPolicyFlags += ai_price_ignored` (or `ai_tax_ignored`, `ai_discount_ignored`), an AuditEvent is written, the draft is forced to review, the server price is used. Unknown service IDs are dropped into `reviewReasons` (never fuzzy-matched); a missing active price sets `needsPricingReview`.

`formatINR` uses `Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })` (Indian grouping `₹1,23,456.00`). Web fonts load `latin` + `latin-ext` (U+20B9). The PDF embeds Inter TTF with U+20B9.

---

## 9. Security contract summary (see `reviews/ceo/03-security.md` T1-T19 for detail)

| Area | Contract |
|---|---|
| Auth (A31, ADR-11) | Own email + password. argon2id via `@node-rs/argon2` (m=19456 KiB, t=2, p=1). DB sessions: 32-byte token, only sha256 stored. Cookie `__Host-aura_session` (HttpOnly, Secure, SameSite=Lax, Path=/); `AUTH_COOKIE_INSECURE_DEV=1` fallback name for non-localhost dev hosts. Rotate on login and privilege change. Idle 7 d, absolute 30 d; super admin 12 h plus re-auth within 15 min for global pause and elevated drilldown. Role, membership or status change revokes all sessions. Generic errors, dummy-hash timing. Lockout persisted on `User` (C6). Invite tokens hashed, 72 h. MFA is a stated limitation. |
| Demo isolation (T2) | `/api/demo/session` 404 in LIVE; personas from a fixed server enum; LIVE session loader rejects `isDemo` users and DEMO-mode sessions; seed refuses a LIVE DB. |
| Tenant isolation (T1, A6) | ctx-first services; `scoped.ts` Prisma extension injects `workspaceId` on tenant models and throws on unscoped access; `findUnique({ where: { id } })` on tenant models is a lint error; 404 across tenants; `adminContext` audits before reading. Every tenant table carries `workspaceId`; `assertSameWorkspace` validates every referenced id in mutation bodies inside the tx (E10). Generated tenant matrix over `routes.manifest.ts` x 4 actors, plus foreign ids of workspace B injected into mutation bodies (serviceId, quoteId, leadId, conversationId) expecting 404/422. |
| CSRF (A32) | Cookie-authenticated non-GET handlers require `Origin` (or `Referer`) equal to `APP_ORIGIN` and `X-CSRF-Token` = HMAC(SESSION_SECRET, sessionId) served in a meta tag. Webhook, extension and public quote routes ignore cookies. Public accept (C5): token in body + `formNonce = HMAC(SHARE_NONCE_KEY, tokenHash || versionId)` + Origin = APP_ORIGIN + `expectedVersionId`. |
| Webhooks (A34, C14) | Body read once via `Buffer.from(await req.arrayBuffer())` (never `req.text()` or `req.json()` first), capped by Content-Length and streaming counter: Meta and WhatsApp 1 MB, Sheets 256 KB / 50 rows, extension 200 records / 1 MB. Meta/WA: `X-Hub-Signature-256` HMAC over raw bytes with `timingSafeEqual`; GET verify token compared in constant time, challenge echoed only if `^[0-9A-Za-z_-]{1,128}$`. Routing by `phone_number_id` / `page_id` via `Integration.routingKey`, never payload trust; unrouted stored as UNROUTED. Sheets: `HMAC(secret, ts + "." + eventId + "." + body)`, +/- 300 s. Resend: Svix-style signature verified manually against current docs (UNVERIFIED until T33). Rejections increment `WebhookRejection`, never persist the body. Accepted events store a redacted inspector payload plus an encrypted processing payload (AAD = webhookEventId) purged after processing and retention (E1); idempotency is unique per `(provider, scopeKey, externalKey)` so identical ids from two workspaces never collide (E2). |
| Extension (T8, C18) | Token `alx_<keyId>_<secret>`, secret 32 bytes, only sha256 stored, shown once, `ingest:gmaps` scope, one workspace, revocation effective on the next request. Bearer only. `http(s)` Origin gets 403; CORS answered only for `chrome-extension://<allowedExtensionId>`. `(workspaceId, source, batchId)` UNIQUE; replay returns the stored per-record result; same batchId with a different body hash: 409 `BATCH_CONTENT_MISMATCH`. |
| Credentials (A33, ADR-25) | AES-256-GCM, 12-byte nonce, key ring `CREDENTIALS_KEYRING` + `CREDENTIALS_ACTIVE_KID`, AAD `workspaceId|integrationId|field`. Masked reads (last 4 + updatedAt), no reveal endpoint. `npm run creds:rotate`. LIVE refuses boot without keys; `npm run setup` generates demo keys into `.env` (E12). The same key ring encrypts `WebhookEvent.processingPayload` (E1). |
| SSRF (A36) | `safeFetch` in the worker only: http/https, ports 80/443, no userinfo, WHATWG canonical host, `dns.lookup({ all: true })` with every address public unicast (ipaddr.js, mapped v4 unwrapped), undici Agent `connect.lookup` pins the validated IP, `redirect: 'manual'` max 3 hops each re-validated, 5 s connect / 10 s total, 1 MB stream cap, text/html or text/plain only, no cookies, fixed UA. NXDOMAIN and timeouts give UNREACHABLE, never VERIFIED_ABSENT (human-only). |
| Rate limits (C6, ADR-12) | In-process token bucket `withRateLimit()` in node handlers, keyed by IP (socket address unless `TRUSTED_PROXY_HOPS`) and credential id. Login 5/min per IP and per email; invite/reset 10/h; public quote 30/min/IP; extension 60 batches/min/key; Apps Script 120/min/integration; Meta/WA 600/min/integration (log, do not 429 casually); AI drafts 30/min/workspace. Documented as single-instance. |
| XSS (T11) | No `dangerouslySetInnerHTML` (lint error). `safeHref()` allows http, https, mailto, tel. PDF has no HTML engine. Inbound email shown as text/plain. CSV cells starting with `= + - @ \t \r` prefixed with `'`. Nonce CSP, `frame-ancestors 'none'`, nosniff, `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store` and `X-Robots-Tag: noindex` on `/quote/*`. |
| Logo (P7, A37) | PNG, JPEG, WebP only, max 1 MB, magic-byte sniff, re-encode with sharp to WebP (strips metadata), stored `STORAGE_DIR/branding/{workspaceId}/{sha256}.webp`, served with fixed Content-Type and nosniff. No SVG. |
| Prompt injection (T10) | Models get no tools or credentials. Untrusted text in delimited JSON data fields, capped (website 4 KB, message 2 KB). Strict Zod output, strip-and-flag (C12), output policy on every string (currency amounts, URLs other than the server-inserted quote link, phones, emails, payment phrasing, off-catalog names) escalates. Auto-reply guard intents: quote_request, call_request, service_faq, stop, complaint, human_request, out_of_scope (fixed deflection plus handoff, L-2). |
| Logging (T16) | pino with redact paths; `lib/redact.ts` applied before persisting any payload (WebhookEvent, AuditEvent summary, JobAttempt error). Users see `{ code, message, reference: correlationId }`, never stacks. |
| Test control (T5 tests) | `/api/test/*` exists only when `APP_MODE=demo` and `AURALEAD_TEST_CONTROL=1`, and checks `TEST_CONTROL_TOKEN` in constant time. Boot refuses LIVE with the flag set. |
| Supply chain (T17) | Exact pins, `npm ci`, `npm audit --omit=dev --audit-level=high` in `npm run verify`. Provider SDKs never in client bundles (bundle grep for `sk-ant`, `sk-`, `re_`, `EAA`, `alx_`, env names). |

---

## 10. Design system (brief; full spec in `reviews/ceo/06-design.md` §11.7)

- Tokens in `src/styles/tokens.css`, mapped through Tailwind 4 `@theme` in `src/app/globals.css`. Dark ops theme for panels; paper theme for `/quote` and the PDF.
- Color: `--bg-0 #07080B`, `--bg-1 #0D0F14`, `--bg-2 #141720`, `--bg-3 #1B1F2A`, `--border-subtle` white 8%, `--border-strong` white 15%, `--text-1 #E8EAF0`, `--text-2 #A3A9B8`, `--text-3 #7D8496`, `--accent` cyan `#2BC8DC` (actions, links, focus), `--accent-fg #04121A`, `--ai` violet `#A78BFA` (reserved for AI provenance and AI mode), `--success #34D399`, `--warning #FBBF24`, `--danger #F87171`, `--info #60A5FA`, `--demo #FB923C` (demo banner and Simulated chips only). Paper: `--paper #FFFFFF`, `--ink-1 #111318`, `--ink-2 #4A5060`, `--rule #E3E6EC`, `--brand` (workspace color darkened in OKLCH until 4.5:1 on white for text, F14). Status is never color-only: icon + label always.
- Type: Inter (UI/body, tabular numerals), Manrope 600 (display only), JetBrains Mono (IDs, payloads, Apps Script). Scale 12/16, 13/18, 14/20, 16/24, 18/26, 20/28, 24/32 (panel max), 30/36, 36/40 (hero at 390), 48/52 (768), 56/60 (hero cap). Letter-spacing -0.02em at 30 px and above.
- Spacing 4 px base: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96. Radii 4, 6, 8, 12, 16, full.
- Motion: 150 ms (hover/press), 200 ms (popover/toast), 300 ms (sheet/dialog). Enter `cubic-bezier(0.2,0,0,1)`, exit `cubic-bezier(0.4,0,1,1)`. Motion library only. `MotionConfig reducedMotion="user"`. No count-ups, tickers, fake sparklines; metrics show "As of" time.
- Glass only on landing nav, landing preview frames, cmdk palette, dashboard sticky top bar (alpha >= 0.72, blur <= 16 px, solid fallback). Glow: landing only, max 2 sources per viewport; zero in panels.
- WebGL policy: `HeroGlobe` via `next/dynamic` with `ssr: false`; `GlobePoster` (SSR, LCP) first. `useVisualBudget` returns `off` for reduced motion, no WebGL2, saveData, `hardwareConcurrency <= 4`, or width < 768. Mount after idle and visibility; pause on hidden or offscreen; DPR `[1, 1.5]`; particles 6,000 high / 2,000 low; `webglcontextlost` swaps to the poster. Command-center 3D tile only at >= 1440 px, `aria-hidden`, carries no data. No textures, HDRIs, bloom or lens flares. Dashboard bundles contain no `three` modules (build report check).
- Vocabulary: `IntegrationStatus` labels and `StatusBadge` per `06-design.md` §11.6. DEMO banner on every authenticated page, chip on `/docs`, ribbon + PDF watermark "DEMO: not a valid offer" on quotes (demo only).
- Licensing: shadcn/Radix/Lucide/cmdk/Sonner/xyflow/three MIT or ISC; fonts OFL; Aceternity patterns re-implemented, not copied; Magic UI free components only with headers; all in `THIRD_PARTY_NOTICES.md`.

---

## 11. Milestones and tasks

Legend: **Deps** = tasks that must be done first. **Parallel** = tasks that may run at the same time without file conflicts. **Owns** = directories the task may create or edit (plus append-only shared files). Every task's tests are written first.

Milestone exit gate (all milestones): `npm run typecheck`, `npm run lint`, `npm run test` all exit 0; `docs/progress.md` updated; section 15 rows for the milestone ticked with passing test paths; `docs/decisions.md` updated for any deviation. M1 additionally cannot close without the T02 spike result recorded. M6 exit is `npm run verify`.

### M1: Foundation (discovery, decisions, checklist, shell, auth/roles, DB, migrations, seed)

**T01 Scaffold and toolchain**
- Goal: pinned project skeleton that installs and checks on Windows.
- Owns: `package.json`, lockfile, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `vitest.config.ts`, `playwright.config.ts` (skeleton), `.gitattributes`, `.gitignore` (`*.db*`, `src/generated/`, `.env`, `.env.*` except `.env.example`, `test-results/`), `.nvmrc`, `.env.example`, `src/lib/env-load.ts`, `src/lib/config.ts`, `src/lib/paths.ts`, `scripts/db-path.ts`, `scripts/setup.ts`, `CLAUDE.md`, `docs/progress.md`.
- Env contract (E12, ADR-44): `scripts/setup.ts` writes `.env` from `.env.example` with generated demo secrets (never overwrites existing keys). `src/lib/env-load.ts` is the single loader: it reads `.env` without overriding variables already set in the real environment, and is called first by `next.config.ts`, `prisma.config.ts`, `worker/index.ts`, `prisma/seed/index.ts` and every script. No `.env.local` or other env files are used.
- Deps: none.
- Tests: `tests/unit/config/env-load.test.ts` (real env wins over `.env`; missing `.env` tolerated in tests; setup output contains every `.env.example` key and never overwrites); `tests/unit/config/paths.test.ts` (default resolves to `%LOCALAPPDATA%\auralead\<mode>\app.db`, overrides honored, OneDrive warning emitted, `file:` URL uses forward slashes, works with a space in cwd); `tests/unit/config/env.test.ts` (Zod env schema; LIVE requires keys; demo defaults); `tests/unit/arch/import-boundaries.test.ts` (graph walk, initially over existing files); `tests/unit/arch/lint-rules.test.ts` (ESLint API on fixture snippets: `Date.now()` in server, `next/headers` in services, empty onClick, `dangerouslySetInnerHTML`, glow utility outside visual).

**T02 Windows spike (gate for everything that touches the DB)**
- Goal: prove the pinned Prisma 7 + better-sqlite3 adapter stack on this machine.
- Owns: `prisma.config.ts`, `prisma/schema.prisma` (Job, JobAttempt, WorkerHeartbeat, SystemSetting only), first migration, `src/server/db/client.ts`, `src/server/db/raw/claim-job.ts`, `tests/support/db.ts`, `tests/support/spawn.ts`, `tests/integration/spike/**`.
- Deps: T01.
- Steps: delete `node_modules`; `npm ci` (record prebuilt binaries used for better-sqlite3, @node-rs/argon2, sharp); `npx prisma migrate dev` against a tmp DB; verify PRAGMAs on the adapter's connection; run the claim statement from two OS processes; teardown kills children (`child.kill('SIGKILL')`, then `taskkill /T /F /PID` fallback) and deletes the DB with `fs.rm(..., { maxRetries: 5, retryDelay: 200 })`.
- Tests: `tests/integration/spike/sqlite-pragmas.test.ts` (`journal_mode = wal`, `busy_timeout = 5000`, `foreign_keys = 1` on the Prisma connection); `tests/integration/spike/two-process-claim.test.ts` (2 processes spawned via `process.execPath`, 200 jobs, each claimed exactly once, zero lost, no unhandled SQLITE_BUSY); `tests/integration/spike/bigint-datetime.test.ts` (BigInt 10^11 round-trips; a `Date` bound in raw SQL compares correctly against Prisma-written `runAt`); `tests/integration/spike/teardown.test.ts` (DB file deletable after teardown, no orphan PIDs).
- Fallback: if prebuilds fail or the adapter misbehaves, record it, switch to the next working option (better-sqlite3 version within the adapter range, then the Prisma built-in SQLite path if available for 7.10), re-run all four tests, and write ADR-02a. Result recorded in `decisions.md` and `progress.md` either way.

**T03 Full schema, migrations, DB layer**
- Goal: every model in section 5 (workspaceId on every tenant table, composite FKs where Prisma 7 accepts them, E10), partial unique indexes, scoped client with `assertSameWorkspace`, claimToken fence helper, busy-retrying transactions.
- Owns: `prisma/schema.prisma`, `prisma/migrations/**`, `src/server/db/{tx,scoped,fence}.ts`.
- Deps: T02.
- Parallel: T04, T05.
- Tests: `tests/integration/db/schema-constraints.test.ts` (each UNIQUE and PARTIAL UNIQUE rejects duplicates: LeadContactKey, Suppression, Approval APPROVED per version, one active PricingVersion, DispatchAttempt idempotencyKey, WebhookEvent (provider, scopeKey, externalKey), QuoteAcceptance, PipelineStageRun (executionId, stage)); `tests/integration/db/tenant-scope.test.ts` (scoped client injects workspaceId; unscoped tenant query throws; cross-tenant id returns null; `assertSameWorkspace` rejects a foreign serviceId, quoteId, leadId; composite FK rejects a cross-workspace PriceEntry or QuoteItem where configured); `tests/unit/arch/tenant-columns.test.ts` (parses `schema.prisma`: every model outside the identity allowlist has `workspaceId`, E10); `tests/integration/db/suppression-history.test.ts` (two active rows rejected; cleared row plus new active row allowed, E3); `tests/integration/db/with-tx-retry.test.ts` (second connection holding `BEGIN IMMEDIATE` causes retry then success; 3 failures raise `DbBusyError`).

**T04 Core lib**
- Goal: framework-free primitives.
- Owns: `src/lib/{clock,money,phone,ids,redact,logger,correlation}.ts`, `src/lib/errors/**`, `src/lib/format/**`, `src/lib/domain/**`.
- Deps: T01. Parallel: T03, T05.
- Tests: `tests/unit/lib/clock.test.ts` (System, Fixed, DbOffset construction guard); `tests/unit/lib/errors-http.test.ts` (every AppError subclass maps to its status; no stack in body; correlationId present); `tests/unit/lib/redact.test.ts` (every secret shape and PII pattern removed); `tests/unit/money/format-inr.test.ts` (`₹21,240.00`, `₹1,23,456.00`, host TZ independent); `tests/unit/money/quote-math.test.ts`, `rounding.test.ts` (section 8, AT5); `tests/unit/lib/phone.test.ts` (E.164 IN default, full-width digits, multi-number split, invalid kept raw).

**T05 Security primitives**
- Goal: crypto, HMAC, tokens, CSRF, rate limit, raw body, contact key.
- Owns: `src/server/security/**` (except `safe-fetch.ts`, which is T12).
- Deps: T01. Parallel: T03, T04.
- Tests: `tests/unit/security/secrets.test.ts` (GCM round trip, wrong AAD fails, tampered tag fails, unknown kid fails, rotation decrypts old and re-encrypts to active); `tests/unit/security/csrf.test.ts` (Origin mismatch, missing token, valid pass); `tests/unit/security/rate-limit.test.ts` (trip and refill with FixedClock); `tests/unit/security/raw-body.test.ts` (Content-Length over cap 413 before read; chunked body over cap aborts; exact bytes preserved incl. `\u0930` escapes); `tests/unit/security/contact-key.test.ts` (HMAC stable, pepper-dependent, normalized inputs); `tests/unit/security/tokens.test.ts` (32 bytes, base64url, hash lookup).

**T06 Auth, request context, audit**
- Goal: live login, sessions, invites, guards, ctx builders, demo personas, boot checks, audit writer, `withRoute()`.
- Owns: `src/server/auth/**`, `src/server/boot.ts`, `src/server/services/audit/**`, `src/app/api/_lib/with-route.ts`, `src/app/(auth)/**`, `src/app/api/app/auth/**`, `src/app/api/demo/session/**`, `src/app/api/test/**`.
- Deps: T03, T04, T05. Parallel: T07.
- Tests: `tests/integration/auth/session.test.ts` (rotation on login, revocation on role change, idle and absolute expiry, generic errors, timing dummy hash); `tests/integration/auth/login-lockout.test.ts` (persisted across a fresh client); `tests/integration/auth/demo-isolation.test.ts` (demo session route 404 in LIVE; demo cookie rejected by LIVE loader; seed refuses LIVE DB); `tests/integration/security/test-control-guard.test.ts` (404 without flag or token; boot refusal in LIVE with flag); `tests/integration/auth/context.test.ts` (body workspaceId ignored; employee unassigned 404; capability missing 403; adminContext writes audit before data).

**T07 Job runtime and worker**
- Goal: queue, claim, settle, reaper, backoff, heartbeat, pause points, worker entry.
- Owns: `src/server/jobs/**`, `worker/**`, `src/server/testing/pause.ts`.
- Deps: T02, T03, T04. Parallel: T06.
- Tests: `tests/integration/jobs/claim-exclusive.test.ts` (2 worker processes, 50 jobs, each runs once); `lease-expiry.test.ts` (SIGKILL A, clock past lease, B reclaims, attempts 2); `bounded-attempts.test.ts` (backoff grows, DEAD at max with redacted error); `serial-key.test.ts` (two jobs same serialKey never RUNNING together); `heartbeat.test.ts` (long job lease extended, no double claim; worker row updates within 10 s); `restart-idempotent.test.ts` (3 restarts mid-batch, counts equal single run); `lease-fencing.test.ts` (E5, generic handler: worker A paused after claim, lease expires, B reclaims and completes, A resumes: A's fenced tx throws LeaseLostError and A's domain writes are absent); `tests/unit/jobs/backoff.test.ts`.

**T08 Design system and app shell**
- Goal: tokens, base components, shared patterns, panel layouts, login page styling, DEMO banner, role switcher (DEMO only), workspace chip, cmdk shell.
- Owns: `src/styles/**`, `src/app/globals.css`, `src/app/layout.tsx`, `src/components/ui/**`, `src/components/patterns/**`, `src/app/dashboard/{user,employee,admin}/layout.tsx`.
- Deps: T01, T06 (session for chrome). Parallel: T07 if still in flight.
- Tests: `tests/components/patterns/status-badge.test.tsx` (every IntegrationStatus and delivery display state incl. Unknown and Simulated renders icon + label + mode chip); `tests/components/patterns/gated-action.test.tsx` (`aria-disabled`, focusable, visible reason, optional fix link); `tests/components/patterns/states.test.tsx` (EmptyState, ErrorState with correlation ID, no stack); `tests/unit/arch/live-bundle.test.ts` (RoleSwitcher module excluded when `NEXT_PUBLIC_APP_MODE=live`).

**T09 Seed, route manifest, tenant matrix harness, M1 smoke**
- Goal: deterministic seed (identities, 3+ workspaces in Delhi NCR, Mumbai, Bengaluru, memberships, assignments with capabilities, settings, services and pricing v1, scoring v1, pipeline v1), `db:reset`, `demo:refresh` skeleton, route manifest, generated tenant matrix, M1 pages (login, panel home pages showing real DB-derived workspace and identity info).
- Also owns the built-app E2E harness (E11): `tests/e2e/support/{global-setup,global-teardown,start-app}.ts` builds once, starts `next start` and `node dist/worker.js` on free ports (get-port) against a temp DB with the setup-generated `.env`, waits for `/api/health` and a fresh worker heartbeat, and kills children with `taskkill /T /F` fallback. Later E2E tasks and T38 reuse it.
- Owns: `prisma/seed/**`, `scripts/demo-refresh.ts`, `src/server/routes.manifest.ts`, `tests/support/routes.ts`, `tests/e2e/support/**`, `src/app/dashboard/*/page.tsx` (home only).
- Deps: T03, T06, T07 (worker for the harness), T08.
- Tests: `tests/integration/seed/determinism.test.ts` (two seeds with same `SEED_NOW` give identical content hash; reset works; refuses LIVE); `tests/integration/setup/setup-only-config.test.ts` (E12: temp dir, `npm run setup` only, then app and worker boot with no other env and agree on the DB path); `tests/integration/authz/tenant-matrix.test.ts` (every manifest route x owner A, employee unassigned, employee assigned without capability, super admin, against workspace B resources: 404/403 as specified; mutation bodies carrying workspace B ids give 404/422 (E10); unlisted route fails the test); `tests/unit/arch/route-manifest.test.ts` (every `page.tsx` and `route.ts` is in the manifest with fixtures); `tests/e2e/smoke/shell.spec.ts` (role switcher to each panel loads; LIVE build has no switcher; `/api/health` 200).

M1 parallel map: T01 -> T02 -> {T03, T04, T05 in parallel; T04 and T05 may start right after T01} -> {T06, T07 in parallel} -> T08 -> T09 (needs T06, T07, T08).

### M2: Vertical slice (simulated lead -> normalize/dedupe -> score -> draft -> versioned quote -> real PDF -> audit)

**T10 Lead ingestion core**
- Goal: `ingestBatch(ctx, source, records[])`, normalization, `LeadContactKey` dedupe, MergeReview, LeadSourceRecord and ImportBatch with per-record results, consent capture from mappings (P1), Maps default no WA consent, pipeline version pin (O5), audit + PipelineExecution + one `pipeline.advance` job in the same tx (E9: never downstream jobs directly). Ships the minimal pipeline executor (`services/pipeline/executor.ts`, `jobs/handlers/pipeline-advance.ts`) with a stage-handler registry, `PipelineStageRun` idempotency (UNIQUE executionId + stage), and the INGESTION stage; SCORE and DRAFT stage handlers are registered by T12 and T14; T23 adds APPROVAL and DELIVERY plus graph validation.
- Owns: `src/server/services/leads/**`, `src/server/services/messaging/consent.ts` (capture part), `src/server/services/pipeline/executor.ts`, `src/server/jobs/handlers/pipeline-advance.ts`, `src/lib/schemas/ingest/**`.
- Deps: T07, T09.
- Tests: `tests/integration/ingest/ingest-batch.test.ts` (3 records give 3 leads, source records, batch counts, audit, exactly one `pipeline.advance` job per lead and no direct score/enrich/draft jobs); `tests/integration/pipeline/executor-idempotency.test.ts` (E9: stub stage handlers; replaying `pipeline.advance` and restarting mid-stage runs each stage once per execution); `tests/integration/ingest/dedupe-race.test.ts` (two `Promise.all` batches from 2 Prisma clients with the same phone give 1 lead); `tests/integration/ingest/merge-review.test.ts` (email matches A, phone matches B: MergeReview, no write to A or B); `tests/integration/consent/consent-capture.test.ts` (E11: asserts ConsentRecord state only; same Sheets row with consent column gives one OPT_IN WHATSAPP MARKETING record with notice hash and submission-time `collectedAt`; without the column or with a falsy value gives none; Maps lead gives none; the eligible vs skipped assertion lives in T18); `tests/unit/leads/normalize.test.ts` (never invents emails; placeholder emails nulled; website status UNKNOWN by default); `tests/integration/ingest/pipeline-pin.test.ts` (lead pins active PipelineConfigVersion).

**T11 Source simulators and webhook persistence path**
- Goal: `/api/demo/simulate/[source]` for sheets, meta, gmaps; generic `WebhookEvent` persist + enqueue + stored-result replay with `scopeKey` idempotency (E2) and the encrypted processing payload plus `webhook.purge` job (E1); `ingest.process` job (decrypts the processing payload, never the redacted view); Employee lead console simulation buttons.
- Owns: `src/app/api/demo/simulate/**`, `src/server/services/webhooks/**`, `src/server/jobs/handlers/{ingest-process,webhook-purge}.ts`, `src/server/adapters/{sheets,meta}/demo.ts`.
- Deps: T10. Parallel: T12, T13.
- Tests: `tests/integration/ingest/simulate-sources.test.ts` (AT2: each source creates Lead, LeadSourceRecord, Job, AuditEvent; simulated flags set; LIVE workspace or LIVE mode gives 404); `tests/integration/ingest/replay-idempotency.test.ts` (AT3: same event twice gives +1 lead, +1 job, 0 dispatch, second 200 duplicate; identical event ids and batch ids sent to workspace A and workspace B through their own integrations both succeed as distinct leads (E2); same batchId with changed record 409); `tests/integration/webhooks/processing-payload-restart.test.ts` (E1: persist event, kill the worker before processing, restart: lead created with the correct phone and email; `payloadRedacted` contains no PII; ciphertext fails to decrypt under another event id; purge after processing plus retention nulls the processing payload).

**T12 Scoring and website enrichment**
- Goal: pure score 0-100 with reasons and unknown inputs, ScoringConfigVersion, rescore job, `safeFetch`, `lead.enrich` job, WebsiteStatus; registers the SCORE stage handler (enrich then score) in the T10 executor.
- Owns: `src/server/services/{scoring,enrichment}/**`, `src/server/security/safe-fetch.ts`, `src/server/jobs/handlers/{lead-score,lead-enrich,lead-rescore}.ts`, `src/server/services/pipeline/stages/score.ts`.
- Deps: T10. Parallel: T11, T13.
- Tests: `tests/unit/scoring/score.test.ts` (reasons sum, unknown inputs weight 0, versioned, "heuristic" caption constant); `tests/unit/security/safe-fetch.test.ts` (decimal/octal/hex IPs, `[::ffff:127.0.0.1]`, hostname to 10.0.0.1, redirect to 169.254.169.254, rebinding stub, 1 MB cap, slow body timeout, `file:`/`gopher:`/`data:` rejected; local `http.createServer` on port 0); `tests/integration/enrichment/enrich-job.test.ts` (REACHABLE stores stripped text marked untrusted; blocked gives BLOCKED; NXDOMAIN gives UNREACHABLE, never VERIFIED_ABSENT).

**T13 Pricing catalog and settings**
- Goal: services CRUD, PricingVersion per change (archive if referenced), tax and discount settings with explicit tax mode, `computeQuoteTotals`, User Pricing page (services, tax, discounts, timelines, history tabs; branding tab in T27).
- Owns: `src/server/services/pricing/{catalog,compute-totals,settings}.ts`, `src/app/dashboard/user/pricing/**`, `src/app/api/app/pricing/**`.
- Deps: T09. Parallel: T11, T12.
- Tests: `tests/unit/money/discount-limits.test.ts` (section 8); `tests/integration/pricing/pricing-versioning.test.ts` (edit creates version N+1; delete referenced service archives; negative price 422); `tests/integration/pricing/compute-totals.test.ts` (persisted totals equal pure math; ₹100 crore cap routes to review; missing price sets needsPricingReview).

**T14 AI adapters and draft generation**
- Goal: `AiPort`, local deterministic generator (keyed by input hash), Anthropic and OpenAI adapters (fixture-tested), strict schemas, strip-and-flag (C12), output policy, one repair retry then NEEDS_REVIEW, LIVE no silent fallback with explicit local button (C13), `ai.draft` job producing template variables, follow-up draft, email subject/body, quote proposal; registers the DRAFT stage handler in the T10 executor (one draft per execution via PipelineStageRun).
- Owns: `src/server/adapters/ai/**`, `src/server/services/ai/**` (except reply-guard, T21), `src/server/jobs/handlers/ai-draft.ts`, `src/server/services/pipeline/stages/draft.ts`.
- Deps: T10, T13.
- Tests: `tests/unit/ai/proposal-schema.test.ts` (price/discount/tax keys stripped and flagged; unknown service dropped to review; qty bounds); `tests/unit/ai/output-policy.test.ts`; `tests/unit/ai/injection-corpus.test.ts` (10+ cases in website text and inbound text: price, discount, recipients unchanged, escalation set); `tests/integration/ai/no-invented-price.test.ts` (AT5: proposal with `unitPrice: 1` uses server price, audit `ai_price_ignored`); `tests/integration/ai/live-no-fallback.test.ts` (LIVE provider failure gives NEEDS_REVIEW, no local output unless the explicit action, labelled `local-deterministic`); `tests/integration/contract/anthropic.test.ts`, `openai.test.ts` (request shape, 401/429/5xx/timeout/refusal/truncation mapping from recorded fixtures; undici MockAgent, net disabled).

**T15 Quote lifecycle**
- Goal: Quote, QuoteVersion, QuoteItem snapshots, state machine, material edit invalidation, approve CAS with Approval row, share create/revoke/supersede (C2), cancel, expiry sweeper, Quotations pages (list, detail with state timeline, new from proposal, revise).
- Owns: `src/server/services/quotes/{state-machine,versioning,share}.ts`, `src/server/services/approvals/**` (quote part), `src/server/jobs/handlers/quote-expire-sweep.ts`, `src/app/dashboard/user/quotations/**`, `src/app/api/app/quotes/**`.
- Deps: T13, T14.
- Tests: `tests/unit/quotes/state-machine.test.ts` (exhaustive 7x7); `tests/integration/quotes/snapshot-and-approval.test.ts` (AT6: catalog change leaves issued items unchanged; edit on APPROVED invalidates approval and creates v+1; queued dispatch cancelled `SUPERSEDED`); `tests/integration/quotes/version-conflict.test.ts` (approve expected=1 after v2: 409; two editors: 409); `tests/integration/quotes/expiry.test.ts` (FixedClock at validUntil: EXPIRED; share expiresAt <= validUntil, P16).

**T16 PDF and public quote**
- Goal: `buildQuoteRenderModel`, `QuoteDocument.tsx` (HTML), `QuotePdf.tsx` (react-pdf, embedded Inter with U+20B9, footer with version and short sha256, demo watermark), `quote.renderPdf` job on version creation, `QuoteArtifact`, `/quote/[token]` with all states (C3), beacon (C4), accept (C5), `/api/quote-share/[token]/pdf` (stored file or 503 + Retry-After + enqueue), authenticated `/api/quotes/[id]/pdf`.
- Owns: `src/server/pdf/**`, `src/components/quote/**`, `src/server/services/quotes/{render-model,accept}.ts`, `src/app/(public)/quote/**`, `src/app/api/quote-share/**`, `src/app/api/quotes/**`, `src/server/jobs/handlers/quote-render-pdf.ts`.
- Deps: T15.
- Tests: `tests/integration/pdf/pdf-matches-html.test.ts` (AT6: `%PDF-`; pdfjs text contains `21,240.00`, quote number, `v1`, short hash equal to the HTML DOM values; font list includes embedded Inter; 60-line quote paginates with total on last page); `tests/integration/quotes/share-credential.test.ts` (AT7: no/wrong token 404, revoked 404 identical body, cancelled 404, expired 410 naming sender, superseded 410, only sha256 stored, rate limit 429); `tests/integration/quotes/accept-idempotent.test.ts` (two parallel accepts: one ACCEPTED, one audit, same receipt; stale version 409; GET never mutates; missing nonce or wrong Origin 403); `tests/integration/quotes/view-beacon.test.ts` (GET appends FETCH only; beacon on SENT gives VIEWED; beacon on APPROVED records event + hint); `tests/unit/branding/demo-watermark.test.ts` (watermark only in demo); `tests/e2e/public/quote-states.spec.ts`.

**T17 Slice integration: employee lead console (minimal) and end-to-end audit**
- Goal: Employee `[ws]/leads` console with list, detail, "Generate draft", "Create quote from proposal", approve, PDF download; verify one correlation chain end to end.
- Owns: `src/app/dashboard/employee/[ws]/leads/**` (initial), `src/app/api/app/leads/**` (initial).
- Deps: T11, T12, T16.
- Tests: `tests/integration/slice/audit-trail.test.ts` (simulate gmaps lead -> score -> draft -> quote v1 -> approve -> PDF artifact; AuditEvents in order sharing one correlationId chain; log capture contains no seeded phone/email literal); `tests/e2e/slice/lead-to-pdf.spec.ts`.

M2 parallel map: T10 -> {T11, T12, T13 in parallel} -> T14 (needs T13) -> T15 -> T16 -> T17.

### M3: Inbox, approvals, persistent jobs, eligibility, inbound simulation, suppression, quote acceptance

**T18 Eligibility, window, consent, suppression**
- Goal: section 7 in code incl. `sendIntent`-based checks and `AUTO_SEND_DISABLED` (E4), re-opt-in ordering against the latest Stop with append-only suppression history (O2, E3), the SuppressionJournal producer and `suppression.journalReconcile` job (E8), M2 email rules, manual consent grant and attestation endpoints.
- Owns: `src/server/services/messaging/{eligibility,window,consent,suppression,suppression-journal}.ts`, `src/server/jobs/handlers/suppression-journal-reconcile.ts`, `src/app/api/app/consent/**`.
- Deps: T10.
- Tests: `tests/unit/messaging/eligibility-matrix.test.ts` (table-driven over every reason code and order); `tests/unit/messaging/window.test.ts` (AT9 unit: T0+24h-1ms eligible, T0+24h not, +1 ms not, delivered template does not reset, quote open does not reset, quick reply resets, older late inbound does not shrink); `tests/integration/consent/maps-no-whatsapp.test.ts` (AT8: Maps lead in a live template campaign skipped `NO_WHATSAPP_OPT_IN`, no DispatchAttempt); `tests/integration/consent/consent-capture-eligibility.test.ts` (P1, moved from T10 per E11: the same Sheets row with and without the consent column evaluates eligible vs skipped `NO_WHATSAPP_OPT_IN` for a template send); `tests/integration/consent/reoptin-ordering.test.ts` (O2: delayed form row older than Stop stays suppressed; START after Stop clears; undated evidence never clears; E3: Stop, START, Stop, then delayed consent older than the second Stop stays suppressed and history shows 2 rows, 1 cleared); `tests/integration/ops/suppression-journal.test.ts` (E8: each Stop and clear appends one fsynced JSONL line after commit; simulated append failure leaves `journaledAt` null and the reconcile job re-exports exactly once; no line for a rolled-back tx); `tests/integration/consent/email-eligibility.test.ts` (M2: WA consent does not imply email; attested B2B manual single ok, bulk and automated `ATTESTED_MANUAL_ONLY`; setting off hides attestation (403)).

**T19 Dispatch outbox and approve-and-send**
- Goal: section 4.4 incl. claimToken fencing of preflight and settle (E5), superseded-version settle CAS (E6), failure classes PRE_SEND / RETRYABLE / PERMANENT (E7), persisted `sendIntent` and `initiatedBy` on Message and DispatchAttempt (E4). Approval payloadHash (O3), approve-and-send tx, `dispatch.whatsapp` and `dispatch.email` handlers with demo transports, preflight, settle, reaper AMBIGUOUS, deferrals for pause/throttle/cap, DEMO outbound tripwire, WhatsApp error map (fixture-level), global and workspace pause, `outbound.lock`.
- Owns: `src/server/services/messaging/{dispatch,delivery-state}.ts`, `src/server/services/approvals/payload-hash.ts`, `src/server/adapters/{whatsapp,email}/{port,demo,error-map}.ts`, `src/server/adapters/http/outbound.ts`, `src/server/jobs/handlers/dispatch-*.ts`, `src/server/jobs/reaper.ts` (dispatch branch).
- Deps: T07, T15, T18.
- Tests: `tests/integration/dispatch/approve-and-send.test.ts` (AT12: 10 concurrent approve-and-send from 2 clients give 1 Approval, 1 Job, 1 Message, 1 attempt; others 200 same ids); `tests/integration/dispatch/payload-hash.test.ts` (O3: changing destination, variables, template, body or attachment after approval gives `APPROVAL_STALE`, 0 calls; applies to messages without quotes); `tests/integration/jobs/lease-expiry-send.test.ts` (SIGKILL after SENDING: AMBIGUOUS, job DEAD(AMBIGUOUS), adapter call count 1); `tests/integration/jobs/worker-restart.test.ts` (kill at P3, restart: AMBIGUOUS, 0 extra calls); `tests/integration/messaging/throttle-fallback-ambiguous.test.ts` (AT11: cap reached defers with next runAt; provider 429 backoff; email fallback only when enabled and independently eligible; timeout AMBIGUOUS visible, no second call); `tests/integration/jobs/pause-honored.test.ts` (global DB flag, `outbound.lock`, env flag, workspace pause: dispatch deferred, ingestion runs); `tests/integration/security/outbound-tripwire.test.ts` (DEMO: any outbound host throws; full simulated flow logs 0 outbound attempts); `tests/integration/dispatch/version-binding.test.ts` (T-e2: hold at P1, edit quote, release: 0 calls, CANCELLED `SUPERSEDED`); `tests/unit/messaging/error-map.test.ts` (131049 to FAILED(PERMANENT) RECIPIENT_FREQUENCY_CAP no auto retry, 131026 PERMANENT no suppression, 131047 WINDOW_CLOSED, HTTP 429 and SMTP 4xx RETRYABLE, 5xx RETRYABLE only with no-write evidence else AMBIGUOUS; every map entry has a failure class; tests reference the map, not literals); `tests/integration/dispatch/lease-fencing-send.test.ts` (E5: worker A paused at P1 after claim, lease expires, B reclaims and completes the send, A resumes: A's preflight throws LeaseLostError, provider call count stays 1, no domain writes from A); `tests/integration/dispatch/superseded-settle.test.ts` (E6: v1 send paused at P3, revise to v2 and approve v2, release v1 settle: Quote stays APPROVED on v2, v1 `sentAt` set, audit `quote.sent_superseded_version`); `tests/integration/dispatch/retryable-rejection.test.ts` (E7: provider 429 then 2xx gives attempt 1 FAILED(RETRYABLE), attempt 2 SENT, preflight re-ran (a Stop between attempts gives attempt 2 SKIPPED and 1 call total); max attempts reached gives DEAD; PERMANENT never retried); `tests/integration/dispatch/auto-send-disabled-queued.test.ts` (E4: automated attempts queued, auto-send disabled (and separately pipeline POLICY_AUTO switched to HUMAN): 0 sends, attempts SKIPPED `AUTO_SEND_DISABLED`; MANUAL_SINGLE attempts in the same queue still send).

**T20 WhatsApp and email webhooks, synchronous Stop, quick replies, statuses**
- Goal: `/api/webhooks/whatsapp` (GET verify, POST raw-body signature, routing by phone_number_id), synchronous Stop (C9) incl. Hindi keyword list, written through `messaging/suppression.ts` so the SuppressionJournal producer runs (E8), inbound to Conversation with `lastInboundProviderAt` max, quick replies `AL_QR_QUOTE_V1` (P3), `AL_QR_CALL_V1` (P4, CallRequest, booking link), `AL_QR_STOP_V1`, button-text fallback, unknown payload to review; `status.apply` rank merge with orphan retry; `/api/webhooks/email/[provider]` (demo + resend shape), bounce/complaint suppression; `/api/unsubscribe` synchronous; demo inbound simulation.
- Owns: `src/app/api/webhooks/{whatsapp,email}/**`, `src/app/api/unsubscribe/**`, `src/app/(public)/unsubscribe/**`, `src/server/services/messaging/{inbound,quick-replies}.ts`, `src/server/services/call-requests/**`, `src/server/jobs/handlers/{webhook-process,status-apply}.ts`.
- Deps: T19.
- Tests: `tests/integration/webhooks/whatsapp-signature.test.ts` (valid 200; flipped byte 401; re-serialized JSON with Devanagari escapes 401; missing header 401; wrong phone_number_id UNROUTED; GET challenge); `tests/integration/messaging/stop-and-takeover.test.ts` (AT10: STOP cancels QUEUED and retry-waiting attempts in the same tx, 0 adapter calls after; claimed job re-checks and skips); `tests/integration/messaging/stop-with-worker-down.test.ts` (no worker running: suppression and cancellation committed by the route, journal line written); `tests/integration/messaging/stop-race.test.ts` (T-a1 at P1: 0 calls; T-a2 at P2: exactly 1 call, then retry 0 calls); `tests/unit/messaging/rank-merge.test.ts` + `tests/integration/chaos/status-shuffle.test.ts` (fast-check shuffle with 3x duplicates and an orphan: final = rank max, one change per rank, orphan stored); `tests/integration/messaging/quick-replies.test.ts` (QUOTE with approved quote: document send queued when eligible, never localhost link; QUOTE without approved quote: draft + `customer_requested` approval, no holding message unless auto-send (P3); CALL creates 1 CallRequest, replay 0 (P4)); `tests/integration/messaging/window-dispatch.test.ts` (job enqueued at T0+23:59:59 dispatching at T0+24:00:01 takes template path or review, never free-form); `tests/integration/messaging/email-webhooks.test.ts` (bounce suppresses email only; unsubscribe synchronous; SMTP "no inbound" disclosure flag).

**T21 Conversations, takeover, automated reply guard**
- Goal: AI mode (Off, Draft, Auto when workspace auto-send on), takeover/resume with `modeVersion`, automated reply job with reply guard and escalation, `unansweredOutboundCount`.
- Owns: `src/server/services/messaging/conversations.ts`, `src/server/services/ai/reply-guard.ts`, `src/server/jobs/handlers/reply-auto.ts`.
- Deps: T20.
- Tests: `tests/integration/messaging/takeover-race.test.ts` (T-b1 takeover at P1: 0 calls; T-b2 takeover then resume: 0 calls; T-b3 newer inbound: 0 calls and regenerate job); `tests/integration/ai/auto-reply-guard.test.ts` (complaint, human request, out_of_scope: no model free text, escalation; in-scope FAQ within approved facts sends through same preflight); `tests/integration/messaging/auto-send-audit.test.ts` (enabling auto-send writes audit; quality RED pauses automation only).

**T22 Inbox UI, approval queue UI, quote share actions**
- Goal: User Inbox (thread list, thread, status ticks incl. "Delivery unknown", composer eligibility line from server `windowEndsAt` with "Final check happens at send", template picker, takeover/resume), Employee approvals (per workspace and cross-workspace, version diff, approve/reject/approve-and-send, edits within pricing permissions), quotation share controls (create, revoke, expiry, copy link marks SENT (P15), view evidence label).
- Owns: `src/app/dashboard/user/inbox/**`, `src/app/dashboard/employee/approvals/**`, `src/app/dashboard/employee/[ws]/approvals/**`, `src/app/api/app/{conversations,approvals,messages}/**`, `src/components/inbox/**`, `src/components/approvals/**`.
- Deps: T21. Parallel: T23, T24.
- Tests: `tests/e2e/inbox/window-boundary.spec.ts` (test clock: badge "Free-form until 05:30 IST", +1 ms past boundary: action switches to template or review, no "Sent"); `tests/e2e/inbox/takeover.spec.ts`; `tests/e2e/approvals/approve-send.spec.ts` (dblclick + programmatic retry: one dispatch; stale tab "changed since you opened it"; employee over-cap edit 403); `tests/e2e/quotes/manual-share.spec.ts` (copy link moves APPROVED to SENT with `MANUAL_LINK`).

**T23 Bulk actions and pipeline execution**
- Goal: bulk pre-flight via the shared eligibility function (`sendIntent = BULK`), `bulk.run` job with persisted results, `BulkResultSummary` drawer; PipelineConfigVersion validator (5 fixed stages, DAG, mandatory approval node with HUMAN or POLICY_AUTO only when auto-send on, P11); extends the T10 executor with APPROVAL and DELIVERY stages reading the lead's pinned version (O5, E9; DELIVERY creates attempts with `sendIntent = AUTOMATED`); switching HUMAN to POLICY_AUTO never auto-sends already queued approvals.
- Owns: `src/server/services/bulk/**`, `src/server/services/pipeline/{validator,config}.ts`, `src/server/services/pipeline/stages/{approval,delivery}.ts`, `src/server/jobs/handlers/bulk-run.ts`, `src/components/patterns/BulkResultSummary.tsx` (implementation), `src/app/api/app/bulk/**`.
- Deps: T19. Parallel: T22, T24.
- Tests: `tests/unit/pipeline/validator.test.ts` (cycle, unknown node, missing approval, POLICY_AUTO without auto-send rejected); `tests/integration/pipeline/pinned-version.test.ts` (O5: activating v2 leaves in-flight leads on v1; mode switch does not send queued approvals); `tests/integration/pipeline/full-run-replay.test.ts` (E9: ingest replay plus worker restart mid-pipeline yields exactly one quote draft per lead and, with POLICY_AUTO and an eligible lead, exactly one outbound effect (one SENT attempt, one demo transport call); with HUMAN, zero outbound and one pending approval); `tests/integration/bulk/bulk-actions.test.ts` (AT13: eligible + skipped + failed == selected; reason per skipped row; results survive reload; audit count equals actions; counts equal dispatch preflight outcomes for the same clock).

**T24 Admin inspector, ambiguity resolution, global pause, backup and restore**
- Goal: job and webhook inspector (redacted payloads, attempts, correlation timeline, cancel, safe retry, AMBIGUOUS resolution with typed reason), queue health, global outbound pause with re-auth, `db:backup` (VACUUM INTO), `db:restore` (O1, E8: write `outbound.lock` first, restore, reconcile non-terminal attempts created before backup time to AMBIGUOUS, replay SuppressionJournal entries newer than the backup timestamp in order (STOP inserts an active row if none, CLEAR clears with the journaled consent id), keep paused until an operator unpauses), `lead:erase` script.
- Owns: `src/server/services/{jobs-admin,admin}/**` (inspector parts), `src/app/dashboard/admin/{jobs,webhooks}/**`, `src/app/api/admin/{jobs,webhooks,system}/**`, `scripts/{db-backup,db-restore,lead-erase}.ts`.
- Deps: T19, T20 (journal producer via the Stop route). Parallel: T22, T23.
- Tests: `tests/integration/admin/inspector-actions.test.ts` (retry of AMBIGUOUS requires confirm text and reason, re-runs preflight, suppressed lead cancels; cancel QUEUED; every action audited `crossWorkspace`); `tests/integration/admin/queue-health.test.ts` (heartbeat older than 30 s reports "Worker not running"; AMBIGUOUS count; oldest queued age); `tests/integration/ops/restore-reconcile.test.ts` (O1, E8: uses the real T18/T20 producer, not a fixture journal: backup, send, Stop via the WhatsApp webhook route, restore: outbound paused, pre-backup non-terminal attempts AMBIGUOUS, suppression present after journal replay, a STOP then CLEAR sequence after the backup replays to the cleared state, 0 sends until unpause); `tests/integration/admin/global-pause.test.ts` (requires re-auth; in-flight past P2 completes; nothing new passes preflight); `tests/integration/ops/lead-erase.test.ts` (PII removed, Suppression contactKey kept, contactPlain nulled, audit tombstone without PII).

M3 parallel map: T18 -> T19 -> T20 -> T21 -> {T22, T23, T24 in parallel; T23 may start right after T19, T24 right after T20}.

### M4: Complete panels, DB-derived metrics, landing, responsive refinement

**T25 Metrics and command centers**
- Goal: `services/metrics/*` (one aggregate per widget, definition string exported), User command center (KPIs, "Needs you", funnel, activity), Admin global metrics with workspace table, productivity (P10). O6: "Accepted quote value" metric; "Confirmed revenue: unavailable (no payment data)". Pipeline value = SENT + VIEWED totals.
- Owns: `src/server/services/metrics/**`, `src/app/dashboard/user/page.tsx`, `src/app/dashboard/admin/{page,productivity}/**`, `src/components/metrics/**`.
- Deps: T22. Parallel: T26, T27, T28, T29, T30.
- Tests: `tests/integration/metrics/metrics-match-db.test.ts` (every widget equals a direct `count`/`sum`; CANCELLED and EXPIRED excluded from pipeline value; O6 labels); `tests/integration/metrics/query-budget.test.ts` (under 15 queries per dashboard load); `tests/integration/metrics/productivity-definitions.test.ts` (P10 metrics from AuditEvent, each with a definition string, no composite score).

**T26 Leads UI complete**
- Goal: User Leads (TanStack table, search on normalized columns, filters, keyset pagination capped counts, Kanban with "Move to stage" menu and drag, stage CAS 409, detail sheet with ScoreBreakdown and ConsentChips, source record), CSV export job (audited, expires 24 h, formula escaping), scoring config tab (P9). Record the TanStack v8/v9 check (ADR-01).
- Owns: `src/app/dashboard/user/leads/**`, `src/app/dashboard/employee/[ws]/leads/**` (completion), `src/app/dashboard/employee/[ws]/leads/scoring/**`, `src/components/leads/**`, `src/server/services/leads/export.ts`.
- Deps: T17, T23. Parallel: T25, T27-T30.
- Tests: `tests/integration/leads/stage-cas.test.ts` (stale stageVersion 409; forward-only auto promotions; LOST manual audited); `tests/unit/export/csv.test.ts`; `tests/integration/scoring/config-activation.test.ts` (Zod reject; preview on 20 sample leads; activation enqueues rescore); `tests/e2e/user/leads.spec.ts` (50/51 pagination boundary, Devanagari search, Kanban keyboard path, reload persists).

**T27 Pricing branding and quotations polish**
- Goal: branding tab (logo upload P7, brand color contrast F14, GSTIN format, terms), quotations list filters and status history polish.
- Owns: `src/server/services/pricing/branding.ts`, `src/app/dashboard/user/pricing/branding/**`, `src/app/api/app/branding/**`.
- Deps: T16. Parallel: T25, T26, T28-T30.
- Tests: `tests/integration/branding/logo-upload.test.ts` (SVG rejected, polyglot magic-byte mismatch rejected, >1 MB 413, output is WebP without EXIF, nosniff header); `tests/unit/branding/contrast.test.ts` (brand color darkened to >= 4.5:1 for text).

**T28 Employee panel: overview, Integration center (demo), pipeline editor UI, Sheets/Meta/Extension shells**
- Goal: assignment overview, workspace switcher, Integration center cards (status, masked creds UI, "Test connection" which in DEMO reports "Simulated, no provider contacted"), React Flow editor (read-only below 768 px with list view, keyboard path), and the Sheets, Meta and Extension pages wired to demo simulators and the configuration states that M5 fills with live adapters (every control either works in demo or is a `GatedAction` on configuration or mode, section 12).
- Owns: `src/app/dashboard/employee/{page.tsx}`, `src/app/dashboard/employee/[ws]/{integrations,pipeline,sheets,meta,extension}/**`, `src/components/{integrations,pipeline}/**`.
- Deps: T23. Parallel: T25-T27, T29, T30.
- Tests: `tests/e2e/employee/integrations.spec.ts` (Not configured shows setup action; secrets never in HTML; demo test connection labelled simulated); `tests/e2e/employee/pipeline-editor.spec.ts` (cycle shows edge error; save v2 active; 390 px read-only list); `tests/e2e/employee/simulations.spec.ts` (AT2 UI path, persists after reload).

**T29 Admin panel: workspaces, people, audit search**
- Goal: workspace drilldown (audited banner, read-only), people management (users, employees, memberships, assignments with capabilities and caps, status, plan labels, invites, reset links), audit search (filters, keyset pagination).
- Owns: `src/app/dashboard/admin/{workspaces,people,audit}/**`, `src/app/api/admin/{workspaces,people,audit}/**`, `src/server/services/admin/people.ts`.
- Deps: T24. Parallel: T25-T28, T30.
- Tests: `tests/integration/admin/drilldown-audit.test.ts` (AuditEvent before data; employee 403); `tests/integration/admin/people.test.ts` (role or status change revokes sessions; plan label audited; invite single use); `tests/e2e/admin/admin.spec.ts`.

**T30 Landing page**
- Goal: hero (poster then HeroGlobe), pipeline animation labelled with real behavior, bento with doc links, three-panel previews from seeded components with "Demo data" chip (`scripts/capture-previews.ts` optional), ROI calculator with editable visible assumptions and "Illustrative estimate", truthfulness strip, CTAs (demo, docs). No testimonials, logos or count-ups.
- Owns: `src/app/(public)/page.tsx`, `src/components/{landing,visual}/**`.
- Deps: T08. Parallel: T25-T29.
- Tests: `tests/unit/landing/roi.test.ts` (clamps, no NaN, reset); `tests/e2e/visual/webgl-fallback.spec.ts` (reduced-motion and `--disable-webgl` projects: poster present, no canvas, no console error loop); `tests/e2e/visual/visual-budget.spec.ts` (hero chunk not in initial JS; dashboards contain no `three` modules per build manifest).

**T31 Responsive, accessibility and hostile-input pass**
- Goal: all routes at 390/768/1440/1920, axe, gated actions, keyboard walkthrough, XSS seed lead across views.
- Owns: fixes across `src/app/**` and `src/components/**` limited to layout and a11y; `tests/e2e/visual/**`, `tests/e2e/security/**`.
- Deps: T25-T30.
- Tests: `tests/e2e/visual/responsive.spec.ts` (no horizontal page scroll; tables scroll internally; Kanban and React Flow non-drag paths); `tests/e2e/visual/a11y.spec.ts` (0 serious or critical at 390 and 1440 on every manifest route; keyboard approve-and-send); `tests/e2e/visual/gated-actions.spec.ts` (every gated control focusable with visible reason); `tests/e2e/visual/states.spec.ts` (loading, empty, error, partial via route mocks per 06-design §11.3); `tests/e2e/security/xss.spec.ts` (`<img src=x onerror=alert(1)>` and `javascript:` website: no dialog anywhere); `tests/e2e/security/hostile.spec.ts` (03-security / 04-tests §6.9 list).

M4 parallel map: {T25, T26, T27, T28, T29, T30} in parallel (file ownership is disjoint) -> T31.

### M5: Live adapters, protected webhooks, Sheets setup, Meta metrics/control, extension bridge, fixture integration tests

Before each M5 task, the implementer checks the current official provider docs, records links, API versions and the check date in `docs/integrations.md`, and marks anything not confirmed as UNVERIFIED (PRD working method 9). Live adapters are tested against recorded fixtures only; no real outbound request is made (PRD working method 10).

**T32 Integration credentials framework and WhatsApp Cloud API**
- Goal: encrypted credential CRUD, `creds:rotate`, connection test framework with persisted status; WhatsApp live adapter (template and text sends with per-send quick-reply payloads, document send via media upload P2, `biz_opaque_callback_data = attemptId`), template sync and intent/variable mapping (P12), quality and messaging limit raw fetch with "Unknown, last checked T", quality-based automation pause.
- Owns: `src/server/services/integrations/**`, `src/server/adapters/whatsapp/{cloud-api,media,limits}.ts`, `src/server/jobs/handlers/{template-sync,wa-quality-check,integration-health}.ts`, `scripts/creds-rotate.ts`.
- Deps: T24, T28.
- Tests: `tests/integration/integrations/credentials.test.ts` (masked reads, no reveal route, AAD swap fails, rotation run reports 0 remaining, LIVE decrypt failure shows "Credential unreadable, re-enter", never demo transport); `tests/integration/contract/whatsapp-cloud.test.ts` (request shapes for template, text, document; payload IDs set per send; error-map mapping from fixtures; timeout after write gives AMBIGUOUS); `tests/integration/contract/templates-sync.test.ts` (raw status/category stored; paused template blocks eligibility of queued items); `tests/integration/contract/quality-limits.test.ts` (no tier enum anywhere; missing field gives Unknown + time; RED pauses automation).

**T33 Email live adapters**
- Goal: Resend adapter (Idempotency-Key if confirmed; otherwise ambiguous handled as SMTP), SMTP via nodemailer (timeout after DATA gives AMBIGUOUS, "bounces not tracked", "no inbound"), Resend webhook signature verification and events, inbound threading (P5) if Resend receiving is confirmed, else disclosed as unsupported.
- Owns: `src/server/adapters/email/{resend,smtp}.ts`, `src/app/api/webhooks/email/[provider]/**` (resend branch), `src/server/services/messaging/email-inbound.ts`.
- Deps: T20, T32. Parallel: T34, T35, T36.
- Tests: `tests/integration/contract/resend.test.ts` (send shape, 401/422/429/5xx mapping, signature valid/invalid/stale, svix-id dedupe); `tests/integration/contract/smtp.test.ts` (local fake SMTP server: 4xx retry, timeout after DATA AMBIGUOUS); `tests/integration/messaging/email-inbound-threading.test.ts` (Reply-To token and In-Reply-To match; unmatched goes to a new flagged conversation; skipped with disclosure if unsupported).

**T34 Google Sheets and Apps Script**
- Goal: Sheets integration (service account JSON encrypted, share-with-SA guidance, header fetch connection test), SheetMapping with consent mapping (P1) and header fingerprint drift detection, Apps Script generator (setup, mapping, `auralead_event_id`, HMAC signing, retry guidance, secret in Script Properties), `/api/webhooks/google-sheets`, preview (dry run) and sync with weak-id flag.
- Owns: `src/server/adapters/sheets/google.ts`, `src/server/services/sheets/**`, `src/app/api/webhooks/google-sheets/**`, `src/app/dashboard/employee/[ws]/sheets/**` (live parts).
- Deps: T32. Parallel: T33, T35, T36.
- Tests: `tests/unit/sheets/apps-script-generator.test.ts` (endpoint, key id, event-id logic, signature format, no secret in sheet cells); `tests/integration/webhooks/sheets-signature.test.ts` (valid; skew 10 min 401 `REPLAY_WINDOW`; replayed eventId returns stored result; 256 KB / 50 rows cap); `tests/integration/sheets/preview-sync.test.ts` (fixture HTTP: 403 not shared shows guidance; preview writes nothing; drift blocks sync with column diff; script + sync never double-create); `tests/integration/consent/sheets-consent-mapping.test.ts` (P1 end to end through the webhook).

**T35 Meta Lead Ads and campaigns**
- Goal: `/api/webhooks/meta-ads` (GET verify, POST raw-body signature, `meta:{page}:{leadgen}` idempotency), `meta.lead.fetch` job with form field and consent mapping, on-demand "Backfill from form since T" (12.4), campaign metrics sync with ad-account currency and "As of" + date range + attribution (P6), pause/resume via `CampaignAction` (SENDING before call, read-back `effective_status`, Unknown on timeout), demo simulated toggles. `META_GRAPH_VERSION` and `META_MARKETING_VERSION` separate.
- Owns: `src/server/adapters/meta/graph.ts`, `src/server/services/campaigns/**`, `src/app/api/webhooks/meta-ads/**`, `src/server/jobs/handlers/{meta-lead-fetch,campaign-*}.ts`, `src/app/dashboard/employee/[ws]/meta/**` (live parts).
- Deps: T32. Parallel: T33, T34, T36.
- Tests: `tests/integration/webhooks/meta-signature.test.ts` (raw-body HMAC with Hindi name escapes; re-serialized fails; flipped byte fails; duplicate leadgen no duplicate lead; unmapped page UNROUTED); `tests/integration/contract/meta-leads.test.ts` (190 gives Verification required, job not retried; permission error names permission; rate limit backoff); `tests/integration/campaigns/controls.test.ts` (AT14: DEMO pause persists labelled Simulated with 0 outbound; LIVE without verified integration adapter not called (412); adapter error leaves status unchanged; timeout Unknown then read-back; spend shown in ad-account currency, never converted).

**T36 Extension ingestion and bridge**
- Goal: `/api/webhooks/gmaps-extension` (bearer token, CORS rule C18, caps C14, per-record results, batch replay), Extension hub (create token shown once, list, revoke, batch status, per-row failures, webhook config, example payload, simulate batch), `extension-bridge/` (saas-sync.js via `chrome.storage.onChanged` on the vendor key, own ledger and durable queue, stable batchId and recordId, `chrome.alarms` backoff capped 30 min, resume on SW start, honors vendor license gate `_auth.hasValidKey !== true` gives "Extension not licensed: sync disabled", `optional_host_permissions` for the SaaS origin, options page, PATCH-GUIDE.md with the one-line `importScripts` hook and manifest keys, example payloads). No vendor code committed (M1/D3).
- Owns: `src/app/api/webhooks/gmaps-extension/**`, `src/server/services/extension/**`, `src/app/dashboard/employee/[ws]/extension/**` (live parts), `extension-bridge/**`.
- Deps: T32. Parallel: T33, T34, T35.
- Tests: `tests/integration/webhooks/extension-ingest.test.ts` (AT8 revoked token 401 `token_revoked`; web Origin 403; CORS only for configured extension id; 201 records 413; replay returns stored results; changed body 409; partial failure per-record); `tests/integration/contract/extension-bridge.test.ts` (fake `chrome.*`: diff by row_key, ledger, queue persisted, never writes vendor key, "clear" is a no-op, license gate disables sync, missing cid falls back to row_key); `tests/integration/chaos/extension-bridge-chaos.test.ts` (SW suspended mid-retry resumes same batchId; revoke between retries stops and surfaces; network flap gives no duplicates).

M5 parallel map: T32 -> {T33, T34, T35, T36 in parallel}.

### M6: Docs, full acceptance run, browser inspection, production build, honest handoff

**T37 Documentation**
- Goal: in-app `/docs` (workflows, role guides, local setup, demo accounts, simulation walkthrough incl. `npm run demo:refresh` (P20), mode differences, Google Forms/Sheets vs Meta Instant Forms, extension setup and vendor telemetry disclosure phrased "observed in the copy inspected on <date>", WhatsApp templates/webhooks, AI and email config, troubleshooting, security, data/export/retention incl. pseudonymous suppression keys and DPDP "not legal advice", limitations); `docs/{architecture,deployment,runbooks,integrations}.md` (deployment covers SQLite limits, storage, worker lifecycle, backups, O1 restore, credential rotation, PostgreSQL path section 5.8); README; `THIRD_PARTY_NOTICES.md`; `scripts/gen-pg-schema.ts` with `prisma validate` on the generated PG schema.
- Owns: `src/app/(public)/docs/**`, `content/docs/**`, `docs/*.md` (except PRD, plan, decisions), `README.md`, `THIRD_PARTY_NOTICES.md`, `scripts/gen-pg-schema.ts`.
- Deps: T32-T36. Parallel: T38.
- Tests: `tests/e2e/docs/docs.spec.ts` (every docs page renders, anchors resolve, "Applies to" tags present); `tests/integration/ops/pg-schema.test.ts` (generated PG schema passes `prisma validate`).

**T38 Acceptance harness**
- Goal: `npm run verify` (`scripts/verify.mjs`): typecheck, lint, vitest, `npm audit --omit=dev --audit-level=high`, `next build`, tsup worker build, start built app + worker on free ports via the T09 harness, Playwright smoke and full projects, artifacts to `test-results/`, integration evidence matrix printout (P18). AT1 fresh-setup test in a temp copy using only `npm run setup` output (E12).
- Owns: `scripts/verify.mjs`, `tests/e2e/smoke/fresh-setup.spec.ts`, `tests/integration/security/{bundle-secrets,log-redaction-flow}.test.ts`. Reuses, does not own, `tests/e2e/support/**` (T09, E11).
- Deps: T31. Parallel: T37.
- Tests: `tests/e2e/smoke/fresh-setup.spec.ts` (AT1: temp copy, `npm ci`, `npm run setup` (writes `.env`), migrate deploy, seed, build, start app + worker with no other config; every manifest route 200 with no console errors; heartbeat within 10 s); `tests/integration/security/bundle-secrets.test.ts` (grep `.next/static/**` for key prefixes and env names: 0 hits); `tests/integration/security/log-redaction-flow.test.ts` (full simulated flow logs contain no seeded secret, phone or email literal).

**T39 Final acceptance, browser inspection, handoff**
- Goal: run `npm run verify` green; inspect landing, dashboards, inbox, pricing, quote/PDF, docs at 390/768/1440/1920 in a real browser (loading, empty, error, keyboard, reduced motion, WebGL fallback); fix root causes; write the final report (per panel status, E2E, verified commands, demo walkthrough, integration table implemented / fixture-tested / demo-verified / live-verified with dates and evidence paths, checks with outcomes and artifacts, limitations).
- Owns: fixes anywhere (root-cause only), `docs/progress.md`, `docs/integrations.md` status matrix, final report section in `docs/progress.md`.
- Deps: T37, T38.
- Tests: the full suite; no new test files unless a defect is found (then a regression test first).

Task count: M1 9, M2 8, M3 7, M4 7, M5 5, M6 3. Total 39.

---

## 12. GatedAction rule (O4)

`GatedAction` (`src/components/patterns/GatedAction.tsx`) renders a control that stays focusable (`aria-disabled="true"`), shows an inline reason line, and links to the fix when one exists. It may gate **only** on:

1. configuration (integration not configured or not verified, missing pricing, missing template mapping);
2. permission (role or capability);
3. mode (DEMO-only simulators, LIVE-only provider calls);
4. eligibility (the reason codes from section 7, window, suppression, pauses, caps).

It must never gate on missing implementation. A control whose behavior is not built fails milestone acceptance; it is not hidden behind a restriction message. Enforcement: the `GatedAction` `reason` prop is a typed union of the four categories (no free-text "coming soon"); lint bans `TODO`, "coming soon" and empty handlers in `src/app/**` and `src/components/**`; every section 15 row must cite a passing test. Navigation items for sections not yet built are omitted from the route manifest until their task lands, so no route ever renders a placeholder.

---

## 13. What stays externally unverifiable

These are implemented against official docs and recorded fixtures only. They are reported as "implemented, fixture-tested, not live-verified" until a user-authorized live check produces evidence.

| Integration | Not verifiable here | Tracking |
|---|---|---|
| WhatsApp Cloud API | Real sends, template approval, quality and messaging limit field names, error code semantics (131026, 131047, 131049, 130429, 131056, 132xxx), `biz_opaque_callback_data` echo and limits, media upload limits and TTL, India marketing frequency caps, unanswered-message cap | `docs/integrations.md` rows with doc links, Graph API version, check date, UNVERIFIED flags; `error-map.ts` header carries the same date |
| Meta Lead Ads and Marketing API | Webhook delivery from Meta, `leads_retrieval` App Review, Leads Access Manager behavior, Graph vs Marketing API version lifetimes (12.3), pause/resume on a real ad account | same; two config values `META_GRAPH_VERSION`, `META_MARKETING_VERSION` |
| Resend | Domain verification, `Idempotency-Key` support and window, inbound receiving product and payload, webhook signature scheme details | same; SMTP fallback disclosures |
| Google Sheets / Apps Script | Real Apps Script trigger execution and quotas, service-account access to a real sheet | same; generated script tested by unit test only |
| Anthropic / OpenAI | Live model IDs, refusal signals, rate limits | same; model IDs are workspace config |
| Google_Map_Extractor | Live sync on a licensed install (default per M1: not run on the unlicensed 50-record tier) | Reported "contract verified, live extension not verified" |
| PostgreSQL | Claim semantics and migrations on PG | `test:pg` documented, optional, no_claim |

`docs/integrations.md` carries one status matrix row per adapter with columns `implemented`, `fixture-tested`, `demo-verified`, `live-verified (date, evidence path)`. `npm run verify` prints which rows have evidence files (P18). DPDP timeline statements are marked "not legal advice".

---

## 14. Environment variables (`.env.example`)

`APP_MODE` (demo|live), `NEXT_PUBLIC_APP_MODE` (build-time copy), `APP_ORIGIN`, `AURALEAD_DATA_DIR` (default `%LOCALAPPDATA%\auralead`), `DATABASE_URL` (optional override), `STORAGE_DIR`, `BACKUP_DIR`, `SESSION_SECRET`, `SHARE_NONCE_KEY`, `SUPPRESSION_PEPPER`, `CREDENTIALS_KEYRING`, `CREDENTIALS_ACTIVE_KID`, `OUTBOUND_PAUSED`, `AURALEAD_TEST_CONTROL`, `TEST_CONTROL_TOKEN`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_GRAPH_VERSION`, `META_MARKETING_VERSION`, `TRUSTED_PROXY_HOPS`, `AUTH_COOKIE_INSECURE_DEV`, `SEED_NOW`, `LOG_LEVEL`. Provider API keys are per-workspace encrypted `Integration` secrets, never env vars (except optional demo-only placeholders, which are absent). `npm run setup` writes `.env` from `.env.example`, filling missing demo secrets; `.env` is the only env file, loaded by `src/lib/env-load.ts` with real environment variables taking precedence (E12). Losing `SUPPRESSION_PEPPER` makes existing suppressions unmatchable, so it is backed up with the key ring and LIVE refuses to boot without it.

npm scripts: `dev`, `worker`, `dev:all`, `build` (prisma generate, next build, tsup worker), `start`, `start:worker`, `typecheck`, `lint`, `test`, `test:unit`, `test:integration`, `test:e2e`, `verify`, `db:migrate`, `db:deploy`, `db:reset`, `db:seed`, `db:backup`, `db:restore`, `demo:refresh`, `creds:rotate`, `setup`, `lead:erase`.

---

## 15. Requirement-to-test checklist

Status column is filled by implementers (`[ ]` until the listed test passes, then `[x]` with the date; `[~] Txx part` means the listed earlier tasks' tests pass and later tasks still owe their files). `no_claim` states what a green test does not prove.

### 15.1 PRD requirement areas

| ID | PRD area | Test file(s) | Assertion summary | Task | no_claim | Status |
|---|---|---|---|---|---|---|
| R1 | DEMO/LIVE modes, persistent Demo label, no silent fallback | `tests/integration/auth/demo-isolation.test.ts`, `tests/integration/ai/live-no-fallback.test.ts`, `tests/components/patterns/status-badge.test.tsx`, `tests/integration/security/outbound-tripwire.test.ts` | Demo routes 404 in LIVE; demo label on every simulated status; LIVE failures never use demo transport or local AI silently; DEMO zero outbound | T06, T08, T14, T19 | Live provider behavior | [~] T06,T08 part green 2026-10-16 |
| R2 | No decorative controls, no TODO | `tests/unit/arch/lint-rules.test.ts`, `tests/e2e/visual/gated-actions.spec.ts`, `tests/unit/arch/route-manifest.test.ts` | Lint bans empty handlers and TODO; every gated action has a category reason; every route in manifest | T01, T09, T31 | Subjective usefulness | [~] T01,T09 part green 2026-10-16 |
| R3 | Tenant isolation, server-side roles | `tests/integration/authz/tenant-matrix.test.ts`, `tests/integration/db/tenant-scope.test.ts`, `tests/unit/arch/tenant-columns.test.ts`, `tests/integration/auth/context.test.ts` | Every route x 4 actors; 404 cross-tenant; body workspaceId ignored | T03, T06, T09 | Pen-test level assurance | [x] 2026-10-16 |
| R4 | Sales stages separate from consent/approval/delivery | `tests/integration/leads/stage-cas.test.ts`, `tests/unit/messaging/eligibility-matrix.test.ts` | Stage moves never change consent or delivery; eligibility never reads stage | T18, T26 | | [ ] |
| R5 | INR integer minor units, explicit rounding, UTC + IST display | `tests/unit/money/*.test.ts`, `tests/unit/lib/clock.test.ts` | BigInt paise, half-up, `formatINR`, Vitest runs with `TZ=America/New_York` | T04 | | [x] 2026-10-16 |
| R6 | Persistent jobs: claim, retry, bounded, inspection, idempotency, restart safety, no blind resend | `tests/integration/jobs/*.test.ts`, `tests/integration/spike/two-process-claim.test.ts` | Exactly-once claim across processes; DEAD at max; restart counts equal; AMBIGUOUS not retried | T02, T07, T19 | PostgreSQL semantics | [~] T02,T07 part green 2026-10-16 |
| R7 | Transactions for state + audit, redacted audit | `tests/integration/slice/audit-trail.test.ts`, `tests/unit/lib/redact.test.ts` | State change and AuditEvent commit together; summaries carry field names only | T06, T17 | | [~] T06 part green 2026-10-16 |
| R8 | Sheets ingestion (Apps Script + preview/sync) | `tests/integration/webhooks/sheets-signature.test.ts`, `tests/integration/sheets/preview-sync.test.ts`, `tests/unit/sheets/apps-script-generator.test.ts` | HMAC + ts + eventId; URL alone not authorized; drift blocks | T34 | Real Apps Script runtime (fixture) | [ ] |
| R9 | Meta Lead Ads ingestion | `tests/integration/webhooks/meta-signature.test.ts`, `tests/integration/contract/meta-leads.test.ts` | Raw-body signature; lead fetch via Graph fixture; dedupe by leadgen | T35 | Meta delivery and App Review | [ ] |
| R10 | Extension ingestion | `tests/integration/webhooks/extension-ingest.test.ts` | Token scope, caps, replay, partial failure | T36 | Live extension | [ ] |
| R11 | Demo simulations per source | `tests/integration/ingest/simulate-sources.test.ts` | Same services, durable records, audit | T11 | Payload parity with real providers | [ ] |
| R12 | Validation, E.164, never invent emails, dedupe to review, attribution, per-row failures | `tests/unit/leads/normalize.test.ts`, `tests/integration/ingest/{ingest-batch,dedupe-race,merge-review}.test.ts` | As named | T10 | | [ ] |
| R13 | Maps fields, website unknown unless verified absent | `tests/unit/leads/normalize.test.ts`, `tests/integration/enrichment/enrich-job.test.ts` | Fields mapped; VERIFIED_ABSENT human-only | T10, T12 | | [ ] |
| R14 | Explainable configurable score | `tests/unit/scoring/score.test.ts`, `tests/integration/scoring/config-activation.test.ts` | Reasons, unknown inputs, versioned config, rescore job | T12, T26 | Predictive value | [ ] |
| R15 | Enrichment SSRF limits, untrusted text | `tests/unit/security/safe-fetch.test.ts` | All encodings, rebinding, redirects, caps | T12 | | [ ] |
| R16 | AI adapters + local generator behind one interface, configurable model IDs | `tests/integration/contract/{anthropic,openai}.test.ts`, `tests/unit/ai/proposal-schema.test.ts` | Same port, labelled generator, model id from config | T14 | Live model behavior (fixture) | [ ] |
| R17 | Server pricing, AI cannot set price/discount/tax | `tests/integration/ai/no-invented-price.test.ts`, `tests/unit/money/discount-limits.test.ts` | Strip-and-flag; limits | T13, T14 | GST law correctness | [ ] |
| R18 | Snapshots, approval invalidation, version binding | `tests/integration/quotes/snapshot-and-approval.test.ts`, `tests/integration/dispatch/version-binding.test.ts` | As named | T15, T19 | | [ ] |
| R19 | HTML quote, real PDF, print, acceptance, share credentials | `tests/integration/pdf/pdf-matches-html.test.ts`, `tests/integration/quotes/share-credential.test.ts`, `tests/integration/quotes/accept-idempotent.test.ts`, `tests/e2e/public/quote-states.spec.ts` | Parity; states; idempotent accept | T16 | Viewer-specific rendering | [ ] |
| R20 | Quote states + view evidence wording | `tests/unit/quotes/state-machine.test.ts`, `tests/integration/quotes/view-beacon.test.ts` | 7x7 table; beacon only; label | T15, T16 | Human engagement | [ ] |
| R21 | Automated replies constrained, takeover at dispatch, escalation | `tests/integration/ai/auto-reply-guard.test.ts`, `tests/integration/messaging/takeover-race.test.ts` | Guard intents; 0 calls after takeover | T21 | | [ ] |
| R22 | WA opt-in evidence, Maps default no consent, templates only, AI fills permitted variables | `tests/integration/consent/*.test.ts`, `tests/integration/contract/templates-sync.test.ts` | As named | T10, T18, T32 | Meta's own enforcement | [ ] |
| R23 | Quick replies with stable payload IDs | `tests/integration/messaging/quick-replies.test.ts` | `AL_QR_*_V1`; text fallback; unknown to review | T20 | Button payload echo (UNVERIFIED) | [ ] |
| R24 | Window rule | `tests/unit/messaging/window.test.ts`, `tests/integration/messaging/window-dispatch.test.ts`, `tests/e2e/inbox/window-boundary.spec.ts` | Boundary exclusive, dispatch-time check | T18, T20, T22 | Meta's own window enforcement | [ ] |
| R25 | Stop suppression + cancel + re-check before every dispatch | `tests/integration/messaging/{stop-and-takeover,stop-with-worker-down,stop-race}.test.ts` | Synchronous; retries re-check | T20 | In-flight provider delivery | [ ] |
| R26 | Real quality/limits or Unknown; no tier lists; quality pause | `tests/integration/contract/quality-limits.test.ts` | Raw values; Unknown + time; RED pauses automation | T32 | Live field names (UNVERIFIED) | [ ] |
| R27 | Email eligibility separate, unsubscribe, fallback rules, SMTP no inbound | `tests/integration/consent/email-eligibility.test.ts`, `tests/integration/messaging/email-webhooks.test.ts`, `tests/integration/contract/{resend,smtp}.test.ts` | M2 rules; fallback independent; disclosures | T18, T20, T33 | Resend inbound availability | [ ] |
| R28 | Provider message IDs, statuses, duplicates, out-of-order, redacted errors | `tests/unit/messaging/rank-merge.test.ts`, `tests/integration/chaos/status-shuffle.test.ts` | Rank max; events stored | T20 | | [ ] |
| R29 | Approval-required default; auto-send opt-in, audited, same checks | `tests/integration/messaging/auto-send-audit.test.ts`, `tests/integration/pipeline/pinned-version.test.ts` | Default HUMAN; toggle audited; POLICY_AUTO gated | T21, T23 | | [ ] |
| R30 | Landing (hero, pipeline, bento, previews, ROI) | `tests/unit/landing/roi.test.ts`, `tests/e2e/visual/{webgl-fallback,visual-budget}.spec.ts` | Editable assumptions; fallback; bundle budget | T30 | Aesthetic quality | [ ] |
| R31 | Client panel (command center, leads, inbox, pricing, quotations) | `tests/e2e/user/leads.spec.ts`, `tests/e2e/inbox/*.spec.ts`, `tests/integration/metrics/metrics-match-db.test.ts`, `tests/integration/pricing/*.test.ts` | DB-derived; persisted actions | T13, T15, T22, T25, T26 | | [ ] |
| R32 | Employee panel (console, Sheets, Meta, extension hub, approvals, integrations, pipeline) | `tests/e2e/employee/*.spec.ts`, `tests/e2e/approvals/approve-send.spec.ts` | Each page's primary action persists | T17, T22, T28, T34-T36 | | [ ] |
| R33 | Super admin panel | `tests/integration/admin/*.test.ts`, `tests/e2e/admin/admin.spec.ts` | Drilldown audited; people; audit search; inspector | T24, T29 | | [ ] |
| R34 | `/docs` content | `tests/e2e/docs/docs.spec.ts` | All sections render | T37 | Doc accuracy beyond tests | [ ] |
| R35 | Role switcher on all routes in DEMO, absent in LIVE | `tests/e2e/smoke/shell.spec.ts`, `tests/unit/arch/live-bundle.test.ts` | P19 | T08, T09 | | [x] 2026-10-16 |
| R36 | Visual design, a11y, viewports, reduced motion | `tests/e2e/visual/{responsive,a11y,states}.spec.ts` | As named | T31 | Real low-power devices | [ ] |
| R37 | Extension bridge contract | `tests/integration/contract/extension-bridge.test.ts`, `tests/integration/chaos/extension-bridge-chaos.test.ts` | MV3 suspension, durable queue, license gate | T36 | Live extension (M1) | [ ] |
| R38 | Credentials encrypted, masked, rotation | `tests/unit/security/secrets.test.ts`, `tests/integration/integrations/credentials.test.ts` | As named | T05, T32 | | [~] T05 part green 2026-10-16 |
| R39 | CSRF, validation, rate limits | `tests/unit/security/{csrf,rate-limit}.test.ts`, `tests/e2e/security/hostile.spec.ts` | As named | T05, T31 | Multi-instance limits | [~] T05 part green 2026-10-16 |
| R40 | Global outbound pause + workspace automation pause in workers | `tests/integration/jobs/pause-honored.test.ts`, `tests/integration/admin/global-pause.test.ts` | DB flag, lock file, env | T19, T24 | | [ ] |
| R41 | Structured logs, correlation IDs, no stacks/tokens | `tests/integration/security/log-redaction-flow.test.ts`, `tests/unit/lib/errors-http.test.ts` | As named | T04, T38 | | [~] T04 part green 2026-10-16 |
| R42 | SQLite limits, backups, worker lifecycle, PG path documented | `tests/integration/ops/{restore-reconcile,pg-schema}.test.ts` | Backup/restore works; PG schema validates | T24, T37 | PG runtime | [ ] |
| R43 | Seed: deterministic, Indian businesses, varied states | `tests/integration/seed/determinism.test.ts` | Identical hash; required fixture coverage list asserted | T09 (extended by later tasks) | | [x] 2026-10-16 |
| R44 | Campaign metrics + pause/resume only | `tests/integration/campaigns/controls.test.ts` | AT14 | T35 | Live Meta (fixture) | [ ] |
| R45 | Call request record or booking link | `tests/integration/messaging/quick-replies.test.ts` | P4 | T20 | | [ ] |
| R46 | Plan labels + admin management (no billing) | `tests/integration/admin/people.test.ts` | Plan label audited | T29 | | [ ] |

### 15.2 Acceptance tests AT1-AT16

| AT | Test file(s) | Key assertions | Task | no_claim | Status |
|---|---|---|---|---|---|
| AT1 | `tests/e2e/smoke/fresh-setup.spec.ts`, `tests/integration/setup/setup-only-config.test.ts` | Clean temp copy: `npm ci`, `npm run setup`, migrate, seed, build, app + worker start with only the setup-generated `.env`; all manifest routes 200, no console errors; heartbeat within 10 s | T38 | LIVE with real credentials; PG | [ ] |
| AT2 | `tests/integration/ingest/simulate-sources.test.ts`, `tests/e2e/employee/simulations.spec.ts` | Lead, source record, job, audit per source; persists after reload | T11, T28 | Real payload parity (fixture) | [ ] |
| AT3 | `tests/integration/ingest/replay-idempotency.test.ts`, `tests/integration/webhooks/{meta-signature,extension-ingest,sheets-signature}.test.ts` | Replays create no leads, quotes or outbound; identical event and batch ids in workspaces A and B are both accepted as distinct (E2) | T11, T34-T36 | Provider retry timing | [ ] |
| AT4 | `tests/integration/authz/tenant-matrix.test.ts`, `tests/integration/auth/demo-isolation.test.ts`, `tests/e2e/security/hostile.spec.ts` | ID tampering 404; unassigned employee blocked; demo cannot elevate in LIVE | T06, T09, T31 | Pen test | [~] T06,T09 part green 2026-10-16 |
| AT5 | `tests/unit/money/{quote-math,rounding,discount-limits}.test.ts`, `tests/integration/ai/no-invented-price.test.ts` | 2,124,000 paise with every intermediate; half-up cases; limits; AI price ignored | T04, T13, T14 | GST cases | [~] T04 part green 2026-10-16 |
| AT6 | `tests/integration/quotes/snapshot-and-approval.test.ts`, `tests/integration/pdf/pdf-matches-html.test.ts` | Snapshots preserved; edit invalidates approval; PDF text equals HTML totals, version, hash | T15, T16 | Viewer fidelity | [ ] |
| AT7 | `tests/integration/quotes/{share-credential,accept-idempotent}.test.ts`, `tests/e2e/public/quote-states.spec.ts` | Token required; 404/410 per C3; idempotent accept | T16 | Intended recipient | [ ] |
| AT8 | `tests/integration/consent/maps-no-whatsapp.test.ts`, `tests/integration/webhooks/{whatsapp-signature,meta-signature,extension-ingest}.test.ts` | Maps lead skipped `NO_WHATSAPP_OPT_IN`; bad signatures 401; revoked token 401 | T18, T20, T35, T36 | Meta production signing (fixture secret); live extension | [ ] |
| AT9 | `tests/unit/messaging/window.test.ts`, `tests/integration/messaging/window-dispatch.test.ts`, `tests/e2e/inbox/window-boundary.spec.ts` | Template delivery does not open; inbound does; exclusive boundary with injected clock across web and worker | T18, T20, T22 | Meta enforcement | [ ] |
| AT10 | `tests/integration/messaging/{stop-and-takeover,stop-with-worker-down,stop-race,takeover-race}.test.ts` | Stop cancels queued and retrying; takeover blocks queued automated reply at dispatch | T20, T21 | In-flight provider delivery | [ ] |
| AT11 | `tests/integration/messaging/throttle-fallback-ambiguous.test.ts` | Throttle defers; fallback needs separate eligibility; ambiguous visible, no resend | T19 | Real provider limits | [ ] |
| AT12 | `tests/integration/dispatch/{approve-and-send,lease-fencing-send,superseded-settle}.test.ts`, `tests/integration/jobs/{worker-restart,lease-expiry-send}.test.ts`, `tests/integration/chaos/status-shuffle.test.ts` | One version-bound dispatch under duplicates, out-of-order statuses, restarts | T19, T20 | PG concurrency | [ ] |
| AT13 | `tests/integration/bulk/bulk-actions.test.ts`, `tests/integration/metrics/metrics-match-db.test.ts` | Counts reconcile; metrics and audit match stored actions | T23, T25 | Copy usefulness | [ ] |
| AT14 | `tests/integration/campaigns/controls.test.ts` | Demo persists Simulated; live only when authorized and verified; failures never success | T35 | Meta accepting the call (fixture) | [ ] |
| AT15 | `tests/e2e/visual/{responsive,a11y,states,webgl-fallback,gated-actions}.spec.ts` | Viewports, states, keyboard, reduced motion, WebGL fallback | T30, T31 | Aesthetics; real devices | [ ] |
| AT16 | `scripts/verify.mjs` (`npm run verify`) | typecheck, lint, unit/integration, audit, build, start built app + worker, Playwright smoke and projects, all exit 0 | T38, T39 | Hosted deployment | [ ] |

### 15.3 Outside voice O1-O6

| ID | Test file(s) | Assertion summary | Task | Status |
|---|---|---|---|---|
| O1 | `tests/integration/ops/restore-reconcile.test.ts`, `tests/integration/ops/suppression-journal.test.ts` | Restore sets `outbound.lock` first; pre-backup non-terminal attempts AMBIGUOUS; SuppressionJournal entries newer than the backup replayed (E8); 0 sends until unpause | T18, T24 | [ ] |
| O2 | `tests/integration/consent/reoptin-ordering.test.ts` | Evidence older than the latest Stop never clears suppression; strictly newer OPT_IN does; second Stop after re-opt-in re-suppresses (E3) | T18 | [ ] |
| O3 | `tests/integration/dispatch/payload-hash.test.ts` | Any change to channel, destination, template, variables, body, subject or attachment after approval gives `APPROVAL_STALE`, 0 calls | T19 | [ ] |
| O4 | `tests/unit/arch/lint-rules.test.ts`, `tests/components/patterns/gated-action.test.tsx`, `tests/e2e/visual/gated-actions.spec.ts` | GatedAction reasons limited to 4 categories; no TODO/coming-soon | T01, T08, T31 | [~] T01,T08 part green 2026-10-16 |
| O5 | `tests/integration/ingest/pipeline-pin.test.ts`, `tests/integration/pipeline/{pinned-version,full-run-replay}.test.ts` | Execution pinned at ingestion; new version affects new leads only; HUMAN to POLICY_AUTO sends nothing queued | T10, T23 | [ ] |
| O6 | `tests/integration/metrics/metrics-match-db.test.ts` | "Accepted quote value" metric; "Confirmed revenue" shown unavailable | T25 | [ ] |

### 15.4 Critic remedies P1-P20

| ID | Test file(s) | Assertion summary | Task | no_claim | Status |
|---|---|---|---|---|---|
| P1 | `tests/integration/consent/{consent-capture,consent-capture-eligibility,sheets-consent-mapping}.test.ts` | T10: ConsentRecord created or not, notice hash stored; T18: same row with/without consent column evaluates eligible vs skipped (E11) | T10, T18, T34 | Meta form disclaimer shape (fixture) | [ ] |
| P2 | `tests/integration/contract/whatsapp-cloud.test.ts`, `tests/integration/messaging/quick-replies.test.ts` | Document send via media id; never localhost link; demo records would-be media send | T20, T32 | Media endpoint limits (UNVERIFIED) | [ ] |
| P3 | `tests/integration/messaging/quick-replies.test.ts` | QUOTE without approved quote: draft + flagged approval, no holding message unless auto-send | T20 | | [ ] |
| P4 | `tests/integration/messaging/quick-replies.test.ts` | CALL creates 1 CallRequest, replay 0; https-only booking URL | T20 | | [ ] |
| P5 | `tests/integration/messaging/email-inbound-threading.test.ts` | Reply-To token threading or disclosed unsupported | T33 | Resend receiving availability | [ ] |
| P6 | `tests/integration/campaigns/controls.test.ts` | Spend and CPL in ad-account currency, never converted; As-of + range + attribution | T35 | | [ ] |
| P7 | `tests/integration/branding/logo-upload.test.ts` | Raster only, re-encoded, no SVG | T27 | | [ ] |
| P8 | `tests/integration/pdf/pdf-matches-html.test.ts` | One tax line; "Quotation, not a tax invoice" text present | T16 | Tax law | [ ] |
| P9 | `tests/integration/scoring/config-activation.test.ts` | Versioned config, preview, rescore job, owner read-only | T26 | | [ ] |
| P10 | `tests/integration/metrics/productivity-definitions.test.ts` | Metrics from AuditEvent with definitions, no composite | T25 | | [ ] |
| P11 | `tests/unit/pipeline/validator.test.ts` | Approval node mandatory; POLICY_AUTO only with auto-send | T23 | | [ ] |
| P12 | `tests/integration/contract/templates-sync.test.ts` | Synced, mapped to intents; not authored in-app | T32 | WhatsApp Manager flow | [ ] |
| P13 | `tests/unit/messaging/eligibility-matrix.test.ts` | Inbound consent enables in-window replies only, not templates | T18 | | [ ] |
| P14 | `tests/integration/sheets/preview-sync.test.ts` | Service account; 403 not shared shows share guidance | T34 | Real Google access | [ ] |
| P15 | `tests/e2e/quotes/manual-share.spec.ts`, `tests/integration/quotes/view-beacon.test.ts` | Copy link / mark sent moves APPROVED to SENT; beacon on APPROVED gives hint | T16, T22 | | [ ] |
| P16 | `tests/integration/quotes/expiry.test.ts` | validUntil default 15 d; share expiresAt <= validUntil; EXPIRED independent of links | T15 | | [ ] |
| P17 | Milestone gates (this section) | Every milestone ticks rows and updates progress.md | all | | [ ] |
| P18 | `scripts/verify.mjs` output, `docs/integrations.md` matrix | Evidence matrix printed | T38 | | [ ] |
| P19 | `tests/e2e/smoke/shell.spec.ts`, `tests/unit/arch/live-bundle.test.ts` | Switcher on `/`, `/docs` and panels in DEMO; absent from LIVE bundle | T08, T09 | | [x] 2026-10-16 |
| P20 | `tests/integration/seed/determinism.test.ts` | `demo:refresh` re-bases window and expiry fixtures without changing IDs | T09, T24 | | [~] T09 part green 2026-10-16 |

### 15.5 Eng outside voice E1-E12 (Codex, 2026-10-15, all accepted)

| ID | Sev | Finding and fix (plan sections) | Test file(s) | Assertion summary | Task | ADR | Status |
|---|---|---|---|---|---|---|---|
| E1 | High | Webhook workers lost PII after restart because only a redacted payload was stored. `WebhookEvent.processingPayload` encrypted with the credentials key ring (AAD = webhookEventId), purged after processing plus retention (§4.3, §5.6, §9) | `tests/integration/webhooks/processing-payload-restart.test.ts` | Restart between persist and process still creates the lead with the correct contact; redacted view has no PII; wrong AAD fails; purge nulls the ciphertext | T11 | ADR-35 | [ ] |
| E2 | High | Global `(provider, externalKey)` uniqueness collided across tenants. Unique `(provider, scopeKey, externalKey)` with scopeKey = routed integration or authenticated workspace (§4.3, §5.6) | `tests/integration/ingest/replay-idempotency.test.ts` | Identical Sheets event ids and extension batch ids in workspaces A and B both accepted as distinct; replay within one scope deduped | T11, T34, T36 | ADR-36 | [ ] |
| E3 | High | Second Stop undefined. Suppression is append-only history with `clearedAt`, `clearedByConsentId`, partial unique on active rows; re-opt-in evidence must be newer than the latest Stop (§5.3, §7) | `tests/integration/consent/reoptin-ordering.test.ts`, `tests/integration/db/suppression-history.test.ts` | Stop, START, Stop, delayed consent stays suppressed; at most one active row | T03, T18 | ADR-37 | [~] T03 part green 2026-10-16 |
| E4 | High | Send provenance not persisted. `sendIntent` (MANUAL_SINGLE, BULK, AUTOMATED, CUSTOMER_REQUESTED_REPLY) and `initiatedBy` on Message and DispatchAttempt; dispatch checks `AUTO_SEND_DISABLED` (§5.5, §6.3, §7) | `tests/integration/dispatch/auto-send-disabled-queued.test.ts`, `tests/unit/messaging/eligibility-matrix.test.ts` | Disabling auto-send (or leaving POLICY_AUTO) with automated work queued gives 0 sends; manual sends unaffected | T18, T19 | ADR-45 | [ ] |
| E5 | High | Lease fencing came too late. Every job-driven tx starts with the claimToken fence; LeaseLostError aborts before writes and provider calls (§4.3, §4.4, §6.3) | `tests/integration/jobs/lease-fencing.test.ts`, `tests/integration/dispatch/lease-fencing-send.test.ts` | Paused worker A after lease loss: preflight fails, 0 extra provider calls, no domain writes | T03, T07, T19 | ADR-39 | [~] T03,T07 part green 2026-10-16 |
| E6 | High | An old send could mark a new quote version SENT. Settle CAS on `currentVersionId` + APPROVED; superseded sends set `QuoteVersion.sentAt` only (§4.4, §5.4, §6.1) | `tests/integration/dispatch/superseded-settle.test.ts` | v1 settles after v2 approved: Quote stays APPROVED v2, v1 marked sent | T19 | ADR-40 | [ ] |
| E7 | High | Retryable definite rejections had no transition. `failureClass` PRE_SEND / RETRYABLE / PERMANENT; RETRYABLE requeues and attempt N+1 re-runs preflight (§4.4, §6.3) | `tests/integration/dispatch/retryable-rejection.test.ts`, `tests/unit/messaging/error-map.test.ts` | 429 then 2xx gives 2 attempts; Stop between attempts blocks attempt 2; PERMANENT never retried; every error-map entry classed | T19, T32, T33 | ADR-41 | [ ] |
| E8 | High | Restore depended on a nonexistent audit export. SuppressionJournal JSONL in `DATA_DIR/<mode>/journal/`, fsynced after commit, reconcile job on failure; restore replays entries newer than the backup (§1, §5.7, §7) | `tests/integration/ops/suppression-journal.test.ts`, `tests/integration/ops/restore-reconcile.test.ts` | Producer writes one line per STOP/CLEAR; reconcile re-exports once; restore with the real producer restores suppression state | T18, T20 (producer), T24 (consumer) | ADR-38 | [ ] |
| E9 | High | Pipeline execution could be decorative. Single orchestrator: ingestion enqueues only `pipeline.advance`; `PipelineStageRun` UNIQUE (executionId, stage); T10 ships the executor, T12/T14 register stages, T23 adds approval/delivery (§4.3, §5.7) | `tests/integration/pipeline/executor-idempotency.test.ts`, `tests/integration/pipeline/full-run-replay.test.ts`, `tests/integration/ingest/ingest-batch.test.ts` | Replay plus restart mid-pipeline: exactly one quote draft; POLICY_AUTO + eligible: exactly one outbound effect | T10, T12, T14, T23 | ADR-43 | [ ] |
| E10 | High | PriceEntry and QuoteItem lacked workspaceId. Every tenant table carries workspaceId; `assertSameWorkspace` on referenced ids; composite FKs where supported (§5 conventions, §9) | `tests/unit/arch/tenant-columns.test.ts`, `tests/integration/db/tenant-scope.test.ts`, `tests/integration/authz/tenant-matrix.test.ts` | Schema check finds no tenant model without workspaceId; foreign ids in mutation bodies give 404/422 | T03, T09 | ADR-42 | [x] 2026-10-16 |
| E11 | Medium | Tests preceded their dependencies. T10 consent test asserts ConsentRecord state; eligibility assertion moved to T18; built-app E2E harness moved into T09 (T09 now depends on T07) (§11) | `tests/integration/consent/consent-capture.test.ts`, `tests/integration/consent/consent-capture-eligibility.test.ts`, `tests/e2e/smoke/shell.spec.ts` | Each test runs green at its own task with no later-task code | T09, T10, T18 | none (planning) | [~] T09 part green 2026-10-16 |
| E12 | Medium | Env file mismatch. `npm run setup` writes `.env`; one loader `src/lib/env-load.ts` (real env first) for Next, Prisma config, worker, seed, scripts (§2.1, §4.3, §14) | `tests/unit/config/env-load.test.ts`, `tests/integration/setup/setup-only-config.test.ts`, `tests/e2e/smoke/fresh-setup.spec.ts` | App and worker boot from setup-generated config only and resolve the same DB path | T01, T09, T38 | ADR-44 | [~] T01,T09 part green 2026-10-16 |

---

## 16. Risks carried into implementation (from 99-critic §12.7)

1. Duplicate or unsafe outbound: controlled by sections 4.3, 4.4 and 7; proven by T02, T07, T19, T20 tests.
2. Breadth vs truthfulness: section 12; lint and AT1 route crawl.
3. Tenant isolation: section 4.1, scoped client, generated tenant matrix.
4. Consent pipeline gap: P1 capture in T10 and T34; AT8.
5. Windows + OneDrive: section 1 and the T02 spike gate.
6. Provider fact drift: dated error map and integrations.md; raw values only.
7. Prompt injection reaching a send: C12, output policy, reply guard, approval default.
8. PDF/HTML parity and ₹: one render model, embedded font, extraction test.
9. Webhook verification: `arrayBuffer()` raw body, routing by object id, rank merge.
10. Extension legal exposure: M1 option A, no vendor code, honest verification level.

---

## Eng review record (gstack `/plan-eng-review`, 2026-10-15)

- Target: this plan (`docs/implementation-plan.md`) with `docs/PRD.md` and `docs/reviews/ceo-review.md`.
- Scope Challenge: 39 tasks, about 45 models, far above the 8-file / 2-service complexity gate. Structure question not asked: per the user's standing instruction (CEO D1, 2026-10-15: "ask only about decisions that materially change the product"), the arrangement (one Next.js app + one worker process, modular monolith) is recorded as an assumption. Result: scope accepted as-is.
- Sections 1-4 (Architecture, Code quality, Tests, Performance): covered by the CEO review section files (`reviews/ceo/01-arch.md`, `02-errors.md`, `04-tests.md`, `05-ops.md`) and consolidated into sections 4-9 and 15 of this plan; reviewer conflicts resolved by rulings C1-C20.
- Outside voice: Codex (gpt-6-astra, read-only) found 12 issues (10 High, 2 Medium): E1-E12. All accepted as contract fixes (no product change) and applied; see section 15.5 and ADR-35 to ADR-45.
- Version facts verified 2026-10-15 via npm registry and Context7 (Next.js 16 upgrade guide: proxy.ts, Node >= 20.9, TS >= 5.1; Prisma 7 SQLite adapter setup).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR | mode: HOLD_SCOPE, 0 critical gaps open |
| Outside Review | codex exec (gpt-6-astra) | Independent 2nd opinion | 2 | completed | CEO phase 6 findings, 6 resolved; Eng phase 12 findings, 12 resolved |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 12 issues, 0 critical gaps open |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** codex, plan-review phase (CEO and Eng), both completed; 18 findings total, all resolved.
- **VERDICT:** CEO + ENG CLEARED — ready to implement.

NO UNRESOLVED DECISIONS

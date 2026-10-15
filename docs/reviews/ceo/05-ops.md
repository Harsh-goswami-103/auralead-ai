# Sections 5, 7, 8, 9, 10: Quality, Performance, Observability, Deployment, Trajectory

## Section 5: Code Quality Review

### 5.1 Proposed module structure

```
src/
  app/                                 thin: parse -> authorize -> call service -> map result
    (public)/page.tsx                  landing (3D via dynamic import only)
    (public)/quote/[id]/page.tsx       share-token gated HTML quote
    (public)/docs/[[...slug]]/page.tsx
    dashboard/user/{page,leads,inbox,pricing,quotations}/...
    dashboard/employee/{page,leads,sheets,meta,extension,approvals,integrations,pipeline}/...
    dashboard/admin/{page,workspaces,users,productivity,audit,inspector}/...
    api/webhooks/{google-sheets,meta-ads,gmaps-extension,whatsapp,email}/route.ts
    api/quote/[id]/pdf/route.ts
    api/health/route.ts
  server/
    db/            client.ts (single PrismaClient + PRAGMAs), tx.ts (withTx + busy retry),
                   raw/claim-job.ts (all raw SQL lives here, dialect-aware)
    auth/          session.ts, actor-context.ts (ActorContext), guards.ts
                   (requireWorkspaceAccess, requireCapability, requireSuperAdmin)
    services/      leads/{ingest,normalize,dedupe,score}.ts
                   enrichment/website-fetch.ts (SSRF-safe fetch)
                   pricing/{catalog,compute-totals}.ts
                   quotes/{state-machine,versioning,share-tokens,render-model}.ts
                   messaging/{eligibility,dispatch,consent,suppression,window}.ts
                   approvals/, conversations/, campaigns/, call-requests/
                   automation/pipeline-config.ts (validated 5-stage graph)
                   audit/record.ts, metrics/*.ts, integrations/credentials.ts
    adapters/      ai/{anthropic,openai,local-deterministic}.ts + ai/port.ts
                   whatsapp/{cloud-api,demo}.ts, email/{resend,smtp,demo}.ts
                   meta-ads/{graph,demo}.ts, sheets/{apps-script,demo}.ts
                   pdf/react-pdf.ts, storage/local-fs.ts
                   registry.ts (mode + workspace config -> concrete adapter)
    jobs/          queue.ts (enqueue/claim/complete/fail/lease), registry.ts,
                   handlers/{lead-ingest,enrich,score,draft,dispatch-whatsapp,
                   dispatch-email,process-webhook,quote-expiry,quality-check}.ts
  worker/          index.ts (loop, heartbeat, shutdown), scheduler.ts
  lib/             money.ts, phone.ts, clock.ts, ids.ts, redact.ts, errors.ts,
                   logger.ts, correlation.ts, schemas/* (Zod shared by forms + routes),
                   domain/enums.ts
  components/      ui/ (shadcn), patterns/ (cards, tables, empty/error/confirm), three/
extension-bridge/  saas-sync.js, examples/*.json, README.md
prisma/            schema.prisma, migrations/, seed/*.ts
tests/             unit/, integration/, contract/, e2e/
```

### 5.2 Findings

| # | Sev | PRD clause | Finding | Remedy | Type |
|---|---|---|---|---|---|
| 5.1 | CRITICAL | Messaging "Free-form eligibility computed server-side at dispatch"; Employee "bulk selection + eligible/skipped counts" | Eligibility will get written three times: bulk-count preview, approval queue badge, worker dispatch. Drift between them is exactly how a Maps lead without opt-in reaches a template send (acceptance 8, 10). | One pure function `evaluateDispatchEligibility(input: EligibilityInput, clock: Clock): EligibilityResult` in `server/services/messaging/eligibility.ts`, returning `{eligible, channel, mode: 'template'\|'freeform'\|'none', reasons: ReasonCode[]}`. A loader `loadEligibilityInput(tx, workspaceId, leadId, channel)` gathers consent, suppression, window, takeover, workspace/global pause, quality pause, caps. UI previews call it through a server action; worker calls it inside the dispatch transaction. UI never computes eligibility. Table-driven unit tests own the matrix. | a |
| 5.2 | CRITICAL | AI/quote: "Server resolves prices... computes discount, tax, subtotal, total"; acceptance 6 "PDF matches HTML totals" | Totals will tempt recomputation in the HTML page, the PDF, the dashboard and the AI proposal path. | `computeQuoteTotals(items, pricingSnapshot, rules)` in `services/pricing/compute-totals.ts` runs only when a QuoteVersion is created/edited; results are persisted. HTML, PDF, metrics read persisted values through one `buildQuoteRenderModel(quoteVersion)`. Nothing recomputes at render time. | a |
| 5.3 | CRITICAL | "Separately runnable durable worker" | The `server-only` package throws when imported outside the React Server condition, so a plain Node worker importing services guarded by it will crash at boot. Services that call `cookies()`/`headers()` also break in the worker. | Services and adapters never import `next/*` or `server-only`. Request context arrives as an explicit `ActorContext` argument. Enforce with ESLint `no-restricted-imports` (`next/*`, `server-only` banned under `src/server/services`, `src/server/adapters`, `src/server/jobs`, `src/lib`). Put `server-only` only in `src/app/**` server modules and `server/auth/session.ts`. | a |
| 5.4 | WARNING | "Thin routes, application services" | Routes calling Prisma directly will skip tenant guards and audit. | ESLint rule: `@prisma/client` and `server/db/client` importable only from `src/server/**`. Every service mutation signature is `(ctx: ActorContext, input)`; `ctx.workspaceId` comes from server session/membership resolution, never from the body. | a |
| 5.5 | WARNING | DEMO: "Simulators call the same application services as live adapters" | Scattered `if (mode === 'DEMO')` branches inside services create two products. | Mode is resolved only in `adapters/registry.ts`. Services receive a port (`WhatsAppPort`, `EmailPort`, `AiPort`, `MetaAdsPort`). Demo adapters return realistic provider-shaped responses and emit simulated webhooks through the same `/api/webhooks/*` processing service. Grep check in CI: `APP_MODE` read only in `lib/config.ts` and `adapters/registry.ts`. | a |
| 5.6 | WARNING | Quote "States... explicit transitions"; Sales stages separate from consent/approval/delivery | State transitions spread across handlers. | One transition table per machine (`quotes/state-machine.ts`, `messaging/delivery-state.ts`, `approvals/state.ts`, `leads/stage.ts`) with `assertTransition(from, to)`. Delivery status uses a rank order so out-of-order callbacks never regress (`read` > `delivered` > `sent` > `pending`; `failed` is terminal unless provider says otherwise). | a |
| 5.7 | WARNING | Acceptance 9 "injected clock" | `new Date()` scattered makes window-boundary tests impossible. | `lib/clock.ts` exports `Clock` interface; ESLint bans `Date.now()`/`new Date()` without args in `src/server/**` except `clock.ts`. | a |
| 5.8 | WARNING | Lead ingestion "Phones -> E.164 (default region IN)" | Extension and Apps Script will be tempted to normalize client-side. | Server normalization in `lib/phone.ts` (libphonenumber-js, pinned) is authoritative; clients send raw values plus optional hint. Contract tests assert raw passthrough. | a |
| 5.9 | WARNING | Stack: "React Hook Form + Zod" | Duplicate schemas between form and route. | `lib/schemas/*` exports Zod schemas reused by RHF resolver and route parsing; server re-validates always. | a |
| 5.10 | OK | "Constrained automation pipeline (not a workflow language)" | Over-engineering risk: generic DAG executor. | Pipeline config is a Zod-validated ordered list of the 5 fixed stage kinds with per-stage options; React Flow is an editor over that list. Cycle and unknown-node rejection happens in `automation/pipeline-config.ts`. No DI container, no CQRS, no event sourcing, no plugin system. | a |
| 5.11 | OK | Entities list "combine when justified" | Recommended combinations: QuoteItem lives under `QuoteVersion` (add `QuoteVersion` explicitly; version binding needs it); `Suppression` as its own table (not a flag on Lead) since it is per channel + address; `JobAttempt` and `WorkerHeartbeat` added for Section 8; `ShareToken` table storing only token hashes. | Record in docs/decisions.md. | a |

Naming: tables singular PascalCase (Prisma default); enum values UPPER_SNAKE; money columns suffixed `Paise` (`unitPricePaise`, `totalPaise`); time columns suffixed `At`, always UTC; reason codes as stable string constants (`NO_WHATSAPP_OPTIN`, `WINDOW_EXPIRED`, `SUPPRESSED`, `HUMAN_TAKEOVER`, `WORKSPACE_PAUSED`, `GLOBAL_PAUSED`, `QUALITY_PAUSED`, `CAP_REACHED`).

---

## Section 7: Performance Review

### 7.1 Process and write topology

```
 next start (web)                       worker (node dist/worker.js)
   |  short write tx only                 |  claim = 1 atomic statement
   |  webhook: verify -> insert           |  provider HTTP OUTSIDE any tx
   |  WebhookEvent + Job -> 200           |  finalize = 1 short tx (claimToken match)
   v                                      v
 +-----------------------------------------------+
 | SQLite file (WAL)  busy_timeout=5000          |
 | many readers, ONE writer at a time            |
 +-----------------------------------------------+
   location: OUTSIDE OneDrive (e.g. %LOCALAPPDATA%\auralead\data\)
```

### 7.2 Findings

| # | Sev | PRD clause | Finding | Remedy | Type |
|---|---|---|---|---|---|
| 7.1 | CRITICAL | Security & ops "Document SQLite limits, storage" | The repo lives under OneDrive. OneDrive syncing `*.db`, `*.db-wal`, `*.db-shm` mid-write causes lock errors and can corrupt a WAL database. It also syncs PII and backups to cloud. | Default `DATABASE_URL` points outside the synced tree (`%LOCALAPPDATA%/auralead/data/app.db`), settable in `.env`. Same for `STORAGE_DIR` (PDFs) and `BACKUP_DIR`. Boot check: warn loudly if the resolved DB path contains `OneDrive`. Note in README that `node_modules`/`.next` inside OneDrive slows installs and builds. | a |
| 7.2 | CRITICAL | "Persistent jobs: transactional claiming" | No `SELECT ... FOR UPDATE` in SQLite; Prisma interactive transactions on SQLite begin DEFERRED, so a read-then-write claim can hit `SQLITE_BUSY` on lock upgrade, which `busy_timeout` does not resolve. | Claim with a single statement in `server/db/raw/claim-job.ts`:<br>`UPDATE "Job" SET status='RUNNING', claimToken=$token, lockedUntil=$lease, attempts=attempts+1, startedAt=$now WHERE id=(SELECT id FROM "Job" WHERE status='QUEUED' AND runAt<=$now ORDER BY priority, runAt LIMIT 1) AND status='QUEUED' RETURNING *;`<br>Zero rows means lost race, loop. Finalize/fail with `WHERE id=? AND claimToken=?`; 0 rows = lease was stolen, discard result and log. Pause checks happen in the handler via eligibility (5.1), not only in the claim query. Same SQL works on PostgreSQL. | a |
| 7.3 | CRITICAL | "No blind resend after ambiguous timeouts" | Lease expiry reaper that blindly requeues a RUNNING send job resends. | Send handlers write `Message.dispatchAttemptedAt` + `idempotencyKey` in a committed tx before the HTTP call. Reaper rule: lease expired and `dispatchAttemptedAt` null -> requeue; set -> `AMBIGUOUS`, visible in inspector, resolved by provider status webhook (match by providerMessageId if returned) or explicit admin action. Resend uses `Idempotency-Key` where the provider supports it (verify Resend; WhatsApp Cloud API has no documented idempotency key, so treat as never-safe-to-retry after attempt). | a |
| 7.4 | WARNING | Same | Connection PRAGMAs. | In `server/db/client.ts` at startup, both processes: `journal_mode=WAL` (persistent), `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`. `withTx()` wrapper retries `SQLITE_BUSY`/P1008 up to 3 times with jittered backoff and logs each retry (metric for 8.x). Interactive transactions must issue their first write before any read where possible, and must never contain network I/O. Prisma 7 with the better-sqlite3 driver adapter is native: pin it, verify Windows prebuilt for Node 22, and list it in `serverExternalPackages`. | a |
| 7.5 | WARNING | "Paginate; index tenant lookups" | Index set needed from day one (all prefixed by `workspaceId`). | Lead: `@@unique([workspaceId, source, providerRecordId])`, `@@index([workspaceId, stage, createdAt])`, `@@index([workspaceId, phoneE164])`, `@@index([workspaceId, emailNormalized])`, `@@index([workspaceId, score])`, `@@index([workspaceId, nameNormalized])`. LeadSourceRecord: `@@unique([workspaceId, source, externalId])`. Message: `@@unique([provider, providerMessageId])`, `@@unique([idempotencyKey])`, `@@index([conversationId, createdAt])`. Conversation: `@@index([workspaceId, lastInboundAt])`, `@@index([workspaceId, leadId, channel])`. Job: `@@index([status, runAt, priority])`, `@@unique([dedupeKey])`, `@@index([workspaceId, status])`. WebhookEvent: `@@unique([provider, externalEventId])`, `@@index([status, receivedAt])`. AuditEvent: `@@index([workspaceId, createdAt])`, `@@index([actorUserId, createdAt])`, `@@index([targetType, targetId])`. Quote: `@@index([workspaceId, status, updatedAt])`. ShareToken: `@@unique([tokenHash])`. Membership: `@@unique([userId, workspaceId])`. EmployeeAssignment: `@@unique([employeeUserId, workspaceId])`. Suppression: `@@unique([workspaceId, channel, addressNormalized])`. ConsentRecord: `@@index([workspaceId, leadId, channel, createdAt])`. Contact dedupe indexes stay non-unique: conflicts go to review, and SQLite treats NULLs as distinct anyway. | a |
| 7.6 | WARNING | Leads "search/filter/sort/paginated table + Kanban" | Prisma `mode: 'insensitive'` is unsupported on SQLite; SQLite `LIKE` folds ASCII only. Kanban that loads all leads will degrade. | Store `nameNormalized`/`emailNormalized` (lowercased, NFKC, trimmed) on write; search on those. Keyset pagination on `(createdAt, id)` for leads, audit, messages, jobs; page size max 100. Totals via separate `count` capped at 10,000 ("10,000+"). Kanban loads 50 per column with per-column cursor. | a |
| 7.7 | WARNING | Client/admin command centers "DB-derived counts... funnel... pipeline value vs confirmed revenue" | N+1 risk from per-lead or per-workspace loops in widgets. | `services/metrics/*.ts`: one `groupBy`/aggregate query per widget, scoped by workspace (admin: grouped by `workspaceId`). Each metric has a definition string exported alongside it (also shown in UI tooltips, satisfies "explicit definitions"). No rollup tables in MVP; revisit beyond ~250k leads. Integration test asserts query count per dashboard load via Prisma query event counter (budget: under 15 queries). | a |
| 7.8 | WARNING | "Real downloadable PDF... matches HTML totals" | Headless Chromium: 150 to 300 MB per instance, 1 to 3 s cold, Linux system deps, bundling pain. pdf-lib: manual layout for line items and wrapping. | Use `@react-pdf/renderer` (pure JS, identical on Windows and Linux). Render from the same `buildQuoteRenderModel` as the HTML page. Register an embedded font with the Rupee glyph (e.g. Noto Sans); built-in Helvetica lacks U+20B9 and renders blanks. Cache output at `STORAGE_DIR/quotes/{workspaceId}/{quoteId}/v{n}-{contentHash}.pdf`; version content is immutable so cache never invalidates. Render on first request in the route handler with a 10 s timeout, behind a `QuotePdfRenderer` port. Test: extract text (pdfjs-dist) and assert total, version number, quote ID. | a |
| 7.9 | WARNING | Visual design "Lazy-load WebGL, pause offscreen/hidden, cap DPR and particles" | three + r3f + drei is several hundred KB gz; leaking into dashboards would hurt every panel. | 3D only via `next/dynamic(..., { ssr:false })` from `components/three/*`; static poster image is the LCP element. Budgets enforced with `@next/bundle-analyzer` report in CI: landing first-load JS under 250 KB gz excluding the deferred 3D chunk; dashboard routes contain no `three` modules. Load 3D after `requestIdleCallback` and only if `matchMedia('(prefers-reduced-motion: no-preference)')`, WebGL2 available, and `navigator.hardwareConcurrency >= 4`. `dpr={[1, 1.5]}`, particle cap about 4k desktop and 1.5k mobile, `frameloop` paused via IntersectionObserver + `visibilitychange`. Recharts and React Flow lazy-loaded per route too. | a |
| 7.10 | WARNING | Ingestion "Validate... payload size" | Route handlers read the whole body; an oversized extension batch is fully buffered before rejection. | Reject on `Content-Length` over limit before reading; stream-read with a byte counter for chunked bodies. Limits: extension 200 records / 1 MB, Sheets 1 row / 64 KB, Meta 256 KB. Webhook routes do verify + insert + enqueue only and return 200 in under 1 s; processing happens in the worker. | a |
| 7.11 | WARNING | "Rate limits on public/auth/ingestion" | A SQLite-backed limiter adds a write per request on the single writer. | In-process sliding-window limiter (LRU map) for MVP, documented as single-instance only; replace with Postgres/Redis on the PostgreSQL path. Not a job timer, so it does not violate the "no in-memory timers" rule. | a |
| 7.12 | OK | Memory limits | Local dev runs `next dev` + worker + Playwright together. | Worker default concurrency 1 (configurable to 4 for provider-bound jobs; writes stay short). Poll interval 1 s idle with backoff to 5 s. No Chromium at runtime (7.8) keeps the worker under about 150 MB. Use Playwright's single browser project locally; full matrix in the acceptance run. | a |

---

## Section 8: Observability & Debuggability Review

### 8.1 Correlation flow

```
browser / extension / provider
   | x-request-id (generated in middleware; inbound value kept as clientRequestId)
   v
route wrapper withRoute()  -- AsyncLocalStorage{correlationId, workspaceId, actorId, mode}
   v
service --> AuditEvent.correlationId
   |--> Job{correlationId, causationId=parent job/request}
                 v
          worker loads ctx into ALS on claim
                 v
          adapter call --> JobAttempt{correlationId, provider, providerRequestId, httpStatus, durationMs}
                 v
          Message{providerMessageId, correlationId}
                 ^
provider status webhook --> WebhookEvent --> match providerMessageId --> same correlationId
```

Note: Next middleware cannot hand an AsyncLocalStorage context to the route handler, so middleware only sets the header and `withRoute()` / `withAction()` read it and open the ALS scope.

### 8.2 Findings

| # | Sev | PRD clause | Finding | Remedy | Type |
|---|---|---|---|---|---|
| 8.1 | CRITICAL | Security & ops "Structured logs with correlation IDs; no stack traces/tokens to users" | Needs a concrete contract or it will be inconsistent across web and worker. | `lib/logger.ts` on pino, no transports (worker-thread transports break under Next bundling); dev pretty via `pino-pretty` pipe. Fields: `ts, level, msg, service(web\|worker), mode, correlationId, causationId, jobId, jobType, workspaceId, actorUserId, provider, providerRequestId, durationMs, outcome, errorCode`. `redact` paths: `*.token, *.accessToken, *.apiKey, *.secret, *.authorization, *.password, *.phone*, *.email*, *.body.text`, plus `lib/redact.ts` applied before persisting any payload. Users see `{code: 'AL-xxxx', message, reference: correlationId}`, never stacks. Test: log capture over a full simulated flow contains no seeded secret, phone or email literal. | a |
| 8.2 | CRITICAL | Admin "webhook/job inspector (redacted payloads, attempts, errors, safe retry, cancellation, queue health)" | Attempts need persistent per-attempt records, not just a counter. | Tables: `JobAttempt(jobId, attempt, startedAt, finishedAt, outcome[SUCCEEDED\|RETRYABLE\|FATAL\|AMBIGUOUS], errorCode, errorRedacted, providerHttpStatus, providerRequestId, durationMs, correlationId)` and `WorkerHeartbeat(workerId, pid, hostname, version, mode, startedAt, lastBeatAt, currentJobId)` written every 10 s. Webhook rows store redacted JSON + SHA-256 of raw body + verification result; raw body is never stored. | a |
| 8.3 | WARNING | Same, "queue health" | Metrics need definitions. | Panel (DB-derived, refresh 10 s): worker status (green if a heartbeat is under 30 s old, else "Worker not running" with the start command); queued by type; running; oldest queued age; retry-wait count; failed and dead in 24 h; AMBIGUOUS count (highlighted); throughput per hour (24 h sparkline); p50/p95 duration per type over the last 200 attempts; SQLITE_BUSY retries per hour; webhook events by status (received/verified/rejected/processed/failed) and signature rejections in 24 h; global outbound pause and paused-workspace count; per-provider last quality/limits check time and value or "Unknown". | a |
| 8.4 | WARNING | Same, "safe retry, cancellation" | "Retry" on an ambiguous send equals blind resend. | Actions by state: QUEUED/RETRY_WAIT -> Cancel. FAILED/DEAD with `retrySafe=true` -> Retry (new attempt, same dedupeKey). AMBIGUOUS -> "Mark delivered" or "Mark not sent and requeue", each requiring a typed reason, re-running eligibility and suppression, audited. Every inspector action is an AuditEvent with `crossWorkspace=true` when applicable. Filters: workspace, type, status, correlationId, provider, date range. Detail shows a correlation timeline (request -> jobs -> attempts -> webhooks -> audit) joined on correlationId. | a |
| 8.5 | WARNING | "Unavailable integration shows Not configured / Verification required" | Integration failures need a stored last-check state, not log lines. | `Integration.status`, `lastCheckedAt`, `lastErrorCode`, `lastErrorRedacted`; connection-test results persisted; Integration center reads these. | a |
| 8.6 | OK | `/api/health` | Needed for smoke tests and for the worker panel. | Public: `{status, mode}` only. Super-admin: DB reachable, pending migrations count, worker heartbeat age, queue depth, disk free for DB dir. | a |

### 8.3 Runbooks (ship in `/docs/troubleshooting` and `docs/runbooks.md`)

| Failure mode | Signal | Action |
|---|---|---|
| Worker not running | Heartbeat older than 30 s; oldest queued age rising | Start `npm run worker`; leased jobs auto-reclaim; ambiguous sends surface in inspector |
| DB locked | SQLITE_BUSY retries per hour spike | Check for long transactions in logs (`durationMs` on tx); confirm DB not on OneDrive; reduce worker concurrency to 1 |
| Job stuck RUNNING | `lockedUntil` in the past | Reaper requeues or marks AMBIGUOUS per 7.3; inspect attempt |
| Ambiguous send | AMBIGUOUS count above 0 | Wait for status webhook (auto-resolves by providerMessageId); else check provider console, then mark delivered or not sent |
| Meta signature rejects | Signature rejection count rises | App secret rotated or wrong app; re-enter secret, test with Meta dashboard test event |
| Meta/WhatsApp token expired | Provider auth error (verify current code list) | Integration -> Verification required; rotate token; queued sends defer, not fail |
| Outside 24 h window | Provider re-engagement error | Eligibility should have prevented it: treat as bug, check clock skew and `lastInboundAt`; message returns to review |
| Throughput/limit errors | Provider rate-limit codes | Backoff applied; per-workspace defer; no email fallback unless independently eligible |
| Quality drop / template paused | Quality check job result | Automated WhatsApp paused for that number; notify in Integration center |
| Email bounce spike | Bounce events over threshold | Auto-suppress hard bounces; review list hygiene |
| AI provider 429/timeout (LIVE) | AI attempt errors | Draft stays in review with error; no silent switch to local generator in LIVE |
| Extension batch partial failure | Batch status PARTIAL | Per-record errors shown in Extension hub; extension retries only failed record IDs |
| Credential decrypt failure | `CREDENTIAL_DECRYPT_FAILED` | Wrong or rotated `ENCRYPTION_KEY`; restore the key ring entry; never log ciphertext |
| PDF render failure | `PDF_RENDER_FAILED` | Missing font file or invalid render model; HTML quote still works |
| Backup failure / disk low | Health disk free; backup script exit code | Free space; rerun `npm run db:backup` |

---

## Section 9: Deployment & Rollout Review

No deployment is authorized in this task. Everything below is local scripting plus the documented future path.

| # | Sev | PRD clause | Finding | Remedy | Type |
|---|---|---|---|---|---|
| 9.1 | CRITICAL | Stack "Document real PostgreSQL migration steps" | Prisma's `datasource.provider` must be a literal and `migration_lock.toml` pins the provider, so one migrations folder cannot serve both databases. | Keep `prisma/schema.prisma` (sqlite) as source. `scripts/gen-pg-schema.ts` emits `prisma/postgres/schema.prisma` (provider swap plus `@db.*` annotations) with its own `prisma/postgres/migrations/` baseline created at cutover. CI job (later) runs `prisma validate` on both. | a |
| 9.2 | CRITICAL | Acceptance 1 "Fresh documented setup starts app + worker" and seed "deterministic resettable" | Fixed-date seed rots: "open window" leads expire a day after seeding; relative-to-now seed is not deterministic for tests. | Seed takes `SEED_NOW` (default: current time floored to the hour) and builds all timestamps relative to it; IDs from a seeded generator. Tests pin `SEED_NOW=2026-10-01T06:30:00Z` and inject the same clock. `npm run db:reset` = `prisma migrate reset --force` + seed, guarded: refuses unless `APP_MODE=demo` and the DB path is under the configured data dir. | a |
| 9.3 | WARNING | "Separate tenant and demo/live data; simulations cannot touch live data" | Same DB with a flag is one bug from crossing. | One process runs one mode (`APP_MODE`). Separate DB files (`demo.db`, `live.db`). Defense in depth: `Workspace.mode` column checked by every simulation action and by the adapter registry. Role switcher route returns 404 in LIVE. | a |
| 9.4 | WARNING | Migrations | Common drift traps. | Use `prisma migrate dev` only, never `db push` after milestone 1. Applied migrations are never edited. Partial unique indexes (one active ShareToken per quote version, one APPROVED Approval per QuoteVersion, one open Conversation per lead+channel) are added by hand-written SQL in migration files with a comment, since Prisma schema cannot express them; re-add in the PG baseline. Windows: stop web and worker before `prisma generate`/`migrate`, or the native engine/adapter file is locked (EPERM). | a |
| 9.5 | WARNING | "Document... worker lifecycle" | Windows does not deliver SIGTERM on `taskkill /F`; graceful shutdown cannot be relied on. | Worker: `npm run worker` (tsx) in dev, `node dist/worker.js` built with tsup in prod mode; `npm run dev:all` via concurrently. On SIGINT/SIGTERM: stop claiming, finish current job up to 25 s, release lease. Correctness relies on lease expiry (60 s, heartbeat-extended) and 7.3, not on shutdown hooks. Scheduled work (quote expiry, quality checks) is enqueued with `dedupeKey` per time bucket (`quote-expiry:2026-10-15T10`) so multiple workers never duplicate it. Worker refuses to start if pending migrations exist. | a |
| 9.6 | WARNING | "Document... backups, credential rotation" | Copying a WAL DB file alone loses committed data. | `npm run db:backup` runs `VACUUM INTO '<BACKUP_DIR>/app-YYYYMMDD-HHmm.db'` (consistent online snapshot), keeps 7 daily and 4 weekly. Restore: stop web and worker, replace file, delete `-wal`/`-shm`, start, run smoke. Backups hold PII and encrypted creds; default `BACKUP_DIR` outside OneDrive. `ENCRYPTION_KEY` is a key ring (`ENCRYPTION_KEYS=v2:...,v1:...`, ciphertext prefixed with key id); `npm run creds:rotate` re-encrypts to the newest key. Losing all keys means re-entering provider credentials: documented. | a |
| 9.7 | WARNING | INR "integer minor units" | SQLite INTEGER is 64-bit, PostgreSQL `Int` is 32-bit: a field caps at about Rs 2.14 crore in paise. | Keep Prisma `Int` for line and quote amounts with a validated cap of Rs 1 crore per quote in `compute-totals.ts` (clear error, routes to review). Aggregates are computed in SQL (PG `SUM(int)` returns bigint) and returned as numbers. Revisit with `BigInt` if a workspace needs larger quotes. | a |
| 9.8 | OK | Rollback | Forward-only migrations. | Every migration is expand-then-contract (add nullable column, backfill, enforce later). Rollback order: enable global outbound pause, stop worker, redeploy previous build; if schema incompatible, restore pre-migration backup (data since backup lost, so backup immediately before `migrate deploy`). | a |

### 9.1 PostgreSQL migration path (for `docs/deployment.md`)

| Area | SQLite (local) | PostgreSQL | Action |
|---|---|---|---|
| Enums | Prisma enums stored as TEXT | Native enum types | Keep enum values stable; new values need their own migration |
| Case-insensitive search | `LIKE` ASCII-only; no `mode:'insensitive'` | `ILIKE`, `citext`, `pg_trgm` | Normalized columns already portable; optional trigram index later |
| JSON | Stored as text; path filtering limited | `jsonb` | Rule: never filter on JSON; filterable data gets real columns |
| DateTime | Storage format depends on Prisma engine/adapter config | `timestamptz(3)` | Raw SQL binds `Date` parameters only, never string literals; test claim query on both |
| Partial unique indexes | `CREATE UNIQUE INDEX ... WHERE` in raw migration | Same syntax | Re-add in PG baseline by hand |
| Integers | 64-bit | `Int` = int4 | See 9.7 |
| Booleans | 0/1 | boolean | Script casts |
| Job claim | Atomic UPDATE...RETURNING | Same, optionally `FOR UPDATE SKIP LOCKED` | Dialect switch inside `db/raw/claim-job.ts` only |
| Identifiers | Case-insensitive | Quoted, case-sensitive | Raw SQL always quotes `"Job"` |

Data migration: prefer a TypeScript script `scripts/migrate-sqlite-to-pg.ts` with two generated Prisma clients, copying tables in foreign-key order in 1,000-row batches with preserved string IDs, then verifying row counts per table and checksums of `SUM(totalPaise)` per workspace. pgloader is an alternative but needs Docker/WSL on Windows and explicit casts for Prisma's DateTime, booleans and enums. Cutover: global outbound pause on, stop worker, backup, `prisma migrate deploy` on PG, copy, verify, switch `DATABASE_URL`, start web and worker, smoke, resume outbound.

Deployment changes on PG: worker becomes its own service; PDFs move from local FS to object storage behind the `storage` port; in-process rate limiter replaced (7.11); connection pool sizing (web 5 to 10, worker 2 to 4); `output: 'standalone'` with native/adapter packages in `serverExternalPackages`; public HTTPS URLs for webhooks; secrets from the platform's secret store.

### 9.2 Post-build smoke checklist (local `next build && next start` + worker)

1. `GET /api/health` 200; super-admin view shows heartbeat under 30 s and 0 pending migrations.
2. Every route in the role switcher returns 200 with no console errors.
3. Each source simulation creates lead + source record + job + audit; reload persists.
4. Quote PDF downloads, opens, total and version match HTML.
5. Public quote: valid token 200; revoked and expired tokens rejected.
6. Webhook with bad signature returns 401 and is counted.
7. Global outbound pause stops a queued demo dispatch.
8. Client bundle grep of `.next/static` for env names and key prefixes (`sk-ant`, `sk-`, `re_`, `EAA`, `ENCRYPTION_KEY`) finds nothing.
9. Logs show correlationId through request -> job -> attempt for one flow.
10. Landing loads its static fallback with WebGL disabled and with reduced motion.

---

## Section 10: Long-Term Trajectory Review

### 10.1 Deliberate debt (record in docs/decisions.md)

| Debt | Why acceptable now | Payoff trigger |
|---|---|---|
| SQLite single writer | Zero-cost local demo; PRD default | Any trigger in 10.3 |
| Polling worker (1 to 5 s) | Simple, restart-safe | Latency SLO under 1 s, or PG (then LISTEN/NOTIFY or pg-boss) |
| In-process rate limiter | Single instance | Second web instance |
| Local-FS PDF and storage | Behind port | Any hosted deploy |
| Dual Prisma schemas | Unavoidable with provider literal | Retire SQLite schema after PG cutover |
| React Flow graph stored as JSON over fixed stages | Constrained scope | Add `configVersion` now so later stage kinds migrate cleanly |
| Copied UI-pattern components (Aceternity/Magic UI style) | Speed | Keep license attribution file; owned code, no upstream updates |
| Provider API versions pinned (Graph API version, Resend, AI model IDs) | Dated in docs/integrations.md | Quarterly re-verification; model IDs are config, not code |

### 10.2 Reversibility (1 = locked in, 5 = trivially swappable)

| Decision | Score | Note |
|---|---|---|
| Money as integer paise + rounding rule | 1 | Issued quotes freeze it; get it right in milestone 2 |
| `workspaceId` on every tenant row + guard pattern | 1 | Retrofit is a rewrite |
| Audit, idempotency keys, correlation IDs, QuoteVersion binding | 1 | Must exist from milestone 1 to 2; cannot be backfilled honestly |
| Next.js App Router | 2 | Services stay framework-free (5.3), which raises effective reversibility |
| Prisma | 2 | Raw SQL isolated in `db/raw` |
| Auth/session library | 3 | Behind `server/auth` |
| Demo/live separation by DB file | 3 | |
| DB-backed job queue | 4 | Behind `jobs/queue.ts`; pg-boss swap possible |
| SQLite to PostgreSQL | 4 | Path documented in 9.1 |
| PDF library | 4 | Behind `QuotePdfRenderer` |
| Provider adapters (AI, WhatsApp, email, Meta) | 5 | Ports + registry |

### 10.3 The 12-month question

"In 12 months, with about 50 workspaces, 100k leads and live WhatsApp, what breaks first and did this plan make it cheap to fix?"

1. Write contention from provider status webhooks (each outbound message brings 2 to 4 callbacks). PostgreSQL triggers, defined now in docs/deployment.md: sustained over 5 writes/s, SQLITE_BUSY retries over 1% of transactions, DB over 2 GB, need for a second instance or HA. Cheap because of 7.2, 9.1 and 10.2.
2. Provider policy and pricing drift (WhatsApp template categories, pricing model, rate-limit codes). Mitigated by dated docs/integrations.md, stored template metadata fetched from the provider, and no hardcoded tiers (PRD already requires this).
3. Data protection obligations (consent evidence export, retention, deletion requests) under India's DPDP regime. ConsentRecord and AuditEvent design must support per-lead export and erasure that preserves redacted audit. Verify the current DPDP Rules status when writing `/docs` data/export/retention; record it as an assumption, not legal advice.
4. Metric trust. If dashboard numbers drift from stored records, users stop trusting the product. Single metric definitions (7.7) and the query-count test hold this.

Material decisions for the user from Sections 5, 7, 8, 9 and 10: none. Every finding above is an assumption or implementation requirement that can be recorded without asking. The closest candidate is 9.3 (separate demo and live databases, one mode per process). It stays an assumption because it changes how the product is deployed, not what it does.
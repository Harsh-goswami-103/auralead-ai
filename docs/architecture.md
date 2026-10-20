# Architecture

How AuraLead AI is put together as built today. The locked design is
[implementation-plan.md](implementation-plan.md) section 4; deviations are ADRs in
[decisions.md](decisions.md). Checked against the code on 2026-10-20.

## Processes

Two processes per mode, sharing one SQLite file:

- **Web**: one Next.js 16 app (App Router, Node runtime everywhere). Pages render on the server per
  request; every change goes through a route handler under `/api/app/*` or `/api/admin/*` (no
  Server Actions, ADR-26). Webhooks, the public quotation page and the health check are route
  handlers too.
- **Worker**: `worker/index.ts`, run with `npm run worker` in development and as `dist/worker.js`
  after `npm run build`. It has no HTTP listener. It claims persistent jobs from the database,
  runs them through the same services the web app uses, and writes a heartbeat row every 10 s.

```
 BROWSERS AND CALLERS
 +-------------+ +------------------+ +----------------+ +-------------------------------+
 | Landing,    | | Panels           | | /quote/<token> | | WhatsApp and email webhooks,  |
 | /docs       | | user / employee  | | (share token,  | | DEMO simulators               |
 | (public)    | | / admin (cookie) | |  no cookies)   | | (signature or DEMO session)   |
 +------+------+ +--------+---------+ +-------+--------+ +---------------+---------------+
        |                 | cookie + CSRF     | form nonce               | raw body
 =======v=================v===================v==========================v===============
 NEXT.JS (one process, one APP_MODE)
   src/proxy.ts      request id, nonce CSP, HSTS. No auth, no rate limit, no database.
   pages             getPageContext -> services (read) -> render
   route handlers    withRoute: mode gates -> raw body cap -> auth -> role / re-auth
                     -> rate limit -> CSRF / Origin -> identity check -> zod -> capability
                     -> service -> typed result -> HTTP
 ---------------------------------------------------------------------------------------
   server/auth (ctx) -> server/services (state + audit) -> lib (pure: money, window, ...)
                               |                 \
                               v                  -> adapters (registries) -> demo | live
                        server/db (tenant-scoped Prisma, withTx, fence, raw claim SQL)
 ===============================|=======================================================
                                v
              +-------------------------------------------+
              | SQLite  <data dir>/<mode>/app.db          |  WAL, busy_timeout 5000 ms,
              |                                           |  foreign keys on; one writer
              +-------------------------------------------+
                                ^
 ===============================|=======================================================
 WORKER (no HTTP listener)
   loop: reaper -> claim (one UPDATE ... RETURNING) -> handler(job ctx) -> settle (fenced)
   handlers call the same services; provider calls never run inside a transaction
   PDF: @react-pdf/renderer -> <storage>/quotes/<workspaceId>/<quoteVersionId>.pdf
   heartbeat every 10 s; honors the admin pause, outbound.lock and OUTBOUND_PAUSED=1
```

## Layers and import rules

| Layer | Path | Rule |
|---|---|---|
| App | `src/app/` | Thin: parse, build the request context, call a service, map the result. Never Prisma directly. |
| Auth and context | `src/server/auth/` | Builds the request context; sessions, invites, password resets, guards. |
| Services | `src/server/services/` | The only writers of state. Every function takes `(ctx, input)`. |
| Adapters | `src/server/adapters/` | Provider ports with demo and live implementations; never import services. |
| Jobs | `src/server/jobs/` | Queue, claim, settle, reaper, backoff, handler registry. |
| Database | `src/server/db/` | Client with PRAGMAs, tenant-scoped client, busy-retrying transactions, lease fence, raw claim SQL. Importable only from the server, worker, seed, scripts and tests. |
| Library | `src/lib/` | Framework-free: config, paths, clock, money, phone, errors, redaction, schemas. |

Services, adapters, jobs, security and PDF code never import Next.js, so the worker can load them.
Server and worker code never read the wall clock directly (`Date.now()` is a lint error there); they
use the injected clock. ESLint and `tests/unit/arch/import-boundaries.test.ts` enforce these rules.

## The request context

`src/server/auth/context.ts` builds one context per request or job: the kind (user, job, system,
public, webhook), the correlation id (from `x-request-id`, or new), the mode from the process
configuration, the actor, the workspace, the capabilities, the actor's discount cap, the clock and
a tenant-scoped database client. The workspace is resolved on the server (session membership, the
employee assignment named in the address, the job's row, or the integration of a webhook). A
`workspaceId`, `userId` or `role` sent by the browser that differs from it is a 404. A super admin
reaches tenant data only through `adminContext`, which writes its audit event first.

## Request flow

1. `src/proxy.ts` sets the request id and the document headers (a per-request script nonce CSP,
   HSTS behind HTTPS, ADR-69). It never authorizes, rate-limits or reads the database.
2. A page calls `getPageContext`, which loads the session and builds the context; pages without a
   session redirect to `/login`, records outside the caller's reach are `notFound()`.
3. A route handler is wrapped by `withRoute` (`src/app/api/_lib/with-route.ts`) in this order: mode
   gates (DEMO-only and test-control routes answer 404 otherwise), the raw body with its size cap,
   authentication, role and re-authentication, rate limits, CSRF (Origin plus the signed token for
   cookie requests, Origin alone for cookie-less ones), the browser identity check, Zod
   validation, the capability, then the handler. Errors become `{ code, message, reference }`;
   every response carries `x-request-id` and `Cache-Control: no-store`.
4. The service runs its writes in `withTx` (busy-retrying, takes the write lock first) and records
   the audit event in the same transaction.

## Modes

`APP_MODE` is read only in `src/lib/config.ts` (and the adapter registries take the mode from the
context). One process serves one mode and opens `<data dir>/<mode>/app.db`.

- **DEMO**: seeded identities and a role switcher, source and customer simulators, the local
  deterministic AI generator, demo transports for WhatsApp and email, and an outbound guard
  (`src/server/adapters/http/outbound.ts`) that refuses every host.
- **LIVE**: invitation-only accounts, no simulators or test routes (404), no role switcher in the
  bundle (`NEXT_PUBLIC_APP_MODE` is compiled in), and a start-up refusal without the secrets, with
  test control on, or on a plain-HTTP public origin (`src/server/boot.ts`). Missing provider
  credentials give a `NOT_CONFIGURED` or `AI_NOT_CONFIGURED` result, never a demo transport.

## Worker and jobs

- **Claim**: one `UPDATE ... RETURNING` statement (`src/server/db/raw/claim-job.ts`) picks the next
  due `QUEUED` job whose `serialKey` is not already running, sets it `RUNNING` with a fresh claim
  token and a 60 s lease, and counts the attempt. Zero rows means another worker won the race.
- **Fence**: every write a job makes starts with a fence statement that checks its claim token
  (`src/server/db/fence.ts`). A worker that lost its lease fails before writing or calling a
  provider.
- **Lease and heartbeat**: long jobs extend the lease every 20 s; the worker heartbeat row is
  written every 10 s, and Platform admin reports "Worker not running" after 30 s without one.
- **Reaper**: a `RUNNING` job past its lease is requeued with backoff, unless a send of that job is
  `SENDING`: then the send becomes `AMBIGUOUS` and the job `DEAD`, never retried blindly.
- **Retries**: backoff from 5 s doubling to 15 minutes with jitter; at most 5 attempts for sends,
  3 for AI and PDF jobs, 8 for website fetches, 5 otherwise, then `DEAD` with a redacted error.
  Deferrals (pause, internal cap) wait without using an attempt.
- **Idempotency**: every job has a unique idempotency key; enqueueing it twice returns the first.
  Payloads hold ids and a payload version only, never secrets.
- **Shutdown**: SIGINT, SIGTERM and SIGBREAK stop claiming and let the current job finish for up to
  25 s. Correctness never depends on a clean stop.

Job types registered in `src/server/jobs/registry.ts`: `pipeline.advance`, `ingest.process`,
`lead.enrich`, `lead.score`, `lead.rescore`, `ai.draft`, `quote.renderPdf`, `quote.expireSweep`,
`dispatch.whatsapp`, `dispatch.email`, `webhook.process`, `status.apply`, `reply.auto`,
`bulk.run`, `webhook.purge` and `suppression.journalReconcile`. A claimed job of an unknown type
goes `DEAD`.

## The outbox

Every provider send goes through one table of dispatch attempts and three short transactions, with
no network call inside any of them (`src/server/services/messaging/dispatch.ts`):

1. **Claim** the job (above).
2. **Preflight** (fenced): load the eligibility input and run the shared eligibility check with the
   attempt's stored send intent, recompute the approval's payload hash, and require the current
   quotation version and its PDF. Failure skips or cancels the attempt with a reason code, or
   defers it. Success marks the attempt `SENDING` and commits.
3. **Provider call**, outside any transaction.
4. **Settle** (fenced): `SENT` with the provider message id, the message, the lead stage (forward
   only), the quotation (only if it is still on the version that was sent), the audit event.

A definite failure before the request was written, or a provider rejection that is safe to repeat,
fails the attempt and retries as a new attempt that runs the preflight again. A permanent rejection
ends it. A timeout after the request was written makes it `AMBIGUOUS` ("Delivery unknown"), resolved
only by a matching provider status or by an operator.

## Pipeline

Ingestion enqueues one `pipeline.advance` per new lead and nothing else. The executor
(`src/server/services/pipeline/executor.ts`) runs the stages of the lead's pinned pipeline version
in order (`INGESTION`, `SCORE`, `DRAFT`, `APPROVAL`, `DELIVERY`), recording one stage run per stage
and execution, so replays and restarts never repeat a stage.

## Webhooks

The body is read once as raw bytes with a size cap and verified before parsing. An accepted
delivery is stored as a webhook event with a redacted inspector view and an AES-256-GCM encrypted
processing copy (bound to the event id), deduplicated per provider, source scope and external id.
The worker decrypts only the processing copy; `webhook.purge` deletes it after the retention window.
A WhatsApp Stop is applied inside the receiving request, before the response.

## Data

`prisma/schema.prisma` is the source of truth; partial unique indexes Prisma cannot express are
hand-written in the migrations. Every tenant table carries `workspaceId`, and the scoped client adds
it to every query. Money is integer paise (`BigInt`), rates are basis points, times are UTC. The
suppression journal and quotation PDFs are files in the data folder ([deployment.md](deployment.md)).

## Tests

Vitest projects `unit`, `integration` (a real SQLite file per test file in the temp folder) and
`components` (jsdom); Playwright against built DEMO and LIVE apps. `src/server/routes.manifest.ts`
lists every page and route with the status each kind of caller must get;
`tests/unit/arch/route-manifest.test.ts` keeps it complete and
`tests/integration/authz/tenant-matrix.test.ts` runs it against another workspace's records.

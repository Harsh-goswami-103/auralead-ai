# Section 1 Architecture + Section 4 Data Flow & Interaction Edge Cases

## Section 1: Architecture Review

### 1.1 System architecture

```
                         BROWSERS / EXTERNAL CALLERS
 +-------------+  +-------------+  +-------------+  +-----------------+  +-------------------+
 | Landing /   |  | Panels      |  | Public quote|  | MV3 extension   |  | Providers         |
 | Docs (RSC)  |  | user/emp/adm|  | /quote/[tok]|  | saas-sync.js    |  | Meta, WA, Resend, |
 |             |  | (cookie+CSRF)| | (share tok) |  | (Bearer ingest) |  | Apps Script (HMAC)|
 +------+------+  +------+------+  +------+------+  +--------+--------+  +---------+---------+
        |                |                |                  |                     |
 =======v================v================v==================v=====================v=========
 NEXT.JS APP (runtime=nodejs on every route handler; never Edge: raw body, crypto, Prisma)
 ------------------------------------------------------------------------------------------
  src/middleware.ts        session decode, CSRF origin check, correlation-id, demo banner flag
  src/app/api/**           THIN route handlers: parse -> zod -> ctx -> service -> map result
    /api/app/*             tenant app API (session)          /api/admin/*   super admin (audited)
    /api/webhooks/google-sheets   /api/webhooks/meta-ads     /api/webhooks/whatsapp   [GAP W1]
    /api/webhooks/email/[provider]   /api/webhooks/gmaps-extension
    /api/quote-share/[tok]/{view,accept,pdf}                 /api/demo/{session,simulate/*}
 ------------------------------------------------------------------------------------------
  src/server/auth/         getRequestContext(): {userId, role, workspaceId(from membership),
                           capabilities, mode}; NEVER from body/query
  src/server/services/     application services (the ONLY place that writes state)
    leadIngestion  dedupe  scoring  enrichment  draftGeneration  pricing(quote calc)
    quoteLifecycle  approval  dispatch(planner)  conversation  consent  suppression
    campaign  integration  pipeline  audit  metrics  jobsAdmin
  src/server/domain/       PURE: money.ts (paise, rounding), quoteMath.ts, eligibility.ts,
                           waWindow.ts, stateMachines.ts, scoring.ts, phone.ts (libphonenumber)
  src/server/adapters/     interface + impls, selected per workspace.mode
    ai/{anthropic,openai,deterministic}   whatsapp/{cloudApi,demo}   email/{resend,smtp,demo}
    meta/{graph,demo}   sheets/{google,demo}   pdf/{chromium}   http/safeFetch (SSRF guard)
  src/server/crypto/       envelope encryption (keyId-versioned), mask()
  src/server/clock.ts      injectable Clock (tests drive boundaries)
  src/server/testing/pause.ts  named pause points, compiled to no-op unless NODE_ENV=test
 ==========================|===============================================================
                           | Prisma Client (one PrismaClient per process)
                           v
               +------------------------------+
               | SQLite file (WAL, busy_timeout)|  <- SINGLE WRITER LOCK shared by BOTH processes
               | outside OneDrive [A3]         |
               +------------------------------+
                           ^
 ==========================|===============================================================
 WORKER PROCESS  worker/index.ts  (npm run worker; separately runnable; no HTTP surface)
   loop: reclaimExpiredLeases -> claim(UPDATE..RETURNING) -> handler -> settle
   handlers/: ingest.process, meta.fetchLead, enrich.website, ai.draft, quote.renderPdf,
              dispatch.whatsapp, dispatch.email, webhook.process, status.apply,
              quote.expireSweep, integration.healthCheck, wa.qualityPoll, campaign.control
   PDF: chromium via Playwright, page.setContent(renderQuoteHtml(versionSnapshot))  [A8]
   heartbeat row WorkerHeartbeat(id, pid, lastBeatAt)  -> admin queue health
 ==========================================================================================
```

### 1.2 Dependency graph (allowed import direction only)

```
 app/(pages, api routes) --> server/auth --> server/services --> server/domain (pure)
                                                   |          \
                                                   v           --> server/adapters/* --> safeFetch, crypto
                                                 prisma
 worker/handlers --------------------------------> server/services (same services, no forks)
 server/domain     imports NOTHING from services/adapters/prisma
 adapters          import NOTHING from services (no callbacks into business logic)
 demo simulators   call services.* exactly like webhooks do (PRD "same application services")
```
Enforce this with an ESLint `no-restricted-imports` rule plus one Vitest check that walks the import graph. Severity WARNING, (a) assumption.

### 1.3 State machines

**Quote** (status lives on `Quote`; content lives on immutable `QuoteVersion` rows)

```
              edit (new version N+1, same status)
              +-----+
              v     |
           +-------+       approve(expectedVersion=N) CAS
  create ->| DRAFT |--------------------------------------+
           +-------+                                       v
              ^  ^     material edit -> v N+1,       +----------+
              |  +---- approval INVALIDATED, --------| APPROVED |
              |        queued dispatch CANCELLED     +----------+
              |                                         | dispatch ok / manual share
              |  revise (v N+1; old share tokens         v
              |  -> "superseded")                    +------+  first qualifying view  +--------+
              +--------------------------------------| SENT |------------------------>| VIEWED |
              +--------------------------------------+------+                         +--------+
              |  revise                                 |  accept(current ver, valid)     | accept
              |                                         v                                 v
              |                                    +----------+ <-------------------------+
              |                                    | ACCEPTED |  terminal; repeat accept = 200 same receipt
              |                                    +----------+
   now >= validUntil (sweeper + lazy check at read/accept): SENT|VIEWED|APPROVED -> EXPIRED
   cancel (user/employee): DRAFT|APPROVED|SENT|VIEWED -> CANCELLED (share tokens revoked)
   EXPIRED -> DRAFT only via explicit "revise & reissue" (new version, new validUntil)

 INVALID (service throws InvalidTransition, route returns 409, the attempt is audited):
   DRAFT->SENT, DRAFT->ACCEPTED, APPROVED->VIEWED, ACCEPTED->* (any), CANCELLED->*,
   EXPIRED->ACCEPTED, VIEWED->SENT (no regress), accept on a non-current version,
   approve with expectedVersion != currentVersion, approve when pricing review is pending
```

**Job**

```
            enqueue(idempotencyKey UNIQUE)
                  |
                  v
   +---------> queued --(cancel / suppression / takeover / superseded)--> cancelled
   |   runAt      | claim: single UPDATE ... WHERE status='queued' AND runAt<=now
   | = now+backoff|         AND serialKey not in-flight ... RETURNING  (lease 60s)
   |              v
   |           claimed --lease expired, no sendIntent row--> queued (reclaim, attempt++)
   |              |  \--lease expired, sendIntent row exists--> ambiguous
   |              |
   |   retryable  |  provider timeout AFTER request dispatched --> ambiguous
   +---- failed <-+  (attempts < max)
                  |  attempts == max or non-retryable --> dead
                  +-> succeeded

   ambiguous --reconcile (status webhook carries biz_opaque_callback_data / idempotent
               provider lookup)--> succeeded
   ambiguous --operator "mark not sent + resend" (audited, re-runs every preflight)--> queued
   ambiguous --operator cancel--> cancelled
   dead      --operator safe retry (re-runs preflight; new attempt, same idempotencyKey)--> queued
   INVALID: succeeded->*, cancelled->*, ambiguous->queued automatically (NO BLIND RESEND)
```
`failed` is a transient record on the `JobAttempt` row. On the `Job` row it shows up as `queued` with a future `runAt`. Keep `failed` as a UI label only so the inspector has fewer states to explain. (a) assumption.

**Message delivery** (rank-monotonic, with `failed` handled separately)

```
  rank: pending(0) < sent(1) < delivered(2) < read(3)        failed = terminal flag
  pending --provider 2xx + providerMessageId--> sent --> delivered --> read
     |                                          |          |
     +--------------failed----------------------+----------+   (failed after sent: allowed)
  Out-of-order rule: apply status S only if rank(S) > rank(current); always append
  MessageStatusEvent(providerMessageId, status, providerTs) UNIQUE(providerMessageId,status).
  read arriving before delivered: set read (implies delivered); deliveredAt=null, shown "implied".
  failed arriving after read: keep read, store event, raise inspector flag (provider anomaly).
  status for unknown providerMessageId: keep WebhookEvent pending, retry status.apply with
  backoff (send response may not be committed yet), then mark orphan.
```

**Lead: four independent axes. Eligibility combines them; it never stores them.**

```
  salesStage:  NEW -> CONTACTED -> REPLIED -> QUOTE_SENT -> CONVERTED      LOST (any -> LOST)
               auto promotions are forward-only (dispatch ok, inbound, quote SENT, accept);
               manual moves any direction, audited; inbound on LOST raises a flag, no auto-revive
  consent[ch]: ConsentRecord(contactId, channel, purpose, source, evidence, grantedAt, revokedAt)
               NONE -> OPTED_IN (evidence required) -> REVOKED     (per channel: whatsapp, email)
  suppression: Suppression(workspaceId, channel, normalizedContact, reason, createdAt)
               keyed on CONTACT, not lead, so dedupe merges and re-imports cannot drop it
  window:      derived only from Message(direction=IN, valid) ; see below
  eligible(ch, kind) = !globalPause && !wsAutomationPause(if automated)
                       && !suppressed(ch, contact) && consentOk(ch, kind)
                       && (kind==TEMPLATE ? templateApproved : windowOpen(now))
                       && !conversation.humanTakeover(if automated)
```

**WhatsApp service window**

```
   CLOSED --valid inbound (text/media/quick-reply button) at providerTs T--> OPEN(until T+24h)
   OPEN   --newer valid inbound T2 > T--> OPEN(until T2+24h)        (older/dup inbound: no-op)
   OPEN   --clock >= T+24h--> CLOSED                                (computed, not stored)
   NOT triggers: template send, status webhooks, quote link open, outbound free-form, echoes
   windowOpen(now) := now < lastValidInboundProviderTs + 24h   (strict <, injected Clock)
```

### 1.4 Findings

| # | Sev | PRD clause | Finding | Remedy | Type |
|---|---|---|---|---|---|
| A1 | CRITICAL | Persistent jobs: transactional claiming; Architecture: separate worker | SQLite has a single writer, and the web process and worker process share it. Prisma interactive transactions on SQLite start DEFERRED, so two processes that both read and then write get SQLITE_BUSY at lock upgrade, and `busy_timeout` does not resolve that deadlock. Read-then-update claiming will double-claim or throw under load. | (1) On startup, run `PRAGMA journal_mode=WAL; busy_timeout=5000; foreign_keys=ON; synchronous=NORMAL` in both processes. (2) Claim with ONE statement: `UPDATE Job SET status='claimed', leaseOwner=?, leaseUntil=?, attempts=attempts+1 WHERE id=(SELECT id FROM Job WHERE status='queued' AND runAt<=? AND (serialKey IS NULL OR serialKey NOT IN (SELECT serialKey FROM Job WHERE status='claimed')) ORDER BY priority, runAt LIMIT 1) RETURNING *` via `$queryRaw`. (3) Every business CAS is a single `UPDATE ... WHERE id=? AND version=? AND status=?` with an affected-row check. (4) Multi-statement transactions write first (so the RESERVED lock is taken immediately), stay under 50 ms, never await network, and retry on busy/timeout codes. (5) No provider HTTP call ever runs inside a DB transaction. | (a) |
| A2 | CRITICAL | No blind resend after ambiguous timeouts | A worker crash between "HTTP sent" and "result persisted" leaves a claimed job with an expired lease. Plain lease reclaim would resend it. | Write a `SendIntent(jobId, attemptNo, createdAt)` row in a committed transaction BEFORE the provider call. On lease expiry, a job with a SendIntent goes to `ambiguous`, never to `queued`. For WhatsApp, send `biz_opaque_callback_data = sendIntentId` so status webhooks can reconcile (verify the field in current docs and record it in integrations.md). For Resend, send an `Idempotency-Key = job.idempotencyKey` header (verify). SMTP has no idempotency: an ambiguous SMTP send is always manual. | (a) |
| A3 | CRITICAL | Document SQLite limits, storage, backups | The repo lives under OneDrive. OneDrive sync of `*.db`, `-wal` and `-shm` files corrupts WAL databases and causes spurious lock errors on Windows. | `DATABASE_URL` defaults to `file:%LOCALAPPDATA%/auralead/dev.db`, resolved by a small `scripts/db-path.ts`. Document this in README and CLAUDE.md. Add `*.db*` to `.gitignore`. Backups use `VACUUM INTO` (consistent while live), never a file copy. | (a) |
| W1 | CRITICAL | Messaging rules: verified webhooks, inbound, statuses | The PRD names ingestion webhooks but has no route for WhatsApp inbound and status webhooks or for email events. Window, stop, takeover and delivery status all depend on these routes. | Add `/api/webhooks/whatsapp` (GET verify token, POST `X-Hub-Signature-256` over the raw body with the app secret) and `/api/webhooks/email/[provider]` (Resend uses Svix headers; verify). Route a WhatsApp payload to its workspace via `Integration.phoneNumberId` lookup, never via payload trust. This only fills in a mechanism the PRD already requires, so it is not a scope change. | (a) |
| A4 | CRITICAL | Tenant isolation; never trust browser-supplied workspace IDs | Each service needs one enforced choke point. Ad hoc `where: {workspaceId}` gets missed in exports, PDFs and job handlers. | `RequestContext` is created only by `getRequestContext()` (session) or `getJobContext(job)` (the job row's workspaceId). Every service method takes `ctx` as its first argument. A Prisma client extension `tenantScoped(ctx)` injects `workspaceId` on tenant models and throws on unscoped queries. Super admin calls go through `adminContext(targetWorkspaceId)`, which writes an AuditEvent before returning data. Test: a table-driven ID-tampering suite runs every route against a foreign ID and expects 404 (not 403, so existence does not leak). | (a) |
| A5 | WARNING | DEMO vs LIVE; simulations cannot touch live data | The app-level mode and the data-level mode are both undefined. | `APP_MODE=demo|live` per deployment, plus an immutable `Workspace.mode`. Transport resolution is `adapters.for(workspace.mode)`. Simulation routes and the role switcher are 404 unless `APP_MODE=demo` AND the target workspace's mode is DEMO. A demo session cookie carries `mode=demo` and is rejected by live auth. In LIVE, a missing credential returns the `NotConfigured` result type, never a demo transport. | (a) |
| A6 | WARNING | Public quote `/quote/[id]`; unguessable share credentials | Putting a DB id in the path and the token in a query string leaks through Referer headers and logs. | `[id]` IS the share token: 32 random bytes, base64url. Store `sha256(token)` in `QuoteShare(quoteId, quoteVersionId, tokenHash, expiresAt, revokedAt)`. Set `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`. Tokens bind to a version: a superseded version renders "This quote was revised" with no prices. | (a) |
| A7 | WARNING | View evidence without claiming human engagement | WhatsApp, Gmail and Outlook link previewers fetch the URL, so a raw GET would mark the quote VIEWED with no human involved. | A GET logs a `QuoteViewEvent(kind=fetch, uaClass)`. The VIEWED transition happens only on a client beacon POST from the rendered page, after visibility plus 2 s, CSRF-free, signed with the token. The UI label is "Opened (device), may be automated". Never write "customer viewed". | (a) |
| A8 | WARNING | Real PDF matching HTML totals and version | If the PDF and HTML have separate templates or separate math, they will drift. | One `renderQuoteHtml(QuoteVersionSnapshot)` used by both the page and the PDF. Totals come only from `domain/quoteMath.ts` and are stored on the version. The PDF is rendered in the worker via Chromium `setContent` (no internal URL, so no internal auth surface) and stored as `QuoteArtifact(versionId, sha256, bytes path)`. The PDF footer prints the version and a short hash. Test: parse the PDF text and assert total, version and hash equal the HTML values. Playwright Chromium must be installed for the worker. If Chromium is missing, the render job fails visibly and reports the setup step. | (a) |
| A9 | WARNING | Global outbound pause, per-workspace automation pause honored by workers | A pause flag that is checked only at enqueue time lets already-queued work send anyway. | `SystemSetting.outboundPaused` and `Workspace.automationPaused` are checked inside the dispatch preflight transaction (see D-a). While paused, jobs stay `queued` with `runAt` pushed forward (deferred, not failed). | (a) |
| A10 | WARNING | Per-conversation ordering (implied by inbox correctness) | Concurrent dispatch to one contact can reorder messages, or send a template and a free-form message at the same time. | `Job.serialKey = conversationId` for dispatch jobs. The claim query skips keys that are already in flight (A1). | (a) |
| A11 | WARNING | Encrypt provider credentials with deployment secret; rotation | Losing the key makes every credential unrecoverable, and rotating it is undefined. | `CREDENTIAL_KEYS=kid1:base64,kid2:...` with AES-256-GCM. Each ciphertext stores its `kid`. `npm run creds:rotate` re-encrypts all ciphertexts. Startup refuses to run in LIVE if the key is missing. In DEMO, an ephemeral key is generated and a warning is shown. | (a) |
| A12 | OK | Thin routes / services / adapters | The modular monolith is right for this size. Keep it one package with no microservices. | None. | n/a |
| A13 | WARNING | Rate limits on public/auth/ingestion | A per-request DB rate limiter adds writes to the single SQLite writer. | Use an in-process token bucket (LRU keyed by IP + credential id) for MVP and document it as per-instance. The PostgreSQL path moves it to a shared store. | (a) |
| A14 | WARNING | Webhook handling (Meta needs a fast 200) | Processing inside the webhook request risks provider timeouts and retries. | The webhook route does verify, then a size cap, then `WebhookEvent` insert (UNIQUE(provider, providerEventId or sha256(rawBody))), then a `webhook.process` job enqueued in the same transaction, then 200. The worker does the rest. A duplicate insert returns 200 with no new job. | (a) |

### 1.5 Coupling

- **Tight, by design:** `quoteMath` <- `pricing` <- `quoteLifecycle`, with one source of money truth. `eligibility.ts` is used both by the bulk "eligible/skipped" preview and by the dispatch preflight. It must be the same function, or the counts will lie (requirement 13).
- **Risky:** `draftGeneration` depends on the AI adapter output shape. AI output always passes a Zod schema plus a whitelist (service IDs must exist in the active PricingVersion, and template variables must match the template's declared variables). Prices are never accepted from AI output, and pricing review routes go to `Approval(kind=PRICING_REVIEW)`.
- **Hidden:** campaign pause/resume and the WhatsApp quality pause both affect dispatch. Model both as inputs to `eligibility` and not as side-channel flags.
- **Pipeline editor:** the React Flow graph persists as `PipelineConfig(version, nodes JSON)`, validated against a fixed stage enum and DAG order. The worker reads only the active validated version; it never interprets free-form graphs.

### 1.6 Scale (baseline assumption: 5 workspaces, 10k leads, 1k outbound/day)

| Load | What breaks first | Remedy inside scope |
|---|---|---|
| 10x (100k leads, 10k msgs/day, ~40k status webhooks/day) | Dashboard aggregate queries scanning Lead/Message; React Flow and TanStack fine; SQLite fine in WAL if transactions stay short | Composite indexes `(workspaceId, salesStage, createdAt)`, `(workspaceId, status, updatedAt)`, `(providerMessageId)`, `(status, runAt, priority)` on Job; keyset pagination (no OFFSET); metrics from indexed COUNT, no full scans |
| 100x (1M leads, 100k msgs/day, status bursts 100+/s) | SQLite writer lock: webhook inserts + status applies + worker claims contend; busy errors and p99 latency spike; PDF Chromium memory; AI provider 429s | Batch status applies (one tx per 50 events); this is the documented PostgreSQL trigger point: `FOR UPDATE SKIP LOCKED` claims, multiple workers, pg advisory locks per serialKey. Chromium pool max 2; AI calls queued with per-provider concurrency + 429 backoff |

### 1.7 Single points of failure

```
 SPOF                         Failure                               Mitigation (record)
 SQLite file                  corruption, lock storm, disk full     WAL, outside OneDrive, VACUUM INTO nightly +
                                                                    pre-migrate, integrity_check in /admin health
 Single worker process        crash -> nothing dispatches           lease reclaim (A2-safe), WorkerHeartbeat; admin
                                                                    shows "Worker offline since T"; jobs wait, not lost
 Writer lock (web vs worker)  long tx in one blocks the other       <50ms tx rule, no network in tx, lint rule banning
                                                                    adapter imports inside prisma.$transaction callbacks
 CREDENTIAL_KEYS              lost -> all integrations dead          keyed rotation, documented backup of key
 Meta App webhook endpoint    down -> Meta retries then drops       WebhookEvent dedupe on replay; integration health
                                                                    poll flags gaps; Meta lead backfill by form+time
 Chromium binary              missing on host                       render job dead with setup message; HTML quote
                                                                    still works; send blocked if PDF required
```

### 1.8 Security architecture per endpoint

| Endpoint | Who can call | Auth / checks | What they get | What they change |
|---|---|---|---|---|
| Pages `/dashboard/user` | client role with membership | session cookie; ctx from membership | own workspace data | none directly |
| Pages `/dashboard/employee` | employee | session; `EmployeeAssignment` + capability per action | assigned workspaces only | none directly |
| Pages `/dashboard/admin` | super admin | session + role; every drilldown writes AuditEvent | cross-workspace, secrets masked | none directly |
| `POST /api/app/*` | the above | session + CSRF (Origin/Sec-Fetch-Site + double-submit token) + zod + capability | DTOs, never raw rows | tenant state via services, audited |
| `/api/admin/*` | super admin | same + reason field required on mutations | redacted payloads | memberships, plan labels, job retry/cancel, global pause |
| `/api/demo/session` | anyone | 404 unless APP_MODE=demo; seeded identities only | demo session cookie (mode=demo) | none |
| `/api/demo/simulate/*` | demo session | demo mode + DEMO workspace + role | created ids | durable demo records via same services |
| `/api/webhooks/google-sheets` | Apps Script | per-integration HMAC-SHA256 over `ts.body`, ts window 5 min, eventId UNIQUE, 256 KB cap | 200 / per-row results | leads, source records |
| `/api/webhooks/meta-ads` | Meta | GET verify token; POST X-Hub-Signature-256 raw body, 1 MB cap | 200 | WebhookEvent -> fetch job |
| `/api/webhooks/whatsapp` | Meta | as above; phoneNumberId -> workspace | 200 | inbound msgs, statuses, window, stop |
| `/api/webhooks/email/[p]` | Resend | Svix signature; SMTP: none (no inbound) | 200 | delivery/bounce/inbound |
| `/api/webhooks/gmaps-extension` | extension | Bearer ingestion token (hashed, revocable, scope=ingest only, one workspace), batchId UNIQUE, 1 MB/200 records cap, CORS only for configured extension origin | per-record accepted/duplicate/rejected | leads, batch status |
| `/quote/[tok]` GET | anyone with token | token hash, not expired/revoked, version current | quote render, no internal notes/margins | fetch-view event only |
| `/api/quote-share/[tok]/view` POST | page beacon | token | 204 | VIEWED transition |
| `/api/quote-share/[tok]/accept` POST | token holder | token + current version + now<validUntil + rate limit + name/confirm field | receipt (idempotent) | ACCEPTED, stage CONVERTED, audit |
| `/api/quote-share/[tok]/pdf` GET | token holder | token; serves stored artifact of bound version | PDF bytes | none |
| Worker | n/a | no network listener; DB credentials only | n/a | everything via services with job ctx |

### 1.9 One realistic production failure per integration

| Integration | Failure | Required behavior |
|---|---|---|
| WhatsApp Cloud API | Free-form send rejected because the window closed between preflight and send (clock skew or slow queue). Template paused by Meta for quality. | Map the provider error to `WINDOW_CLOSED` / `TEMPLATE_PAUSED` (non-retryable). Message goes to `failed` and the item returns to review. Template status refreshes on a schedule, and a paused template blocks the eligibility of its queued items. |
| Meta Lead Ads | Page token expired or `leads_retrieval` permission revoked. The webhook arrives but the fetch returns 190/200-family errors. | Fetch job goes `dead` with a redacted error. Integration shows "Verification required". WebhookEvent is kept so a "refetch" after reauth replays it idempotently. |
| Google Sheets / Apps Script | Apps Script `UrlFetchApp` quota is hit or the trigger is disabled, so rows land in the sheet but never in the app. Employee sync is the backstop. | Sync uses an `auralead_event_id` column stamped by the script (see D2), so script and sync never double-create. Sync status shows "last script event at T, last sync at T". |
| Extension | The MV3 service worker is killed mid-upload. The batch partially commits server-side and the extension retries the same batch. | `batchId` + `recordId` UNIQUE. The retry returns per-record `duplicate` for already-committed rows and creates the rest. |
| Resend / SMTP | Domain not verified: Resend 403. SMTP connection timeout after DATA. | 403 means not configured, shown in the Integration center. SMTP timeout after DATA means `ambiguous`, manual only. |
| Anthropic / OpenAI | 429 or schema-invalid JSON, or the model returns a service ID not in the catalog. | Retry with backoff, bounded. On a schema fail, retry once, then fall back to review (NOT to the deterministic generator in LIVE unless the workspace selected it). An unknown service becomes a pricing review. |
| PDF renderer | Chromium OOM on large quotes, or binary missing. | Render job retries once, then `dead`. Dispatch that requires a PDF stays blocked with reason "PDF not rendered". |

### 1.10 Rollback posture

- Migrations follow expand/contract: no destructive column change in the same release that stops using the column. `npm run db:backup` (VACUUM INTO, timestamped) runs automatically before `prisma migrate deploy`.
- Code rollback is safe because job payloads carry `payloadVersion` and handlers reject unknown versions into `dead` instead of misreading them.
- Kill switches: global outbound pause (admin UI and env override `OUTBOUND_PAUSED=1` read by the worker each loop), per-workspace automation pause, per-integration disable.
- Worker drain: SIGINT/SIGTERM stops claiming, lets in-flight jobs finish within 30 s, and exits. The leases of anything left reclaim per A2. On Windows, handle `SIGINT` and `SIGBREAK`, and give the npm script a graceful stop.

---

## Section 4: Data Flow & Interaction Edge Cases

### 4.1 Ingestion flows (with shadow paths)

Common pipeline for all sources: `services/leadIngestion.ingestBatch(ctx, source, records[])`.

```
 INPUT ------------> VALIDATION ------------> TRANSFORM -------------> PERSIST -----------------> OUTPUT
 raw body            auth (source-specific)   phone->E.164 (IN)        tx per batch chunk(50):     per-record result
                     size cap                 email lowercase, no       LeadSourceRecord UNIQUE     {accepted|duplicate|
                     replay: eventId/batchId   invention                 (ws, source, externalId)    review|rejected,
                     UNIQUE                   website: unknown unless   LeadContact UNIQUE          reason}
                     zod per record           verified                  (ws, type, normalized)      batch counts
                                              dedupe match              Lead / merge-review         enqueue score,
                                                                        audit + jobs (same tx)      enrich jobs
 SHADOW PATHS
 nil/empty body ---> 400 "empty", no WebhookEvent row (nothing to replay)
 bad signature  ---> 401, log redacted, counter++ (no body persisted)
 oversized      ---> 413 before parse (stream length check; Content-Length can lie -> read capped)
 wrong type     ---> per-record rejected{field, reason}; batch still processes valid rows
 phone invalid  ---> record kept, phone=null, flag "invalid phone" (not dropped; attribution kept)
 dedupe split   ---> email matches lead A, phone matches lead B -> LeadMergeReview, no write to A/B
 unique race    ---> concurrent same-contact insert -> P2002 -> retry as match (once)
 replay         ---> same eventId/batchId -> 200 with original results (stored on WebhookEvent)
 upstream err   ---> (Meta fetch) job retry -> dead -> Integration "Verification required"
```

| Source | Source-specific validation | Source-specific transform | Shadow paths unique to source |
|---|---|---|---|
| Sheets Apps Script | HMAC + ts + eventId | header mapping from `SheetMapping` | Mapping changed after rows were sent: the record stores the raw row plus mappingVersion, and unmapped columns are kept in the raw JSON |
| Sheets employee preview/sync | employee capability + configured access | preview = dry run (no writes) of the same pipeline | Row numbers shift on insert/delete, so never key on row number (D2). Preview is stale against sync, so sync re-runs dedupe |
| Meta | signature, then a job fetches the lead via Graph | field_data -> canonical fields; ad/form/campaign attribution | Webhook for a page with no Integration: the event is stored as `unrouted` and appears in the admin inspector |
| Extension | bearer token scope, batch caps | Maps fields; rating/reviews as numbers or null; `websiteStatus=unknown` | Token revoked mid-retry: 401 `token_revoked`, and the extension stops retrying and shows status |
| Demo simulation | demo session + DEMO workspace | fixture generator (non-deliverable contacts, e.g. +91 555 range and `.invalid` emails) | Simulation against a LIVE workspace: 404 |

| # | Sev | PRD clause | Finding | Remedy | Type |
|---|---|---|---|---|---|
| D1 | WARNING | Dedupe per workspace; conflicts to review | A unique index on `Lead.phone` cannot model multiple contacts per lead, and having no index allows race duplicates. | `LeadContact(workspaceId, leadId, type, normalizedValue)` UNIQUE(workspaceId,type,normalizedValue). Insert-or-match handles P2002. Concurrency test: two batches with the same phone under `Promise.all` yield 1 lead. | (a) |
| D2 | WARNING | Sheets event IDs | Sheets has no stable row id. | The generated Apps Script stamps an `auralead_event_id` (UUID) cell on submit and sends it. Sync uses it. Legacy rows without it get `sha256(normalized row)` and the flag `weak_id`. | (a) |
| D3 | WARNING | Website enrichment SSRF | DNS rebinding and redirects to private IPs. | `safeFetch`: http/https only; resolve, then reject private/loopback/link-local/metadata ranges; connect to the resolved IP; max 3 redirects, re-validated each hop; 5 s timeout; 1 MB cap; text/html only. Store the stripped text marked untrusted. | (a) |
| D4 | OK | Score 0 to 100 heuristic | Scoring is pure and versioned. | Store `scoreVersion`, `reasons[]` and `unknownInputs[]`. A rescore on config change is a job, not an inline loop. | (a) |

### 4.2 Approve-and-send dispatch flow

```
 UI click "Approve & send" (expectedVersion=N, Idempotency-Key=uuid)
   |
   v
 VALIDATION  ctx role/capability, zod, quote in ctx.workspace
   |   shadow: stale version -> 409 "Quote changed, review v N+1"; pricing review open -> 409
   v
 TX#1 (single SQLite tx, write-first)
   UPDATE Quote SET status='APPROVED' WHERE id=? AND currentVersion=N AND status='DRAFT'  (rows==1?)
   INSERT Approval(quoteId, quoteVersion=N, approverId)        UNIQUE(quoteId, quoteVersion)
   INSERT Job(dispatch.<ch>, idempotencyKey='dispatch:quote:{id}:v{N}:{ch}', serialKey=convId)
   INSERT Message(status=pending, quoteVersionId, jobId UNIQUE)
   INSERT AuditEvent
   |   shadow: rows==0 + Approval exists for N -> return existing result (idempotent 200)
   |           rows==0 otherwise -> 409 with current state
   v
 OUTPUT 202 {approvalId, jobId, messageId}  -> UI shows "Queued", polls TanStack Query
 ................................................................. worker
 CLAIM (A1)  -> pause point P1 "after-claim"
   v
 TX#2 PREFLIGHT (single tx)
   re-read: outboundPaused, automationPaused, suppression(ch, contact), consent(ch),
            quote.currentVersion==job.quoteVersion && status=='APPROVED' && Approval valid,
            conversation.mode/modeVersion (automated only), windowOpen(now) or template ok,
            PDF artifact exists for version, internal cap counter
   any fail -> Job cancelled|deferred(reason), Message failed{reason} or back to review, audit
   pass     -> INSERT SendIntent; Job.inFlightAt=now                  -> pause point P2 "after-preflight"
   v
 PROVIDER CALL (no tx)   timeout before bytes sent -> retryable failed
                         timeout after send        -> ambiguous (A2)
                         4xx non-retryable         -> dead + Message failed (redacted)
   v                                                                    -> pause point P3 "after-provider"
 TX#3 SETTLE  Message.sent + providerMessageId (UNIQUE), Quote APPROVED->SENT (CAS),
              Lead stage forward-only -> QUOTE_SENT, Job succeeded, audit
   shadow: status webhook already applied (orphan) -> merge by rank on settle
```

### 4.3 Async ordering analysis

Test harness: `src/server/testing/pause.ts` exposes `await pausePoint('P2')`, controlled by a test-only `PauseController` (each point is a resolved promise outside tests). Integration tests run the real worker handler in-process against a temp SQLite file, with a second Prisma client simulating the web process, so the cross-connection locking is real.

| Race | Violating schedule | Prevention mechanism | Regression test (pause points) |
|---|---|---|---|
| (a) Stop vs queued dispatch | Worker passes the suppression check, Stop commits, worker sends. Or: a retry scheduled before Stop sends after it. | Stop handler TX: INSERT Suppression(channel, contact) + `UPDATE Job SET status='cancelled' WHERE serialKey IN (contact convs) AND status='queued'` + audit, in one tx. Preflight re-checks suppression in TX#2, and TX#2 and the Stop TX serialize on the SQLite write lock. Residual: if TX#2 committed first, the message was already in flight at stop time; it is recorded as such and is unrecallable. All later attempts and retries hit preflight. | T-a1: hold at P1, deliver Stop webhook, release: 0 provider calls, job cancelled, reason `suppressed`. T-a2: hold at P2, Stop, release: exactly 1 call, Suppression exists, audit order shows send intent before stop; then force a retry: 0 calls. T-a3: job in `failed/queued runAt+backoff`, Stop: job cancelled. |
| (b) Human takeover vs automated reply | AI reply generated while mode=AI; human takes over (and maybe resumes); stale AI reply sends. | `Conversation.mode` + `modeVersion` (incremented on every takeover/resume). Automated jobs store `modeVersionAtCreate` and `replyToInboundId`. Preflight requires `mode=='AI' && modeVersion==job.modeVersionAtCreate && no newer inbound than replyToInboundId`; on failure the job is cancelled and the draft moves to the inbox as a suggestion. Manual sends ignore mode but still pass suppression and window checks. | T-b1: P1 hold, takeover, release: 0 calls. T-b2: P1 hold, takeover then resume, release: 0 calls (version changed). T-b3: P1 hold, new inbound arrives, release: 0 calls, draft regenerated job enqueued. |
| (c) Duplicate approve clicks / callbacks | Two POSTs create two Approvals or two dispatch jobs, and two messages go out. | CAS UPDATE on Quote (rows==1 for exactly one request) + UNIQUE(quoteId, quoteVersion) on Approval + UNIQUE `Job.idempotencyKey` + UNIQUE `Message.jobId`. The client disables the button and sends an Idempotency-Key, but correctness does not depend on the client. Duplicate status callbacks: UNIQUE `WebhookEvent(provider, eventId)` and UNIQUE `MessageStatusEvent(providerMessageId, status)`. | T-c1: `Promise.all` of 2 approve calls from 2 Prisma clients: 1 Approval, 1 Job, 1 Message, second response 200 with the same ids. T-c2: same approval replayed after the worker restarts (kill the worker at P3, restart): job goes ambiguous, 0 additional calls. T-c3: same status webhook posted 3 times: 1 event row. |
| (d) Out-of-order delivery statuses | `read` then `delivered` regresses status; `delivered` arrives before TX#3 persisted providerMessageId. | Rank-monotonic `UPDATE Message SET status=? WHERE providerMessageId=? AND statusRank < ?`; failed policy per 1.3. An orphan status event is retried by the `status.apply` job with backoff until the message is found (bounded, then `orphan`). With WhatsApp, `biz_opaque_callback_data` links it to the SendIntent even before providerMessageId is stored. | T-d1: apply read, delivered, sent: final read, 3 events stored. T-d2: hold at P3, deliver `delivered` webhook, release: final delivered, no error. T-d3: failed after delivered: status stays delivered, anomaly flag set. |
| (e) Quote edit vs approval vs dispatch version binding | Approver sees v1, editor saves v2, approve applies to v2. Or: dispatch sends v1 content after v2 exists. Or: accept on a v1 link after v2. | Immutable `QuoteVersion` rows. The approve CAS includes `currentVersion=expectedVersion`. A material edit, in one TX, inserts v N+1, sets status DRAFT, sets `Approval.invalidatedAt`, cancels queued dispatch jobs for vN, and supersedes share tokens. Preflight checks `job.quoteVersion==currentVersion`. Share token, PDF artifact and Message all reference `quoteVersionId`. Accept CAS: `WHERE currentVersion=token.version AND status IN ('SENT','VIEWED') AND validUntil>now`. "Material" means anything that changes line items, quantities, prices, discount, tax, scope, timeline or validity; a branding-only change is not material (assumption). | T-e1: client sends approve(expected=1) after an edit to v2: 409, no Approval. T-e2: hold at P1, edit, release: 0 calls, job cancelled `superseded`. T-e3: v1 SENT, revise to v2, accept on v1 token: 409 "revised", status unchanged. T-e4: accept at `validUntil` exactly (injected clock): rejected; 1 ms before: accepted; repeated accept: same receipt id. |

### 4.4 Interaction edge-case table

| Panel / interaction | Edge case | Required behavior | Mechanism / test |
|---|---|---|---|
| Landing ROI calculator | non-numeric, negative or huge inputs; reset | Clamp with an inline message; assumptions stay editable and visible; "illustrative" label | Zod on the client; unit test of the calc |
| Landing globe | no WebGL, reduced motion, tab hidden, low-power device | Static fallback image; animation paused while offscreen or hidden; DPR capped at 1.5 | Playwright with `prefers-reduced-motion` and WebGL disabled |
| Role switcher (demo) | used in LIVE; cookie replayed into live | 404 in LIVE; demo cookie rejected by live auth | Acceptance test 4 |
| Leads table | filter + page beyond the end; sort while loading; 0 results | Keyset cursor reset on filter change; empty state with a clear-filters action | Playwright |
| Leads Kanban drag stage | drop then network fail; two tabs move the same lead; drag to the same column | Optimistic move rolled back with a Sonner error; `stageVersion` CAS returns 409 with a refetch; same-column drop is a no-op | API test with stale version |
| Lead detail consent | grant WhatsApp opt-in without evidence | Blocked: evidence fields (purpose, source, timestamp) are required; Maps source cannot self-grant | Zod + service test |
| Bulk select + draft generation | 500 selected, mixed eligibility; navigate away mid-run | Server returns eligible/skipped(reasons)/failed counts from the shared `eligibility()`; drafts run as jobs, so leaving the page does not cancel them; progress is persisted | Acceptance test 13 |
| Inbox manual send | window closes while typing; contact suppressed; double Enter | Eligibility re-checked server-side at send; error explains the restriction and offers template send; Idempotency-Key per compose | T-a, window boundary test |
| Inbox AI mode / takeover / resume | rapid toggling; takeover while an AI reply is in flight | modeVersion CAS; an in-flight send (past P2) is shown as "sent before takeover" | T-b |
| Pricing service CRUD | edit price while quotes are open; delete a service used by issued quotes | Each change creates a new PricingVersion; issued snapshots unchanged; delete = archive if referenced | Acceptance test 6 |
| Pricing discount/tax rules | discount above max; tax not configured | Quote save rejected or routed to review; no implicit 0% tax (explicit "tax: none" setting required) | Unit tests incl. 2x10000, -10%, +18% = 21240 |
| Quotation create/revise | AI proposes an unknown service; rounding at the paise boundary | Pricing review approval; rounding is half-up at line level then at the total (documented choice, tested) | Rounding unit tests |
| Quotation approve | double click; stale version; pricing review open | T-c / T-e / 409 | Tests above |
| Quotation share link | copy link on a DRAFT; revoke then open; expired | DRAFT has no public link; revoked/expired render a neutral "link unavailable" page with no data | Acceptance test 7 |
| Quotation download PDF | PDF not yet rendered; version mismatch | "Rendering..." state, then the file; filename includes the version; served artifact matches the version hash | A8 test |
| Public quote accept | double submit; accept on an expired or revised quote; bot prefetch | Idempotent receipt; 409/410 with an explanation; GET never mutates beyond logging a view event | T-e3, T-e4, A7 |
| Employee Sheets setup | Sheet URL pasted with no access; mapping missing a required field | "URL alone does not grant access" message plus the setup action; mapping validation lists missing fields; preview disabled until valid | Service test |
| Employee Meta pause/resume | provider error; demo workspace | Confirmation dialog; result shows the provider response; failure never shown as success; demo writes a persisted simulated state labeled Simulated | Acceptance test 14 |
| Extension hub keys | key shown once; revoke while a batch is retrying; create a key for an unassigned workspace | Plaintext displayed once (copy); revoke takes effect on the next request; capability check blocks unassigned | Acceptance test 8 |
| Approval queue edit within permissions | employee edits a discount beyond their capability | 403 with the limit stated; edit creates a new version and invalidates prior approval | T-e |
| Approval queue reject | reject an already-dispatched item | 409 "already sent"; offer cancel quote instead | State machine test |
| Integration center test connection | live creds invalid; demo workspace | Real provider call in LIVE shows the redacted error; demo says "Simulated, no provider contacted" | Adapter tests with fixtures |
| WhatsApp quality/limits | API does not expose a value | "Unknown, last checked T"; never shows a hardcoded tier | Fixture test |
| Pipeline editor (React Flow) | add a cycle; unsupported node; unsaved changes on navigate | Save rejected with node-level errors; beforeunload prompt; only validated versions activate | Graph validator unit tests |
| Admin workspace drilldown | every open | AuditEvent written before data is returned | Test asserts an audit row |
| Admin job inspector retry | retry an ambiguous job; retry a job whose lead was suppressed since | Retry requires explicit confirm text for ambiguous jobs; preflight still runs, so a suppressed job cancels | T-a2 variant |
| Admin global outbound pause | toggled while jobs are in flight | In-flight jobs past P2 complete; nothing new passes preflight; banner on all panels | A9 test |
| All mutations | session expired mid-form; CSRF missing; slow network | 401 leads to re-login and preserves the draft (RHF state in sessionStorage, try/catch); 403 CSRF; buttons show pending, never double-fire | Playwright |

### 4.5 Material decisions

None of the items in Sections 1 and 4 materially change the product. All of them can be recorded as assumptions. The only borderline item is A7 (VIEWED requires a client beacon rather than a raw GET). It changes what the status means to the user, but the PRD's "view evidence without claiming human engagement" clause already requires it, so it is recorded as (a).
# AuraLead AI: Decision Log

Each entry: decision, why, alternatives considered, reversibility (1 = locked in, 5 = trivially swappable). Sources: [`PRD.md`](PRD.md), [`reviews/ceo-review.md`](reviews/ceo-review.md), [`reviews/ceo/99-critic.md`](reviews/ceo/99-critic.md) (C = ruling, P = remedy, A = assumption, O = outside voice). The plan is [`implementation-plan.md`](implementation-plan.md). New decisions append with the next number; superseded entries are marked, not deleted.

---

### ADR-01 Stack and exact version pins
- **Decision:** PRD default stack with exact pins verified on npm 2026-10-15 (plan §2): next 16.4.1, react/react-dom 19.3.1, typescript 5.9.3, prisma/@prisma/client/@prisma/adapter-better-sqlite3 7.10.0, better-sqlite3 12.11.1, tailwindcss 4.3.3, zod 4.6.7, react-hook-form 7.90.0, @tanstack/react-table 8.21.3, @tanstack/react-query 5.104.3, recharts 3.10.1, three 0.186.1, @react-three/fiber 9.8.2, @react-three/drei 10.7.9, motion 14.3.0, @xyflow/react 12.12.0, vitest 5.0.5, @playwright/test 1.64.1, @react-pdf/renderer 4.9.0, @node-rs/argon2 2.2.2, sonner 2.0.8, cmdk 1.1.1, lucide-react 1.57.0, libphonenumber-js 1.13.15, @anthropic-ai/sdk 0.134.0, openai 7.34.0, resend 6.33.0, nodemailer 10.1.1, zustand 5.0.15, tsx 4.23.15, sharp 0.35.5. Lockfile committed, `npm ci` only, Node 22.23.2, npm 10.9.8.
- **Why:** PRD requires pinned stable versions and a committed lockfile. Peer ranges were checked: r3f 9.8.2 needs `react <19.4`; vitest 5 needs vite 8; typescript-eslint 8.71.2 needs TS `<6.1`; the adapter needs better-sqlite3 `^12.6.0` (13.x is latest but out of range).
- **Notes:** @tanstack/react-table 9.3.1 is the latest stable, but shadcn data-table patterns target the v8 API, so 8.21.3 is pinned and T26 records whether v9 works with the generated components. ESLint 10.12.0 is pinned; if eslint-config-next 16.4.1 fails on it in T01, fall back to the latest 9.x and amend this entry.
- **Alternatives:** caret ranges (rejected: drift, supply chain); latest majors everywhere (rejected for TS 7, Prisma 8 rc, react-table 9 pattern risk).
- **Reversibility:** 3 per package; Next and Prisma majors 2.

### ADR-02 Prisma 7 with the better-sqlite3 driver adapter
- **Decision:** Prisma 7.10.0 with `prisma.config.ts`, generator `provider = "prisma-client"` and explicit `output = "../src/generated/prisma"`, `PrismaBetterSqlite3` adapter, `dotenv` loaded explicitly. All raw SQL lives in `src/server/db/raw/`.
- **Why:** Prisma 7 is the current stable line and moves the engine to JS driver adapters, which keeps the worker light. The single-statement job claim needs `$queryRaw` with `RETURNING`, which SQLite supports.
- **Risk:** PRAGMA scope per connection, DateTime storage format seen by raw SQL, and Windows prebuilds were UNVERIFIED (critic 12.3) until the M1 spike (T02); now verified, see ADR-02a.
- **ADR-02a (T02 spike result, 2026-10-15): PASSED, no fallback.** Pinned stack works unchanged on Windows 11 / Node 22.23.2 / npm 10.9.8 with no C++ compiler. Prebuilt binaries: better-sqlite3 12.11.1 via prebuild-install (SQLite 3.53.2, ABI 127); @node-rs/argon2 2.2.2 via @node-rs/argon2-win32-x64-msvc; sharp 0.35.5 via @img/sharp-win32-x64 (libvips 8.18.7). PRAGMAs confirmed on every adapter connection, including inside `$transaction`: journal_mode=wal (persisted in file), busy_timeout=5000, foreign_keys=1 (enforced). DateTime is stored as ISO-8601 text with a `+00:00` suffix (e.g. `2026-10-15T10:00:00.000+00:00`); bound Dates in raw SQL match it, so raw SQL always binds Dates and never relies on CURRENT_TIMESTAMP. Raw INTEGER columns come back as number, BIGINT/SUM/COUNT as bigint. One connection per PrismaClient; interactive transactions are serialized in-process. Two-process claim race: 200 jobs, each claimed exactly once, 0 SQLITE_BUSY. Paths with spaces work unencoded in `file:` URLs. Tests: `tests/integration/spike/*.test.ts` (15/15, 6 consecutive green runs).
- **Alternatives:** Prisma 8.0 rc (rejected: pre-release); Drizzle or Kysely (rejected: PRD default is Prisma; raw-SQL isolation already gives portability).
- **Reversibility:** 2.

### ADR-03 TypeScript 5.9.3, not 7.x
- **Decision:** Pin TypeScript 5.9.3.
- **Why:** TS 7 is the native-compiler line; typescript-eslint, Next type plugin and Vitest tooling compatibility are not established for it. 5.9 is supported by every pinned tool.
- **Alternatives:** TS 7 (rejected: tooling risk on a greenfield MVP).
- **Reversibility:** 4.

### ADR-04 One process, one APP_MODE, one DB file per mode (C20, A4)
- **Decision:** `APP_MODE=demo|live` read once at boot. Each mode has its own DB at `<DATA_DIR>/<mode>/app.db`. `Workspace.mode` stays as defense in depth, checked by simulators and the adapter registry. LIVE excludes the role switcher from the bundle and 404s demo and test routes.
- **Why:** Makes "simulations cannot touch live data" structural rather than a query filter that one bug can bypass.
- **Alternatives:** shared DB with `Workspace.mode` (A5 in 01-arch; rejected by C20).
- **Reversibility:** 3.

### ADR-05 DispatchAttempt outbox; the reaper decides ambiguity (C7, C8, A9)
- **Decision:** One `DispatchAttempt` table with states QUEUED, SENDING, SENT, FAILED, SKIPPED, AMBIGUOUS, CANCELLED; `idempotencyKey` UNIQUE. SENDING is committed before any provider call. A lease-expired job holding a SENDING attempt becomes AMBIGUOUS + job DEAD in one transaction; otherwise the job is requeued. AMBIGUOUS resolves only on positive provider evidence or an audited operator action. Job states: QUEUED, RUNNING, SUCCEEDED, DEAD, CANCELLED. Claiming is a single `UPDATE ... RETURNING` statement.
- **Why:** Four reviewers designed this four ways (SendIntent, MessageDispatch, dispatchAttemptedAt). One mechanism is the only way to guarantee "no blind resend after ambiguous timeouts" and is the top implementation risk.
- **Amended by:** ADR-39 (claimToken fencing of every job-driven tx), ADR-40 (superseded-version settle), ADR-41 (failure classes), ADR-45 (persisted send intent).
- **Alternatives:** handler-side SENDING to UNKNOWN conversion (rejected by C8: a requeued unsafe job looks like "retrying"); pg-boss style queue (rejected: SQLite).
- **Reversibility:** 1 for the semantics, 4 for the queue implementation (behind `jobs/queue.ts`).

### ADR-06 Stop and unsubscribe are processed synchronously in the verified route (C9, A11)
- **Decision:** After signature verification, the WhatsApp webhook route detects `AL_QR_STOP_V1` or a STOP keyword (fixed list incl. `बंद`, `रोकें`, `stop`, `unsubscribe`) and, in the same transaction, inserts the WebhookEvent and Suppression, cancels QUEUED attempts and jobs for that contact and channel, and writes the audit row. The email unsubscribe route does the same. This is the single exception to "webhook routes only verify, persist, enqueue".
- **Why:** PRD says "immediate suppression". With the worker down (the 2am case), a job-based Stop would let queued outreach run on restart.
- **Alternatives:** Stop via a job (rejected). Do not "fix" this exception in later reviews.
- **Reversibility:** 4.

### ADR-07 Money is BigInt paise (C11, A1)
- **Decision:** Every `*Paise` column is Prisma `BigInt`; the domain uses `bigint`; DTOs serialize decimal strings. Sanity cap ₹100 crore per quote, configurable, over cap routes to review.
- **Why:** PostgreSQL `Int` caps near ₹2.14 crore in paise, and seeded property agencies can exceed it. Issued quotes freeze the representation, so it must be right before M2.
- **Alternatives:** Prisma `Int` with a ₹1 crore cap (05-ops 9.7; rejected by C11); Decimal (rejected: float-adjacent APIs, no need for fractional paise).
- **Reversibility:** 1.

### ADR-08 Quote PDFs via @react-pdf/renderer in a worker job (C1, A27)
- **Decision:** `quote.renderPdf` runs when a QuoteVersion is created, from one `buildQuoteRenderModel(snapshot)` that also feeds the HTML presenter. Output stored as `QuoteArtifact(quoteVersionId, sha256, path)`; footer prints version and short hash; Inter TTF with U+20B9 embedded. The share PDF route serves the stored file or returns 503 + Retry-After and enqueues a render.
- **Why:** No Chromium binary on Windows or a future host, no HTML engine (removes the file:// / SSRF / XSS class), worker stays about 150 MB, durable artifact supports restart consistency and hash parity tests.
- **Alternatives:** Playwright Chromium `setContent` (01-arch A8) or an internal print route with `render_token` (02-errors G-Q-2), both rejected; render at request time (05-ops 7.8, rejected: no durable artifact).
- **Reversibility:** 4 (behind the PDF port).

### ADR-09 Share credential is the path segment; state-specific responses (C2, C3, A28)
- **Decision:** `/quote/[token]`, token = 32 random bytes base64url, only `sha256(token)` stored in `QuoteShare(tokenHash UNIQUE)`. Invalid, revoked and cancelled render the identical 404. Expired and superseded render 410 naming the sender. `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`.
- **Why:** Matches the PRD route shape without leaking a DB id; query strings land in more logs; hash lookup of a 256-bit token needs no constant-time compare; revocation must not confirm a link existed.
- **Alternatives:** `/quote/[id]?k=` (03-security T12, rejected).
- **Reversibility:** 3 (links already sent would break).

### ADR-10 VIEWED via beacon; accept via token + nonce + Origin (C4, C5, A29, A30)
- **Decision:** GET only appends `QuoteViewEvent(kind=FETCH)`. VIEWED transitions on a beacon POST from the rendered page after 2 s of visibility, with UA-class exclusion as a second filter, labelled "Opened (may be automated)". Accept is a POST with the token in the body, `formNonce = HMAC(SHARE_NONCE_KEY, tokenHash || versionId)`, Origin equal to APP_ORIGIN and `expectedVersionId`; idempotent per version. Manual "Copy link" / "Mark as sent" moves APPROVED to SENT (P15).
- **Why:** Link previewers and mail scanners fetch URLs and spoof browser UAs; the PRD forbids claiming human engagement.
- **Alternatives:** first browser-UA GET (rejected); cookie CSRF on a public route (not applicable).
- **Reversibility:** 4.

### ADR-11 Own email+password auth with DB sessions, not Auth.js (A31)
- **Decision:** argon2id via `@node-rs/argon2`, DB sessions (token hash stored), `__Host-` cookie, invite onboarding, super-admin issued resets when no email provider, login lockout persisted on `User`. MFA is a stated limitation.
- **Why:** Auth.js Credentials forces JWT sessions, which makes server-side revocation on role change awkward; membership and role are resolved from the DB per request anyway; no OAuth in scope; about 300 owned lines are easier to audit. `@node-rs/argon2` has Windows prebuilds (no node-gyp).
- **Alternatives:** Auth.js (rejected), Lucia-style library (rejected: maintenance status, small gain).
- **Reversibility:** 3 (behind `server/auth`).

### ADR-12 In-process rate limiting; only login lockout persisted (C6, A35)
- **Decision:** `withRateLimit()` token bucket in node-runtime handlers, documented as single-instance. `User.failedLoginCount` and `lockedUntil` are the only persisted counters, written on failure only.
- **Why:** A DB write per public request competes for the single SQLite writer with webhooks and the worker, the top contention risk. Login lockout must survive restarts.
- **Alternatives:** SQLite `RateLimitBucket` table (02-errors G-SEC-2, 03-security T13; rejected by C6); Redis (out of scope locally; documented PG/multi-instance path).
- **Reversibility:** 4.

### ADR-13 Extension: copy-agnostic bridge, no vendor code (user decision D3 / M1, 2026-10-15)
- **Decision:** Ship only `extension-bridge/` (saas-sync.js, options page, one-line `importScripts` patch guide, manifest key list, example payloads) plus contract tests with a fake `chrome.*`. Commit no code from either Google_Map_Extractor copy. The bridge honors the vendor licence gate (sync disabled when `_auth.hasValidKey !== true`). Sub-question default: do not run the 50-record unlicensed tier. Report "contract verified, live extension not verified".
- **Why:** Neither copy has a LICENSE file; the stripped copy circumvents a commercial paywall; the PRD forbids changing licensing or authentication. Vendor telemetry is disclosed in `/docs/extension` as "observed in the copy inspected on <date>".
- **Alternatives:** B build on the stripped copy (rejected: legal exposure); C original with a purchased key (recommended production posture, needs the user's key); D own extractor (scope change).
- **Reversibility:** 4.

### ADR-14 Email for Maps leads: opt-in, or attested B2B manual-only (user decision D4 / M2, 2026-10-15)
- **Decision:** Email eligibility needs an email OPT_IN consent, or an employee attestation (`ConsentBasis.B2B_ATTESTED`, actor, time, note). Attested leads allow manual single sends only: never automated, never bulk, never an email-fallback target; unsubscribe link and suppression check mandatory. Workspace setting `emailB2bAttestationEnabled` defaults to false (opt-in-only behavior); the attestation control is hidden until enabled. WhatsApp consent never implies email permission.
- **Why:** It decides whether the Maps source yields any outbound; the user chose B.
- **Alternatives:** A opt-in only (the default setting); C B2B for automated sends (rejected: sender reputation, DPDP exposure).
- **Reversibility:** 4 (setting).

### ADR-15 Consent captured at ingestion; re-opt-in ordering (P1, P13, O2, A16, A19)
- **Decision:** Sheets and Meta form mappings may define a consent field (column or question key, truthy values, verbatim notice text hashed). A truthy value creates `ConsentRecord(basis=OPT_IN, source=SHEETS_FORM|META_FORM, evidence, noticeTextHash, collectedAt=submission time)`. No mapping or falsy value means no consent. Maps leads get no WhatsApp consent. Inbound WhatsApp creates service-window consent only. A suppression is cleared only by a new OPT_IN record with `collectedAt > suppression.createdAt` strictly; backfilled or undated evidence never clears it.
- **Why:** Without capture, no Sheets or Meta lead could ever become WhatsApp-eligible; without strict ordering, a delayed form row could silently undo a Stop. ConsentRecord carries `noticeVersion`, `noticeTextHash`, `withdrawnAt`, `withdrawalMethod` now so DPDP notice duties do not need a migration later.
- **Amended by:** ADR-37: "newer than the suppression" means newer than the latest Stop for that contact and channel, and suppression rows are append-only history.
- **Alternatives:** manual employee grant only (rejected: dead messaging path).
- **Reversibility:** 2.

### ADR-16 Google Sheets server access via service account (P14, A38)
- **Decision:** The workspace uploads a service-account JSON (encrypted), shares the Sheet with the SA email, and a connection test fetches the header row. Apps Script webhook ingestion is separate and HMAC-signed. Docs explain "a Sheet URL alone does not grant access".
- **Why:** OAuth sensitive scopes need Google app verification, which a local MVP cannot assume.
- **Alternatives:** OAuth per user (rejected for MVP).
- **Reversibility:** 4.

### ADR-17 WhatsApp templates are synced and mapped, not authored in-app (P12, A22)
- **Decision:** Templates are synced from the WABA on demand and on template status webhooks, stored with raw status, category and category history, then mapped to intents (first_touch, quote_ready, follow_up, call_ack) and variable sources. Authoring and submission happen in WhatsApp Manager, linked from docs. DEMO seeds approved and rejected templates.
- **Why:** PRD says "template config" and "actually approved templates"; in-app submission adds a review workflow outside scope.
- **Alternatives:** in-app authoring (rejected under HOLD SCOPE).
- **Reversibility:** 4.

### ADR-18 AI: no silent fallback in LIVE; strip-and-flag proposals (C12, C13, A24-A26)
- **Decision:** In LIVE, an AI provider failure gets one repair retry, then NEEDS_REVIEW plus an explicit "Generate with local template" action labelled `local-deterministic`. DEMO uses the local generator by default. The proposal schema holds service IDs, quantities, scope and timeline only; any price, discount or tax key is stripped, flagged (`ai_price_ignored` etc.), audited, and the draft is forced to review. An output policy runs on every generated string; the auto-reply guard deflects out-of-scope intents.
- **Why:** PRD "never silently fall back"; AT5 "ignored and server price used"; treating the attempt as an injection signal without losing a usable proposal.
- **Alternatives:** auto fallback to the deterministic generator (03-security T10, rejected); reject the whole proposal (loses work); clamp AI discounts (moot: no discount field).
- **Reversibility:** 4.

### ADR-19 Suppression key is an HMAC with a server pepper (C17, A7)
- **Decision:** `Suppression(workspaceId, channel, contactKey)` with `contactKey = HMAC-SHA256(SUPPRESSION_PEPPER, normalized contact)` (uniqueness applies to active rows only, see ADR-37), plus an optional plaintext column nulled on lead erasure. Keyed on contact, not lead, so merges, re-imports and erasure cannot drop it. LIVE refuses to boot without the pepper; it is backed up with the key ring.
- **Why:** A plain sha256 of an Indian mobile number is reversible by enumeration in minutes. With a pepper the key is pseudonymous (stated as such in `/docs/data-retention`).
- **Alternatives:** plaintext normalized contact (rejected), plain sha256 (rejected).
- **Reversibility:** 2 (re-keying needs the old pepper).

### ADR-20 DB, storage and backups outside OneDrive (A5)
- **Decision:** Default data dir `%LOCALAPPDATA%\auralead\<mode>\` (`app.db`, `storage\`, `backups\`, `outbound.lock`), overridable by env. Boot warns if a resolved path contains `OneDrive`. Test DBs in `os.tmpdir()`. Backups via `VACUUM INTO`, never a file copy.
- **Why:** The repo is in a OneDrive-synced folder with a space in its path; OneDrive sync corrupts WAL databases, locks `-wal`/`-shm` files and uploads PII to the cloud.
- **Alternatives:** DB in repo `prisma/` (rejected).
- **Reversibility:** 5.

### ADR-21 HOLD SCOPE removals (critic 12.4, ledger S1)
- **Decision:** Lead erasure is an admin script `npm run lead:erase -- --id`, not a UI. No `MessageCostEstimate` INR rate table; bulk preview shows template category and "in window (free) / paid template" only. Meta lead backfill is an on-demand "Backfill from form since T" action, not a scheduled poller. Super-admin re-auth kept only for global pause and elevated drilldown; invite + reset kept; MFA stays a limitation. Hindi STOP equivalents kept as a fixed small list. Also out: ad creation, workflow language, billing, calendar platform, in-app template authoring, GST split, automated cold email to Maps leads, deployment and real outbound sends.
- **Why:** User held scope (D1).
- **Reversibility:** 5 (each can be added later; C17 keeps a future erasure UI safe).

### ADR-22 Restore procedure pauses outbound and reconciles (O1)
- **Decision:** `npm run db:restore` writes `STORAGE_DIR/outbound.lock` first (worker honors it alongside the DB flag and env), restores the `VACUUM INTO` snapshot, marks every non-terminal DispatchAttempt created before the backup time as AMBIGUOUS, replays SuppressionJournal entries newer than the backup timestamp (ADR-38; this replaces the earlier "append-only audit export", which did not exist), and leaves outbound paused until an operator unpauses.
- **Why:** A restored backup can re-queue completed sends and erase later suppressions.
- **Reversibility:** 4.

### ADR-23 Approval binds to the exact outbound payload (O3)
- **Decision:** `Approval.payloadHash = sha256(canonical JSON of channel, destination key, template name + language, variables, body, subject, attachment {quoteVersionId, artifact sha256})`. Dispatch preflight recomputes it and refuses on mismatch with `APPROVAL_STALE`. Applies with or without a quote.
- **Why:** Binding only to the quote version lets the message text or recipient change after approval.
- **Reversibility:** 3.

### ADR-24 GatedAction gates only on configuration, permission, mode or eligibility (O4)
- **Decision:** The `reason` prop is a typed union of those four categories. Missing implementation fails milestone acceptance and may not be presented as a restriction. Lint bans `TODO`, "coming soon" and empty handlers in UI code; navigation omits unbuilt sections until their task lands.
- **Why:** Otherwise the truthfulness rule can be met on paper while features are missing.
- **Reversibility:** 5.

### ADR-25 Credential encryption with a key ring (A33)
- **Decision:** AES-256-GCM, 12-byte nonce, envelope `v1.<kid>.<nonce>.<ct>.<tag>`, AAD `workspaceId|integrationId|field`, `CREDENTIALS_KEYRING` + `CREDENTIALS_ACTIVE_KID`, `npm run creds:rotate`. Masked reads only, no reveal endpoint. LIVE refuses boot without keys; `npm run setup` generates demo keys into `.env` (ADR-44). The same ring encrypts webhook processing payloads (ADR-35).
- **Why:** PRD requires encryption with a deployment secret plus rotation and revocation; AAD stops ciphertext swaps across tenants.
- **Reversibility:** 3.

### ADR-26 Mutations through route handlers, not Server Actions
- **Decision:** All cookie-authenticated mutations go through `/api/app/*` and `/api/admin/*` route handlers wrapped by `withRoute()` (size cap, auth, rate limit, Origin + signed double-submit CSRF, Zod, ctx). RSC pages read through services. No Server Actions for mutations.
- **Why:** One CSRF model, one error mapping, and every mutation is reachable by the generated HTTP tenant matrix.
- **Alternatives:** Server Actions with Next's Origin check (rejected: second auth path to test).
- **Reversibility:** 4.

### ADR-27 Pipeline execution pins its config version (O5, P11)
- **Decision:** Each lead pins `pipelineConfigVersionId` at ingestion. Activating a new version affects new executions only. Switching HUMAN to POLICY_AUTO never auto-sends already queued approvals. The approval node is mandatory; POLICY_AUTO is selectable only when workspace auto-send is on, and dispatch checks still run. The graph is a validated list over five fixed stage kinds; no general workflow language.
- **Amended by:** ADR-43 (single orchestrator from M2 onward).
- **Reversibility:** 4.

### ADR-28 Revenue labels (O6)
- **Decision:** The dashboard shows "Pipeline value" (SENT + VIEWED quote totals) and "Accepted quote value". "Confirmed revenue" is shown as unavailable because there is no payment data.
- **Why:** Equating accepted quotes with revenue would overstate results; the PRD requires distinguishing pipeline value from confirmed revenue.
- **Reversibility:** 5.

### ADR-29 Window and delivery-status rules (C19, C10, A12, A13)
- **Decision:** Store `Conversation.lastInboundProviderAt` updated only by `max()`; `windowOpen(now) = now < lastInboundProviderAt + 24h`, exclusive, safety margin 0. Delivery status is rank-monotonic (pending < sent < delivered < read); `failed` changes state only at rank <= sent; later failures are stored as events with an anomaly flag.
- **Why:** A late older inbound can never shrink the window; deterministic merge is property-testable.
- **Reversibility:** 3.

### ADR-30 Provider error handling is table-driven and dated (C16, 12.3, A14)
- **Decision:** `adapters/whatsapp/error-map.ts` holds every provider code with a check date. 131049 maps to FAILED(`RECIPIENT_FREQUENCY_CAP`), back to review, manual retry only after 24 h, no automatic retry. 131026 maps to FAILED(`UNDELIVERABLE`), no retry, no suppression. No tier enums anywhere; quality and limits are stored as raw provider values. All codes are UNVERIFIED until checked and recorded in `docs/integrations.md`.
- **Why:** Auto-retrying a frequency-capped user degrades number quality; vendors disagree on code semantics.
- **Alternatives:** defer 24 h with one auto retry (02-errors, rejected by C16).
- **Reversibility:** 5.

### ADR-31 Quote math: half-up, document-level discount, one tax line (A1, A2, P8)
- **Decision:** Integer paise, rates in basis points, `mulDivHalfUp(a, bps) = (a*bps + 5000) / 10000`. Discount on the subtotal, tax on the discounted subtotal, each derived amount rounded once. One configured tax line; quotes say "Quotation, not a tax invoice"; explicit "no tax" setting required. Human over-limit discount 422 at the workspace limit, 403 beyond the actor's capability.
- **Why:** Reproducible by hand, matches AT5 (2,124,000 paise), avoids implying a GST invoice.
- **Alternatives:** banker's rounding (rejected), per-line tax (rejected), CGST/SGST/IGST split (out of scope).
- **Reversibility:** 1 (issued quotes freeze it).

### ADR-32 Tailwind 4 tokens via CSS `@theme`
- **Decision:** Design tokens from `reviews/ceo/06-design.md` §11.7 live in `src/styles/tokens.css` and are exposed through Tailwind 4 `@theme` in `globals.css`, not a `tailwind.config.ts`.
- **Why:** Tailwind 4.3 is CSS-first; the design review's `tailwind.config.ts` mention predates the pinned version. Token values are unchanged.
- **Reversibility:** 5.

### ADR-33 Next.js 16 conventions
- **Decision:** `src/proxy.ts` (Node runtime) replaces `middleware.ts` and only sets request IDs and headers; authorization and rate limits run in handlers. Route handler and page `params` are awaited Promises. Turbopack is the default bundler; native modules are listed in `serverExternalPackages`. `next lint` no longer exists, so `npm run lint` runs `eslint .` with `eslint-config-next`.
- **Why:** Next 16 behavior; reviewers' "middleware at the edge" concern is moot, but the conclusion (no authz in middleware/proxy) stands (critic 12.3).
- **Reversibility:** 3.

### ADR-34 UI pattern licensing
- **Decision:** shadcn/ui, Radix, Lucide, cmdk, Sonner, React Flow (attribution kept visible), three/r3f/drei, OFL fonts. Aceternity-style patterns are re-implemented with Motion and Tailwind, not copied; Magic UI free MIT components only, with headers. Everything listed in `THIRD_PARTY_NOTICES.md`.
- **Why:** Pro tiers are not redistributable; Aceternity free terms are not a standard OSI license per component (06-design §11.12).
- **Reversibility:** 5.

---

## Eng outside voice (Codex, 2026-10-15): E1-E12, all accepted

E11 (task ordering) changes no contract and has no ADR; it is applied in the plan's task list and §15.5.

### ADR-35 Webhook events keep an encrypted processing payload (E1)
- **Decision:** `WebhookEvent` stores `payloadRedacted` (inspector view) and `processingPayload`: the full parsed body encrypted with AES-256-GCM under the credentials key ring, AAD = `webhookEventId`. Workers decrypt only the processing payload. `webhook.purge` nulls it (`processingPurgedAt`) after successful processing plus a retention window (default 7 days; failed or unrouted events keep it until resolved or 30 days).
- **Why:** With only a redacted copy, a worker restart between persist and process loses the contact data needed to create the lead.
- **Alternatives:** store the raw body in plaintext (rejected: PII at rest in the inspector table); process inline in the route (rejected: violates verify, persist, 200).
- **Reversibility:** 4.

### ADR-36 Webhook idempotency is scoped by the authenticated source (E2)
- **Decision:** UNIQUE `(provider, scopeKey, externalKey)` where `scopeKey` is the routed `integrationId`, else the workspace of the authenticated token, else `unrouted`. A non-null scope column avoids SQLite's NULL-distinct uniqueness.
- **Why:** Sheets event ids and extension batch ids are client-generated; a global key lets one tenant's id block another's ingestion.
- **Reversibility:** 3.

### ADR-37 Suppression is append-only history (E3)
- **Decision:** Suppression rows carry `createdAt`, `clearedAt`, `clearedByConsentId`. PARTIAL UNIQUE on `(workspaceId, channel, contactKey) WHERE clearedAt IS NULL`. A re-opt-in clears the active row; a later Stop inserts a new active row. Re-opt-in evidence must be strictly newer than the latest Stop (active or cleared). Rows are never deleted.
- **Why:** With one unique row per contact, a second Stop after re-opt-in was undefined and old consent could be replayed against it.
- **Reversibility:** 2.

### ADR-38 SuppressionJournal outside the database (E8)
- **Decision:** `messaging/suppression.ts` is the only writer of Suppression rows. After commit it appends an fsynced JSONL line to `<DATA_DIR>/<mode>/journal/suppressions-YYYYMMDD.jsonl` with `journalId, workspaceId, contactKey, channel, action STOP|CLEAR, reason, createdAt, sourceEventId, suppressionId, consentId?`. If the append fails, the row's `journaledAt` stays null and `suppression.journalReconcile` re-exports it (idempotent by journalId). `db:restore` replays entries newer than the backup timestamp. Producer: T18, T20. Consumer: T24, tested against the real producer.
- **Why:** The restore procedure (ADR-22) depended on an "audit export" that nothing produced. A file outside the DB survives a DB restore.
- **Alternatives:** replay from AuditEvent (rejected: restored together with the DB, so later entries are lost).
- **Reversibility:** 4.

### ADR-39 Lease fencing inside every job-driven transaction (E5)
- **Decision:** Every transaction a job handler opens (preflight, settle, fail, domain writes) begins with a write-first fence `UPDATE "Job" ... WHERE id=? AND claimToken=? AND status='RUNNING'`. Zero rows throws `LeaseLostError` and rolls back before any domain write or provider call.
- **Why:** Checking the token only at final settle lets a worker that lost its lease run preflight and call the provider after another worker reclaimed the job.
- **Reversibility:** 4.

### ADR-40 Dispatch settle does not move a superseded quote (E6)
- **Decision:** Settle runs `UPDATE Quote SET status='SENT' WHERE id=? AND currentVersionId = attempt.quoteVersionId AND status='APPROVED'`. If no row changes, it sets only `QuoteVersion.sentAt` on the attempt's version and audits `quote.sent_superseded_version`.
- **Why:** A v1 send settling after v2 was revised and approved would otherwise mark v2 SENT without it being sent.
- **Reversibility:** 4.

### ADR-41 Dispatch failure classes (E7)
- **Decision:** `DispatchAttempt.failureClass` is PRE_SEND (definite pre-write failure), RETRYABLE (definite safe-to-repeat rejection: HTTP 429, 5xx with no-write evidence per the error map, SMTP 4xx) or PERMANENT (non-retryable 4xx). PRE_SEND and RETRYABLE requeue the job with backoff (honoring Retry-After; 429 also sets a throttle window); the retry is a new attempt N+1 that re-runs preflight. PERMANENT is never retried. Every error-map entry declares its class. Timeouts after write remain AMBIGUOUS.
- **Why:** Definite retryable rejections had no transition between "permanent failure" and "ambiguous".
- **Reversibility:** 4.

### ADR-42 workspaceId on every tenant table and same-workspace reference checks (E10)
- **Decision:** All tenant-owned tables, including children (PriceEntry, QuoteItem, JobAttempt, PipelineStageRun), carry `workspaceId`. Services call `assertSameWorkspace(tx, ctx, refs)` on every referenced id inside the transaction (404 on mismatch). Composite FKs `(workspaceId, parentId)` are used where Prisma 7 and SQLite accept them; T03 records which. The tenant matrix injects workspace B ids into mutation bodies.
- **Why:** Child rows without workspaceId allowed cross-tenant references that the scoped client could not catch.
- **Reversibility:** 1.

### ADR-43 Single pipeline orchestrator from M2 (E9)
- **Decision:** Ingestion enqueues only `pipeline.advance`. The executor (shipped in T10) reads the pinned PipelineConfigVersion, runs one stage at a time, and records `PipelineStageRun` with UNIQUE (executionId, stage). T12 and T14 register the SCORE and DRAFT stage handlers; T23 adds APPROVAL and DELIVERY and graph validation.
- **Why:** If ingestion enqueued score and draft jobs directly, the React Flow pipeline would be decorative and replays could run stages twice.
- **Reversibility:** 3.

### ADR-44 One env file and one loader (E12)
- **Decision:** `npm run setup` writes `.env` (gitignored) from `.env.example` with generated demo secrets and never overwrites existing keys. `src/lib/env-load.ts` loads `.env` without overriding real environment variables and is called first by `next.config.ts`, `prisma.config.ts`, the worker, the seed and every script. No `.env.local`.
- **Why:** The plan had setup writing `.env.local` while the worker loaded `.env`, so app and worker could disagree on secrets and DB path.
- **Reversibility:** 5.

### ADR-45 Send intent is persisted and checked at dispatch (E4)
- **Decision:** Message and DispatchAttempt carry `sendIntent` (MANUAL_SINGLE, BULK, AUTOMATED, CUSTOMER_REQUESTED_REPLY) and `initiatedBy`, set at creation and immutable. Eligibility reads the persisted intent. A new ordered check `AUTO_SEND_DISABLED` skips automated attempts when workspace auto-send is now off or the pinned pipeline is no longer POLICY_AUTO for attempts created by a POLICY_AUTO approval. An unapproved CUSTOMER_REQUESTED_REPLY counts as automated. Attested-B2B email requires MANUAL_SINGLE.
- **Why:** Without persisted provenance, dispatch could not tell automated work from manual sends, so disabling auto-send would not stop work already queued.
- **Reversibility:** 3.

### ADR-46 Test teardown kills the process tree first on Windows (T02)
- **Decision:** `tests/support/spawn.ts` `terminate()` runs `taskkill /T /F /PID <pid>` first on Windows and uses `child.kill('SIGKILL')` as the fallback (POSIX: SIGKILL). The plan text listed SIGKILL first with taskkill as the fallback.
- **Why:** On Windows `child.kill('SIGKILL')` terminates only the direct child; once the parent is gone, `taskkill /T` can no longer find the tree, so grandchildren would be orphaned. `tests/integration/spike/teardown.test.ts` asserts that both the child and its grandchild are gone.
- **Alternatives:** SIGKILL first plus per-test tracking of descendant pids (rejected: fragile).
- **Reversibility:** 5.

### ADR-47 Full schema: partial indexes via the Prisma preview feature, composite tenant FKs, small schema additions (T03)
- **Decision:**
  - **Partial unique indexes** are declared in `schema.prisma` with the `partialIndexes` preview feature (`@@unique([...], map: ..., where: raw("..."))`, Prisma 7.10.0) instead of SQL hand-written only in the migration. Prisma generates them into the migration SQL, where each one is still marked `-- PARTIAL UNIQUE`. There are eight: Suppression active row, one active PricingVersion, ScoringConfigVersion and PipelineConfigVersion per workspace, one APPROVED quote-version Approval per version, one PENDING or APPROVED Approval per message, one open Conversation per (workspace, lead, channel), and one unrouted WebhookRejection counter per (provider, reason, day).
  - **Composite foreign keys** `(workspaceId, parentId) -> parent(workspaceId, id)` are accepted by Prisma 7.10 and SQLite for every tenant child-to-parent reference, including optional ones. The parent carries `@@unique([workspaceId, id])`. `tests/unit/arch/tenant-columns.test.ts` enforces this for every reference between tenant models.
  - **Service-enforced, not foreign keys:**
    - `Suppression.clearedByConsentId`, because a suppression must survive lead erasure.
    - Every `Job.workspaceId`, `JobAttempt.workspaceId`, `AuditEvent.workspaceId`, `WebhookEvent.workspaceId` and `WebhookRejection.workspaceId`, because these are nullable system rows.
    - `WebhookEvent.integrationId`, `PipelineStageRun.jobId`, `Session.activeWorkspaceId`, and the `createdBy`, `decidedBy` and `requestedBy` user-id columns.
  - **Additions the §5 tables did not spell out:**
    - `Conversation.closedAt` defines "open" for the open-conversation partial unique.
    - `Message.channel` is the provider namespace for `(channel, providerMessageId)` UNIQUE. `DispatchAttempt` uses the same `(channel, providerMessageId)` UNIQUE.
    - `WebhookRejection` gets an extra partial unique for null-workspace rows, because NULLs are distinct inside the plain unique.
    - `Quote.currentVersionId` is nullable, but only inside the creating transaction: Quote and QuoteVersion reference each other, and SQLite FKs are not deferrable.
    - `Quote.validUntil` is nullable until version 1 exists.
    - Inline value sets became enums: TaxMode, QuoteSentVia, UaClass (BROWSER, LINK_PREVIEW, BOT, UNKNOWN), MessageKind, TemplateIntent and ActorKind.
    - `Lead.pipelineConfigVersionId` is nullable for leads created before a pipeline exists.
  - **One-to-one uniques stay single-column:** `QuoteAcceptance.quoteVersionId`, `QuoteArtifact.quoteVersionId` and `PipelineExecution.leadId`. Their back-relations are lists, because Prisma requires a composite unique for a 1:1 over a composite FK.
- **Why:** If the indexes lived only in hand-written migration SQL, they would be invisible to Prisma's diff, and the next `prisma migrate dev` would emit `DROP INDEX` for them as drift. With the preview feature, `prisma migrate diff` from the migrated DB to the schema is empty (verified). The DB-level composite FKs back up `assertSameWorkspace` (E10).
- **Caveat:** The preview feature also exposes the partial-unique fields in the generated `WhereUniqueInput`; for example, `PricingVersion` accepts `where: { workspaceId }` and `Suppression` accepts `workspaceId_channel_contactKey`. Do not use them for `findUnique` or `upsert`, because they are unique only among the rows that match the predicate. Look up active rows with `findFirst` plus the predicate, such as `active: true` or `clearedAt: null`.
- **Alternatives:** Hand-written SQL only, as the plan text says. It was rejected because of the drift problem above. If the preview feature regresses, fall back to hand-written SQL and pass `--create-only` on every later migration so the DROP INDEX lines can be removed by hand.
- **Reversibility:** 3.

### ADR-48 Job runtime details the plan left open (T07)
- **Decision:**
  - **Worker bundle name.** The `build` script now runs `tsup --entry.worker worker/index.ts ...`. Before, it ran `tsup worker/index.ts`, which writes `dist/index.js`, while `start:worker` and the E2E harness run `dist/worker.js`. This is the only non-append edit to `package.json`. Verified: the bundle refuses to start on an unmigrated DB (exit 1) and starts on a migrated one.
  - **Handler contract.** A handler returns `succeeded | deferred | retry | dead | cancelled`, and any of these may carry a `finalTx`. The runner runs `finalTx` inside the fenced settle transaction, so a domain write and the job's final state commit together. Writes made earlier in a handler go through `ctx.fencedTx`. A thrown `AppError` with `retryable` (or `DB_BUSY`) is retried; `LEASE_LOST` is a lost lease; any other thrown error is fatal (`DEAD`, `deadReason = FATAL`).
  - **Max attempts per kind.** A job's limit is stored in `Job.maxAttempts` at enqueue time, taken from `kind` (send 5, ai 3, fetch 8, pdf 3, default 5) or set explicitly.
  - **Attempt numbers.** `JobAttempt.attemptNo` is sequential per job and does not follow `Job.attempts`. Deferrals refund `Job.attempts` (plan §4.3), so reusing it would collide on `(jobId, attemptNo)`. A deferral is logged as `DEFERRED`, a cancel as `FATAL` with `errorCode = JOB_CANCELLED` (the enum has no CANCELLED outcome), and a reaped lease as `LEASE_LOST` (or `AMBIGUOUS` when a SENDING DispatchAttempt existed).
  - **Reaper at max attempts.** An expired lease on the last allowed attempt goes `DEAD(MAX_ATTEMPTS)` instead of being requeued.
  - **Background writes are transactions.** Heartbeat, lease extension, claim and reaper writes all run through `withTx`. The adapter keeps one connection per client and serializes interactive transactions, so a background write can never land inside a handler's open transaction.
  - **Pause points.** They are file-based across processes: `AURALEAD_PAUSE_DIR` plus `AURALEAD_PAUSE_AT`, `<name>.reached.json` and `<name>.release`. In-process tests use `setPauseHandler`. All of this is a no-op unless `NODE_ENV=test`. These test-only variables are not added to `.env.example`.
  - **Concurrency is 1.** The configurable concurrency of up to 4 for provider-bound types is not built yet. The task that first needs it (T19 or later) adds it behind `createWorker`.
- **Why:** The plan fixes the behavior (claim, fence, reaper, backoff, heartbeat, shutdown) but not these mechanics. Each choice is covered by `tests/integration/jobs/*.test.ts`.
- **Reversibility:** 4.

### ADR-49 Design system and app shell details (T08)
- **Decision:**
  - **shadcn output, verified imports.** I ran `npx shadcn@4.21.5 add button input label badge card dialog alert-dialog dropdown-menu sheet separator skeleton command sonner popover tooltip` in a scratch project that had the same `components.json` (style new-york, Tailwind 4, `aliases.utils = @/components/ui/cn`). The CLI writes files and runs `npm install`, which would add unpinned packages, so it was not run in the repo. I copied the files into `src/components/ui/` and made two import fixes:
    - Every generated file had `import { cn } from "cn"`, and the CLI also added the unpinned `cn@^0.4.0` package. I rewrote these to `@/components/ui/cn`, which is clsx 2.1.1 plus tailwind-merge 3.7.0 (both pinned).
    - `sonner.tsx` imported `next-themes`, which is not a dependency. The panels have one dark theme, so I removed that import and fixed the theme to dark.
    - Radix imports use the unified `radix-ui` 1.8.1 as generated (for example `import { Dialog as DialogPrimitive } from "radix-ui"`).
    - `components.json` is committed at the repo root. Future `shadcn add` runs must use the same scratch-project method and the same two import fixes. No new packages were added.
  - **Token naming in Tailwind.** Raw tokens stay in `src/styles/tokens.css` under the plan's names (`--accent` is cyan). In `@theme`:
    - Utilities are `bg-bg-0..3`, `text-fg-1..3`, `cyan`, `ai`, `demo`, the status tones, and the paper set.
    - Tailwind's `accent` color follows shadcn semantics (the bg-3 hover surface).
    - Cyan is exposed as `primary` and `cyan`.
    - The type scale overrides Tailwind's (`text-base` is 14/20, `text-md` 16/24) and drops `text-7xl` through `text-9xl`. Radii map to 4/6/8/12/16.
    - The html element carries the class `dark` so shadcn's `dark:` variants apply.
  - **Role switcher gating (P19).** `src/components/patterns/DemoChrome.tsx` is the only importer of `RoleSwitcher.tsx`. Each import is `process.env.NEXT_PUBLIC_APP_MODE === 'demo' ? dynamic(() => import('./RoleSwitcher')...) : null`.
    - `tests/unit/arch/live-bundle.test.ts` proves the module drops out of the bundle. It bundles the gate with Vite 8/Rolldown in both modes and walks the import graph.
    - I also checked a real `next build` with NEXT_PUBLIC_APP_MODE=live: zero client or server chunks contain the switcher.
    - The switcher is a floating control on every route, mounted in the root layout. In DEMO the `/login` page shows only the seeded identities, via the same gate.
    - It has no Landing or Docs links yet, because `/` (T30) and `/docs` (T37) do not exist. Those tasks add the links.
  - **Panel chrome read model.** `src/server/services/shell/panel-chrome.ts` (`loadPanelChrome`) is a new file outside T08's listed paths. It is needed because layouts read through services, never Prisma (plan §4). It lists memberships (USER) or active assignments (EMPLOYEE) for the actor's own mode. It also returns the global outbound pause (SystemSetting or `OUTBOUND_PAUSED`) and the workspace automation pause.
  - **Panel layouts.** With no session, a layout redirects to `/login`. A session of another role gets 404 (A6, the same answer as any route the actor cannot see).
  - **Login page styling.** I edited `src/app/(auth)/**` (T06's files, as the T08 goal says) and added `auth-frame.tsx`. The login page reads `getConfig().mode` and is `force-dynamic`.
  - **Patterns built now:** StatusBadge (with ModeChip), GatedAction, EmptyState, ErrorState, LoadingSkeleton, PartialNotice, ConfirmDialog, ModeBanner, RoleSwitcher, WorkspaceChip, UserMenu, CommandPalette, PanelNav, PanelShell, Providers, ProductMark, and the `postJson` CSRF helper.
  - **Patterns deferred:** BulkResultSummary, ConsentChips and ScoreBreakdown depend on domain data. Their owning tasks build them (T26/T27, T18, T12).
- **Why:** The plan pins the stack and the vocabulary, but not these mechanics. The generated `cn` and `next-themes` imports would have added unpinned dependencies.
- **Reversibility:** 4.

### ADR-50 Seed, route manifest and E2E harness details (T09)
- **Decision:**
  - **Deterministic seed ids.** Every seeded row gets an id from `prisma/seed/ids.ts` (`seedId(kind, key)`: sha256 of a stable key, shaped like a cuid2). Every timestamp derives from one anchor (`SEED_NOW`, else the current time floored to the hour). Two seeds with the same anchor have the same content hash, and `demo:refresh` can re-base times without touching ids (R43, P20).
  - **Seed safety and reset.** `seedDemo` refuses an already-seeded DB (`AlreadySeededError`; the CLI prints it and exits 0). `resetAndSeedDemo` wipes every application table (except `_prisma_migrations` and `WorkerHeartbeat`) inside one transaction with deferred foreign keys, then seeds. Both call `assertDemoSeedTarget` before any read or write, and the reset calls it again inside its transaction. `npm run db:reset` is `prisma migrate deploy && tsx prisma/seed/index.ts --reset`, not `prisma migrate reset`: the Prisma command would drop the DB before our LIVE refusal could run. `prisma.config.ts` gets `migrations.seed` for `prisma db seed` (Prisma 7 never seeds on its own).
  - **demo:refresh anchor.** The seed writes a `demo.seed` AuditEvent whose summary carries `anchorAt`. `demo:refresh` reads the latest anchor (highest `seq`) and shifts every column in `prisma/seed/rebase.ts` (`REBASE_COLUMNS`) by `now - anchor`. It then writes a `demo.refresh` AuditEvent with `{anchorAt, previousAnchorAt, seq}`. Audit rows are never re-based. T24 appends its window and expiry columns to `REBASE_COLUMNS`.
  - **Seed fixtures.** There are five DEMO workspaces: a dental clinic in Gurugram and an e-commerce brand in Noida (Delhi NCR), a gym in Mumbai, and a property agency and a freelance design studio in Bengaluru. The business's city appears in its quotation terms, because Workspace has no city column. Users: the three DEMO_PERSONAS, one owner per workspace, one MEMBER, `neha` (EMPLOYEE assigned to ironpulse with `leads.read` only), `arjun` (EMPLOYEE, no assignment) and one inactive assignment. Every user is `isDemo`, has no password and has a `.test` email. Scoring v1 `weights` is `{schemaVersion: 1, weights: {...sums to 100}, notes}`; T12 owns the Zod schema and may change the shape through a new version. Pipeline v1 is `{schemaVersion: 1, stages: [{id, kind, label}] x5, edges}` with HUMAN approval.
  - **Files outside T09's Owns list.**
    - `src/app/api/health/route.ts`: GET returns 200 `{status, mode}` after a DB ping, or 503. The harness and `npm run verify` need it, and no task owned it.
    - `src/app/api/test/reset/route.ts`: test control only. T06 handed it to T09 because it needs the seed. It imports `prisma/seed/seed.ts`.
    - `src/server/services/shell/panel-home.ts`: read models for the panel home pages. Pages read through services, never Prisma (same reason as ADR-49).
  - **Route manifest shape.** `src/server/routes.manifest.ts` holds data only. Each entry has `path`, `file`, `kind`, `owner`, `access`, `roles?`, `capability?`, `params?` (fixture refs) and `calls`. Each call has a method, an explicit status for each of the 5 matrix actors, a body or query, and `foreignRefs` (body key -> fixture key of a workspace B id, which must give 404 or 422). `crawlAs` is for the AT1 crawl. Fixture refs (`{ $fixture: 'workspaceB.slug' }`) resolve in `tests/support/routes.ts` against the seed. The matrix runs pages in-process: their layouts (except the root layout, which only holds fonts) and then the page, with `next/headers` mocked to the request headers. Next's `redirect()` and `notFound()` digests map to 307 and 404.
  - **E2E harness and the LIVE bundle.**
    - `next.config.ts` reads `distDir` from `AURALEAD_NEXT_DIST_DIR` (default `.next`). The harness builds LIVE into `.next-live`, so the DEMO and LIVE builds can be served side by side for the P19 "LIVE build has no switcher" check.
    - `.next-live/` was added to `.gitignore` and the ESLint ignores. Next itself adds `.next-live/types/**/*.ts` and `.next-live/dev/types/**/*.ts` to `tsconfig.json` `include` on a LIVE build (and reformats that file).
    - The harness reads the worker heartbeat with Node's built-in `node:sqlite` (no Prisma in the Playwright process).
    - It keeps its state file in `os.tmpdir()/auralead-e2e-harness.json`, outside `test-results/`, which Playwright cleans.
    - Set `E2E_SKIP_BUILD=1` to reuse existing builds.
  - **Setup-only test sandbox.** `tests/integration/setup/setup-only-config.test.ts` points the OS data-dir variable (`LOCALAPPDATA`, or `XDG_DATA_HOME` off Windows) into its temp dir, so the default data path resolves there instead of the developer's real `%LOCALAPPDATA%\auralead`. Every app variable is removed from the child env; the only app configuration is the `.env` that `scripts/setup.ts` wrote.
- **Why:** The plan fixes the goals (deterministic seed, reset, refresh skeleton, manifest-driven matrix, built-app harness) but not these mechanics. Each item is covered by `tests/integration/seed/*`, `tests/integration/authz/tenant-matrix.test.ts`, `tests/unit/arch/route-manifest.test.ts`, `tests/integration/setup/setup-only-config.test.ts` and `tests/e2e/smoke/shell.spec.ts`.
- **Reversibility:** 4.

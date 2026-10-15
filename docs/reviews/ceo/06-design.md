# Section 11 Design & UX Review

# Section 11: Design & UX Review

**Mode:** HOLD SCOPE. Nothing is added or cut. Every remedy below either fills a gap inside the PRD or turns a PRD clause into something testable.
**Inputs:** `docs/PRD.md`, sections "Pages and panels", "Visual design", "Scope and truthfulness", "Messaging rules", "AI and quotation engine", "Security and operations" and acceptance test 15.
**Verdict:** The visual intent is sound and safe from slop on paper ("avoid excess glow, unreadable transparency, fake testimonials, random animated numbers"). The PRD does not define these:
- a state model for the UI
- a mode or status vocabulary
- workspace context for employees
- light-theme parity between the quote page and the PDF
- glyph coverage for ₹

Each one could make the "truthful UI" contract fail without anyone noticing. No finding needs a material decision. One permission default (11.F7) is recorded as an assumption and flagged for visibility.

---

## 11.1 Findings summary

| # | Severity | PRD clause | Finding | Remedy | Type |
|---|---|---|---|---|---|
| F1 | CRITICAL | Quote engine: "real downloadable PDF"; Acceptance 6 "PDF matches HTML totals" | Common server PDF engines ship base-14 fonts (Helvetica) that have no ₹ (U+20B9) glyph. `next/font/google` with `subsets:['latin']` also drops U+20B9, which sits in **latin-ext**. Amounts would render as tofu boxes or fall back to "Rs" in one surface but not the other, which breaks parity. | Embed one TTF that contains U+20B9 (Inter, OFL) in the PDF renderer. Load web fonts with `subsets:['latin','latin-ext']`. One `formatINR()` in `src/lib/format/money.ts` uses `Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'})` to give Indian grouping (₹21,240.00, ₹1,23,456.00). Vitest asserts the glyph is present in the embedded font. A Playwright test compares PDF text extraction with the HTML totals. | (a) |
| F2 | CRITICAL | Scope: "Persistent Demo label"; "Never silently fall back to simulated success" | The PRD names "Demo" and "Not configured / Verification required" but gives no closed vocabulary. Ad hoc badges per page will drift, and a simulated "Delivered" will look the same as a real one. | Define one `IntegrationStatus` enum and one `DeliveryStatus` presentation (11.6) in `src/components/patterns/StatusBadge.tsx`. Every simulated record carries `simulated=true` and renders a "Simulated" chip next to its status, always. A lint-style unit test fails if a status renders without its mode chip. | (a) |
| F3 | CRITICAL | Scope: "No decorative controls. Every visible action performs ... explains a real restriction, or navigates to configuration" | The PRD does not say how a blocked action explains itself. A tooltip on a disabled button cannot be reached by keyboard or touch, so that explanation does not count. | Pattern `GatedAction`: when blocked, the button stays focusable (`aria-disabled="true"`, not `disabled`) and an inline reason line sits below it, e.g. "WhatsApp window closed 2h ago. Use an approved template." Where a fix exists it carries a link such as "Configure WhatsApp". A Playwright test walks every gated action at 390px. | (a) |
| F4 | CRITICAL | Quote: "Unguessable revocable expiring share credentials"; Acceptance 7 | `/quote/[id]` has no state design for invalid, expired, revoked, cancelled, superseded or already-accepted links. A generic 404 for every case hides real outcomes from the customer. | `/quote/[shareId]`: `shareId` is the opaque credential, not the `Quote.id`. Distinct pages per state (11.4.6). Revoked and invalid both render the same neutral "This link is not available" (no oracle). Expired and superseded name the sender to contact. Repeat accept shows "Accepted on 15 Oct 2026, 14:02 IST". | (a) |
| F5 | CRITICAL | Messaging: "Free-form eligibility computed server-side at dispatch" | A 24h countdown in the composer will be read as a promise. A user who types for 10 minutes across the boundary gets a silent failure. | Composer shows "Free-form window: closes 18:42 IST (about 3h)". It recomputes every 60s from the server-provided `windowExpiresAt` and states "Final check happens at send". If dispatch is refused, the draft is kept and the action switches to "Send approved template" or "Return to review". Never optimistic "Sent". | (a) |
| F6 | CRITICAL | Shared: "pending/sent/delivered/read/failed"; Acceptance 11 "ambiguous timeouts visible, no blind resend" | The listed statuses have no UI for the ambiguous outcome. | Add the display state **Unknown (provider timeout)** with the copy "Not retried automatically to avoid a duplicate". Actions: "Check provider status" (live) and "Mark failed and requeue" (confirm dialog, audited). Admin job inspector shows the same item. | (a) |
| F7 | WARNING | Shared: "Auto-send is opt-in per workspace, audited"; Client Inbox "AI mode" | Not specified: who may enable auto-send, and how AI mode relates to the workspace setting. | Assumption: workspace owner (client) and employees granted the `automation.manage` capability may toggle workspace auto-send. Per-thread AI mode is one of `Off`, `Draft for approval` (default) or `Auto` (only selectable when workspace auto-send is on). Human takeover overrides all three until "Resume AI". Every toggle opens a confirm dialog and writes an AuditEvent. This touches permissions, but it follows the PRD's own "client owns workspace" and "granted capabilities", so it is recorded rather than asked. | (a), flagged |
| F8 | WARNING | Roles: "employee (assigned workspaces)"; "Never trust browser-supplied workspace IDs" | The PRD does not show the employee's current workspace context. Bulk actions in the wrong tenant are the top operator error. | Route `/dashboard/employee/[workspaceSlug]/...`. The server resolves the slug and asserts the assignment on every request, so the slug is a hint and not a source of trust. A persistent workspace chip in the top bar shows name, plan label and mode. Every bulk confirm dialog repeats the workspace name. The switcher lists assigned workspaces only. | (a) |
| F9 | WARNING | Admin: "workspace drilldowns (audited)" | Drilldown can look the same as the workspace owner's view. | When super admin views a workspace: a violet-free, neutral-outlined banner "Viewing Acme Clinic as Super Admin. This view is audited." Read-only by default. Write actions live only under the admin routes and are each audited. | (a) |
| F10 | WARNING | Demo mode; Quote PDF | Demo quote PDFs and links can leave the system (download, screenshot). Without a mark they read as real offers. | In DEMO, the `/quote` page and the PDF carry a diagonal footer watermark "DEMO: not a valid offer" plus a header ribbon. Live mode has none. A test asserts the watermark appears only in demo. | (a) |
| F11 | WARNING | Visual: "avoid ... random animated numbers"; Command center "DB-derived counts" | Count-up animations and "live" pulses are the default in Aceternity/Magic UI-style templates. They break this clause. | Metrics render static, each with "As of 14:05 IST" and a refresh action. No count-up, no number tickers, no fake sparklines. Charts animate entry only once, at 200ms or less, and not at all under reduced motion. | (a) |
| F12 | WARNING | Landing: "three-panel previews"; "fake testimonials" | Previews tend to become invented dashboards with made-up figures. | Previews are real panel components rendered with seeded demo data and a visible "Demo data" chip, or screenshots captured from the seeded build by a Playwright script (`scripts/capture-previews.ts`). No logos wall, no testimonials, no "trusted by". ROI calculator carries "Illustrative estimate. Edit the assumptions." with every input visible. | (a) |
| F13 | WARNING | Leads: "Kanban"; Pipeline: "React Flow" | Drag-only interaction fails keyboard and touch accessibility, and React Flow is unusable at 390px. | Kanban: every card has a "Move to stage" menu (keyboard and touch). Drag is an enhancement and uses the same mutation. React Flow below 768px is read-only with a "Edit on a larger screen" note and a list view of the stages. Editing has a keyboard path: select node, then menu. Cycle or unsupported-edge rejection shows inline on the offending edge plus a summary. | (a) |
| F14 | WARNING | Quote: "Branded HTML quote ... print styling" | Workspace brand colors can fail contrast on the quote page. | `/quote` uses a light paper theme to match the PDF. The brand color is used for accents only. If it is under 4.5:1 on #FFFFFF it is darkened in OKLCH lightness until it passes for text and kept raw for decorative rules. A unit test covers this. | (a) |
| F15 | WARNING | Visual: "controlled glass" | Glass under dense text fails contrast on busy backgrounds and costs GPU on low-end Android. | Glass only on: the landing nav, landing preview frames, the cmdk palette and the dashboard sticky top bar. Surface alpha 0.72 or more and blur of 16px or less. `@supports not (backdrop-filter)` falls back to solid `bg-2`. Never behind tables, forms or the composer. | (a) |
| F16 | WARNING | Leads: "consent"; Messaging consent rules | Consent per channel and suppression can be compressed into one "Consented" badge, which is false. | `ConsentChips` shows WhatsApp and Email separately, each with one of `Opted in` (with purpose, source and date in a popover), `No evidence`, `Opted out` or `Suppressed (Stop, 12 Oct)`. Maps leads show "No evidence" for WhatsApp by default. | (a) |
| F17 | WARNING | Ingestion: "opportunity score 0-100 with reasons and unknown inputs; heuristic, not intent or consent" | A bare score number implies intent. | `ScoreBreakdown` shows the score, then the contributing reasons (+/- points), then "Unknown inputs" (for example "Website: unknown, not verified absent"). The fixed caption reads "Heuristic fit score. Not purchase intent or consent." | (a) |
| F18 | WARNING | Approvals: "Material edit after approval invalidates approval" | The approver may not see what changed between versions. | The approval item shows `v3 (current)` against `v2 (approved, now invalidated)` with a line-item diff (quantity, unit price, discount, total). The approve button binds `versionId`. A stale tab gets "This item changed since you opened it" and does not approve. | (a) |
| F19 | WARNING | Acceptance 13 "Bulk actions report eligible/skipped/failed" | No result surface is defined. | Pre-flight dialog: "42 selected: 30 eligible, 12 skipped (8 no WhatsApp opt-in, 4 suppressed)". The action is applied to the eligible rows only. A result drawer `BulkResultSummary` follows, with grouped reasons, a per-row list and "Select skipped rows". The result persists as a Job, so it is retrievable after reload. | (a) |
| F20 | WARNING | Meta: "pause/resume with confirmation ... provider result" | A confirmation is required but its content is not specified. | The dialog states campaign name, current status, target status, mode (Demo: "Simulated, no provider call" / Live: "Calls Meta Marketing API"), and that it is audited. After confirm: Pending, then the provider result shown verbatim but redacted. Failure is never shown as success. | (a) |
| F21 | OK | Visual: "Test 390/768/1440/1920; tables scroll internally" | Covered. 11.8 adds layout rules. | | |
| F22 | OK | Visual: "Lazy-load WebGL ... static fallback" | Covered. 11.10 makes it testable. | | |
| F23 | WARNING | Stack: "Aceternity/Magic UI-style patterns where licenses permit" | License terms differ by product tier (11.12). | Default to re-implementing patterns with Motion plus Tailwind, or MIT Magic UI free components only, with attribution. Verify at implementation time. | (a) |

---

## 11.2 Information architecture

Global chrome for authenticated panels: a `ModeBanner` (DEMO, 11.6) at the very top, then the top bar with the product mark, `WorkspaceChip` (employee and admin), the cmdk trigger (`Ctrl/Cmd+K`), the demo-only role switcher and the user menu. A left nav sits at 1024px and above; below 1024 the nav moves to a drawer and the primary sections to a bottom tab bar.

### 11.2.1 Route map

```
/                                  public landing
/docs, /docs/[...slug]             public docs (MDX)
/quote/[shareId]                   public quote (credentialed)
/login                             live auth; demo shows seeded identities only

/dashboard/user                    Command center
  /leads            /leads/[leadId]
  /inbox            /inbox/[conversationId]
  /pricing          (services, branding, tax, discounts, timelines, history tabs)
  /quotations       /quotations/[quoteId]   /quotations/new?leadId=

/dashboard/employee                Assignment overview -> picks workspace
  /[ws]/leads       Lead console
  /[ws]/sheets      Sheets/Form setup
  /[ws]/meta        Meta console
  /[ws]/extension   Extension hub
  /[ws]/approvals   Approval queue (also cross-ws view at /dashboard/employee/approvals)
  /[ws]/integrations
  /[ws]/pipeline    React Flow

/dashboard/admin                   Global metrics
  /workspaces       /workspaces/[id] (audited drilldown)
  /people           users, employees, memberships, assignments, plan labels
  /productivity     /audit          /jobs   /webhooks
```

### 11.2.2 What each surface shows first, second, third

| Surface | 1st (above fold) | 2nd | 3rd |
|---|---|---|---|
| Landing `/` | Hero: one-line value prop (max 56px desktop / 36px at 390), one primary CTA "Open live demo", one secondary "Read the docs", globe/AI core on the right (static poster first, WebGL after idle) | Animated pipeline Source → Score → Quote → Message, with each stage labeled by what actually happens (e.g. "Prices resolved from your matrix, never by AI") | Feature bento, three-panel previews ("Demo data"), ROI calculator, then a truthfulness strip covering modes, consent and approval-by-default. Footer links to docs. |
| User command center | KPI row: New leads (7d), Open conversations, Quotes awaiting approval, Pipeline value vs Confirmed revenue (definitions in an info popover: pipeline = SENT+VIEWED quote totals, confirmed = ACCEPTED) | "Needs you" list: approvals pending, invalidated approvals, failed or unknown deliveries, takeover threads | Funnel by sales stage, activity feed (from AuditEvent), optional small 3D tile at 1440px and above |
| User Leads | Table: search, filters (stage, source, score band, consent), saved sort, pagination | Lead detail side sheet: contact, source record, score breakdown, consent chips, stage history | Kanban toggle (persisted per user in localStorage) |
| User Inbox | Thread list with channel icon, last message, status, AI mode, window state | Thread view: messages with status ticks, AI drafts styled distinctly, takeover banner | Composer with eligibility line, template picker, send/approve |
| User Pricing | Services table with active PricingVersion | Tax, discount limits, timelines, branding preview | Version history (read-only snapshots) |
| User Quotations | List by state with totals | Quote detail: line items, snapshot version, state timeline, share controls | Revise, approve, share (create/revoke/expiry), download PDF, view evidence ("Link opened 2x, last 14:10 IST. Opens do not confirm a person read it.") |
| Employee overview | Assigned workspaces with counts needing action | Cross-workspace approval count | Integration health summary per workspace |
| Employee Lead console | Workspace chip and table with bulk select | Eligibility pre-flight and draft generation | Per-lead draft and quote proposal review |
| Sheets setup | Status card (Not configured / Verification required / Connected) | Config, then mapping, then preview of mapped rows, then validation errors | Apps Script copy block, sync log, simulate button (demo) |
| Meta console | Connection status and permissions | Campaign table: spend, leads, CPL, status, pause/resume | Lead event log, audit |
| Extension hub | Token list (masked, scope, created, last used, revoke) | Batches: status, counts, per-row failures | Webhook config, example payload, simulate batch |
| Approvals | Queue sorted by age, version badge | Item detail with diff and pricing checks | Approve / reject / approve-and-send / automation pause |
| Integrations | Grid of `IntegrationStatusCard` (WhatsApp, Email, Meta, Sheets, AI providers, Extension) | Per-card setup, test connection, last check time | Quality/limits (or "Unknown, last checked ..."), internal caps clearly labeled "Internal cap, not a provider limit" |
| Pipeline | Canvas with five allowed node types | Validation panel | Persisted versions and execution status per stage |
| Admin | Global metrics with workspace table | Drilldown (audited banner) | People, productivity (each metric has a definition footnote), audit search, job/webhook inspector |
| `/docs` | Left nav grouped by role and workflow | Article with "Applies to: Demo / Live" tags | Troubleshooting and limitations always one click away |
| `/quote/[shareId]` | Workspace brand header, quote number, version, validity date, total | Line items, tax, discount, terms, timeline | Accept (with name), Download PDF, contact sender |

---

## 11.3 Interaction state coverage map

Legend: every cell must be implemented and have a test (component test in Vitest + Testing Library, or a Playwright fixture). "-" means not applicable.

| Feature | LOADING | EMPTY | ERROR | SUCCESS | PARTIAL |
|---|---|---|---|---|---|
| Command center KPIs | Skeleton tiles, fixed height (no layout shift) | "No leads yet" + "Simulate a lead source" (demo) / "Connect a source" (live) | Per-tile error with retry; other tiles still render | Values + "As of" timestamp | Some metric queries failed: show available, mark failed tile |
| Leads table | Skeleton rows (10) | Filters active: "No leads match" + "Clear filters"; none at all: source CTAs | Inline banner + retry; keep stale rows marked "May be outdated" | Rows, count, pagination | Some rows with dedupe conflict: "In review" chip + link |
| Lead detail | Sheet skeleton | - | "Lead not found or not in this workspace" (same copy for both) | Full detail | Enrichment pending/failed: "Website: unknown" |
| Kanban stage move | Card shows pending spinner, optimistic position | Column empty hint | Revert card, toast with reason | Toast "Moved to Contacted" | - |
| Inbox thread list | Skeleton | "No conversations" + explainer on how threads start (inbound or approved template) | Retry banner | Threads | Channel not configured: threads visible, composer gated |
| Composer send | Button "Queuing..." (disabled against double click; idempotency key) | - | Refusal with reason + next action (template / review) | "Queued", then live status updates | Email fallback deferred / WhatsApp throttled: "Deferred until 15:30 IST" |
| Delivery status | Pending | - | Failed (redacted reason) | Sent / Delivered / Read | Unknown (provider timeout), out-of-order resolved to the latest known state |
| AI draft generation | Streaming not required; "Generating draft (local generator)" with provider label | - | "AI provider unavailable. Use the local generator or edit manually." Never a silent switch in live | Draft card, violet AI marker, "Not sent" | Missing pricing: quote proposal goes to "Needs pricing review" |
| Takeover/resume | Toggle pending | - | Revert + reason | Banner "You are handling this thread. AI replies paused." | Queued AI reply cancelled at dispatch: event row "AI reply cancelled by takeover" |
| Pricing CRUD | Form skeleton | "No services. Add your first service." | Field-level Zod errors + form summary | "Saved as pricing version 4. Issued quotes unchanged." | - |
| Quote create/revise | Computing totals spinner on summary only | "No approved services available" + link to Pricing | Server validation (discount above limit, missing price) shown on the line | Totals with breakdown | Some lines need review: approve disabled with reason |
| Quote share | - | "No active links" | Revoke failed: retry | Link + expiry + copy | Expired links listed separately |
| PDF download | "Preparing PDF" | - | "PDF could not be generated" + correlation ID | File download | - |
| Public quote accept | Button pending | - | Expired / revoked / superseded / cancelled pages | "Accepted" confirmation (idempotent) | - |
| Bulk draft/approve | Pre-flight counting | No eligible: dialog explains why, no confirm button | Job failed: inspector link | Result summary | Eligible/skipped/failed breakdown |
| Sheets setup | Validation spinner | Not configured card | Validation errors per mapped column | Connected + last sync | Rows with per-row failures |
| Meta console | Skeleton table | "No campaigns found for this ad account" | Permission missing: names the exact permission plus setup | Metrics + "As of" | Some metrics unavailable: "Unknown" |
| Meta pause/resume | Pending after confirm | - | Provider error verbatim (redacted) | New status + audit link | - |
| Extension hub | Skeleton | "No tokens. Create one to connect the extension." | Token creation failed | Token shown once with copy, then masked | Batch partially failed: per-row table |
| Approvals queue | Skeleton | "Nothing waiting" | Retry | Approved / Rejected toast + queue update | Approved but dispatch deferred/blocked: shows reason |
| Integrations | Card skeletons | All Not configured: setup checklist | Test failed: provider message (redacted) | Connected + last check | Configured, Verification required (e.g. webhook not yet verified) |
| Pipeline editor | Canvas skeleton | Default five-stage template | Invalid graph: edge highlighted + reason | "Saved v3, active" | Saved but a stage's integration not configured: node shows status |
| Admin metrics | Skeleton | "No workspaces" | Retry | Values + definitions | Some workspaces failed to aggregate |
| Audit search | Skeleton | "No events match" | Retry | Results, paginated | - |
| Job/webhook inspector | Skeleton | "Queue empty" | Retry | Retry/cancel confirmations, audited | Stuck/ambiguous jobs grouped at top |
| Landing hero | Static poster (also the LCP element) | - | WebGL context lost: poster | Interactive globe | Low power: reduced particle count |
| ROI calculator | - | Defaults prefilled and editable | Invalid input inline | Result + "Illustrative" | - |
| `/docs` | Static | - | 404 with nav | Article | - |

Implementation: shared `src/components/patterns/{LoadingSkeleton,EmptyState,ErrorState,PartialNotice,ConfirmDialog,GatedAction,BulkResultSummary}.tsx`. `ErrorState` always shows a correlation ID and never a stack trace.

---

## 11.4 User journey storyboards

### 11.4.1 Client owner (Priya, dental clinic, Gurugram, workspace "SmileCare")
1. Opens `/`, reads the hero, clicks "Open live demo", which takes her to the role switcher with "User".
2. Lands on the command center. Sees the DEMO banner, "3 approvals waiting" and pipeline value ₹1,84,000 against confirmed ₹42,480.
3. Clicks "Needs you" item: quote Q-0012 v2 "Approval invalidated (edited after approval)". Sees the diff (discount 5% → 10%). Approves v2.
4. Shares: creates a link with 14-day expiry. Copies it. Opens `/quote/...`, which shows the DEMO watermark.
5. Inbox: a lead tapped "Request a call". A CallRequest row appears. She takes over the thread. Composer shows "Free-form window: closes 18:42 IST".
6. Pricing: raises the scaling fee. Toast "Saved as version 5. Issued quotes unchanged." Q-0012 still shows the old snapshot.

### 11.4.2 Employee operator (Arjun, assigned to SmileCare and FitHub)
1. Logs in and sees the assignment overview: SmileCare "12 to review", FitHub "Integration: WhatsApp Verification required".
2. Opens SmileCare Lead console. The workspace chip reads "SmileCare". Filters to Source = Maps, Score 70 and above. Selects 40.
3. "Generate drafts". Pre-flight: 40 eligible for drafting. "Queue WhatsApp outreach" pre-flight: 0 eligible, 40 skipped (no WhatsApp opt-in). The dialog explains why and offers "Draft email instead (12 have a verified email)".
4. Approvals: reviews drafts. Edits one quote quantity within his pricing permission. Version goes to v2 and needs re-approval. Approves and sends; it shows "Queued", then "Simulated delivered".
5. Extension hub: a batch shows "48 received, 45 created, 2 duplicates merged, 1 failed (invalid phone)".
6. Switches to FitHub. Integrations: WhatsApp "Verification required". Follows "Verify webhook" setup steps.

### 11.4.3 Super admin (ops lead)
1. `/dashboard/admin`: global metrics, a jobs health chip "2 ambiguous, 1 failed".
2. Job inspector: one message job "Unknown (provider timeout)". Reads the redacted payload and attempts. Chooses "Mark failed and requeue". The confirm states the duplicate risk. The action is audited.
3. Drilldown into FitHub: the audited banner appears. Views read-only.
4. People: assigns a new employee to FitHub with capabilities. Changes the plan label. Each change produces an audit row.
5. Audit search: filters actor = Arjun, action = quote.approve, last 7 days.

---

## 11.5 Required ASCII user flow (screens, states, transitions)

```
                         +------------------+
                         |   / (Landing)    |
                         | poster -> WebGL  |
                         | (reduced: poster)|
                         +---+---------+----+
                   "Open demo"|         |"Docs"
                              v         v
                   +--------------+   +--------+
         DEMO ---> | Role switcher|   | /docs  |
         LIVE ---> |   /login     |   +--------+
                   +--+----+----+-+
             User     |    |    | Super Admin
        +-------------+    |    +---------------------------+
        v                  v Employee                       v
+----------------+  +--------------------+         +------------------+
| User: Command  |  | Employee overview  |         | Admin metrics    |
| center         |  | pick workspace     |         +--+------+-----+--+
+--+-----+----+--+  +---------+----------+            |      |     |
   |     |    |               v                        v      v     v
   |     |    |     +---------------------+   Drilldown  People  Jobs/Webhooks
   |     |    |     | [ws] Lead console   |   [AUDITED]          | ambiguous?
   |     |    |     +--+------------+-----+                      v
   |     |    |        | bulk       | per lead           Mark failed+requeue
   |     |    |        v            v                     (confirm, audit)
   |     |    |  [Pre-flight]   [Draft/Quote proposal]
   |     |    |  eligible/skip    |  missing price -> NEEDS REVIEW
   |     |    |        |          v
   |     |    |        +----> [Approval queue] <-----------------------+
   |     |    |               |  v(n) diff, bind versionId             |
   |     |    |        approve|      |reject                           |
   |     |    |               v      v                                 |
   |     |    |        [Dispatch check @ server]                       |
   |     |    |         suppressed? -> BLOCKED (reason)                |
   |     |    |         window closed? -> template | back to review ---+
   |     |    |         throttled? -> DEFERRED
   |     |    |               v
   |     |    |        QUEUED -> SENT -> DELIVERED -> READ
   |     |    |           \-> FAILED      \-> UNKNOWN (timeout, no resend)
   |     |    v
   |     |  Quotations: DRAFT -> APPROVED -> SENT -> VIEWED -> ACCEPTED
   |     |      edit after approve -> DRAFT(v+1)    \-> EXPIRED / CANCELLED
   |     |      share link -> /quote/[shareId]
   |     |                    valid -> view -> Accept -> ACCEPTED (idempotent)
   |     |                    expired | revoked/invalid | superseded | cancelled
   |     v
   |   Inbox thread: AI mode [Off | Draft | Auto*]  (*workspace auto-send on)
   |      Take over -> HUMAN (queued AI replies cancelled at dispatch)
   |      Resume AI -> previous mode
   |      inbound "Stop" -> SUPPRESSED (composer gated, queue cancelled)
   v
 Leads: table <-> kanban; detail sheet; stage move (menu or drag)

Integration card states (all panels):
 NOT_CONFIGURED --setup--> CONFIGURED_UNVERIFIED --verify--> CONNECTED
       ^                         |  "Verification required"     |   ^
       +------ revoke -----------+                              v   |
                                  ERROR (test failed) <---- DEGRADED
 DEMO: SIMULATED (always labeled, never shown as CONNECTED)
```

---

## 11.6 Mode and status vocabulary

**Mode indicators**
- **DEMO:** a non-dismissible 32px top banner, hatch pattern, orange `--demo` token: "DEMO MODE: simulated providers, no messages leave this app. Data resets with `npm run seed`." Present on every authenticated page, `/docs` (small chip), `/quote` (ribbon plus PDF watermark). The role switcher lives in this banner, so it never appears in live.
- **LIVE:** no banner. A small "Live" chip sits in the workspace chip. A global outbound pause, when active, shows a red banner "Outbound paused globally by admin". A per-workspace automation pause shows an amber banner inside that workspace.
- **Simulated records:** a "Simulated" chip on every delivery status, campaign action result, ingestion batch and webhook event created by a simulator.

**IntegrationStatus** (enum shared by the UI and `Integration.status`)

| Value | Label | Color | Required action |
|---|---|---|---|
| NOT_CONFIGURED | Not configured | neutral | "Set up" goes to the setup form or docs anchor |
| CONFIGURED_UNVERIFIED | Verification required | warning | "Verify" (webhook challenge, test send to fixture, permission check) |
| VERIFYING | Verifying | neutral + spinner | none |
| CONNECTED | Connected · checked 14:05 IST | success | "Test again" |
| DEGRADED | Limited (e.g. quality Low, permission missing) | warning | names the cause, links setup |
| ERROR | Connection failed | danger | redacted provider message + correlation ID + "Retry test" |
| REVOKED | Revoked | neutral | "Reconnect" |
| SIMULATED | Demo simulation | demo | "How live differs" goes to `/docs/modes` |

Quality and limits: show the provider value or "Unknown, last checked [time]". Internal caps always carry the caption "Internal cap, not a provider limit".

---

## 11.7 Design tokens (recommended set)

`src/styles/tokens.css` holds CSS variables mapped into `tailwind.config.ts` theme. Dark is the only theme for panels. `/quote` and the PDF use the paper set.

**Color: dark ops surface**

| Token | Hex | OKLCH (approx.) | Use |
|---|---|---|---|
| `--bg-0` | #07080B | oklch(0.13 0.006 265) | page |
| `--bg-1` | #0D0F14 | oklch(0.17 0.008 265) | panels, sidebar |
| `--bg-2` | #141720 | oklch(0.21 0.012 265) | cards, inputs |
| `--bg-3` | #1B1F2A | oklch(0.25 0.015 265) | hover, selected row |
| `--border-subtle` | #FFFFFF14 | white / 8% | hairlines |
| `--border-strong` | #FFFFFF26 | white / 15% | inputs, focus-adjacent |
| `--text-1` | #E8EAF0 | oklch(0.94 0.008 265) | primary text (about 16:1 on bg-0) |
| `--text-2` | #A3A9B8 | oklch(0.73 0.02 265) | secondary (about 8:1) |
| `--text-3` | #7D8496 | oklch(0.61 0.025 265) | tertiary, 4.5:1 or more on bg-0 through bg-2; never for essential info on bg-3 |
| `--accent` (cyan) | #2BC8DC | oklch(0.77 0.13 210) | primary actions, links, focus ring |
| `--accent-fg` | #04121A | | text on accent buttons |
| `--ai` (violet) | #A78BFA | oklch(0.71 0.16 293) | **reserved** for AI-generated content markers and AI mode only |
| `--success` | #34D399 | oklch(0.78 0.15 163) | delivered, connected, accepted |
| `--warning` | #FBBF24 | oklch(0.84 0.16 85) | verification required, deferred |
| `--danger` | #F87171 | oklch(0.71 0.17 22) | failed, suppressed, destructive |
| `--info` | #60A5FA | oklch(0.71 0.14 255) | neutral system notices |
| `--demo` | #FB923C | oklch(0.76 0.16 55) | demo banner and simulated chips only |

Rule: status is never conveyed by color alone. Every badge has an icon (Lucide) and a text label.

**Color: paper (quote page and PDF)**: `--paper` #FFFFFF, `--ink-1` #111318, `--ink-2` #4A5060, `--rule` #E3E6EC, `--brand` = workspace color, contrast-corrected per F14.

**Radii:** `--r-xs` 4px (chips, checkboxes), `--r-sm` 6px (badges), `--r-md` 8px (buttons, inputs), `--r-lg` 12px (cards), `--r-xl` 16px (dialogs, sheets), `--r-full` 9999px (pills, avatars).

**Spacing (4px base):** 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96. Card padding 16 (dense) or 24. Section gap 32 on dashboards, 96 on landing.

**Type scale (px size / line height, weight):**

| Token | Size / LH | Use |
|---|---|---|
| `text-xs` | 12/16, 500 | captions, table meta |
| `text-sm` | 13/18, 400-500 | dense tables |
| `text-base` | 14/20, 400 | UI body |
| `text-md` | 16/24, 400 | docs, quote body |
| `text-lg` | 18/26, 600 | card titles |
| `text-xl` | 20/28, 600 | section titles |
| `text-2xl` | 24/32, 600 | dashboard page title (max in panels) |
| `text-3xl` | 30/36, 600 | landing section headings |
| `text-4xl` | 36/40, 600 | hero at 390 |
| `text-5xl` | 48/52, 600 | hero at 768 |
| `text-6xl` | 56/60, 600 | hero cap at 1440+ (nothing larger) |

Letter-spacing -0.02em at 30px and above. Numbers use `font-variant-numeric: tabular-nums` in tables, KPIs and quotes.

**Font pairing (all OFL, all on Google Fonts, all loadable via `next/font/google`):**
- UI and body: **Inter** (variable). Has U+20B9 in latin-ext and tabular numerals.
- Display (landing headings, panel page titles only): **Manrope** 600.
- Mono (IDs, tokens, payloads, Apps Script block): **JetBrains Mono**.
- Load with `subsets: ['latin','latin-ext']`, `display: 'swap'`. Embed the Inter TTF in the PDF renderer (F1). Assumption to verify at implementation: Manrope glyph coverage is irrelevant because currency never renders in display type.

**Motion:** `--dur-fast` 150ms (hover, press), `--dur-base` 200ms (popover, toast), `--dur-slow` 300ms (sheet, dialog, page section). Easing `cubic-bezier(0.2, 0, 0, 1)` for enter and `cubic-bezier(0.4, 0, 1, 1)` for exit. Nothing above 300ms except the landing pipeline loop (decorative, paused offscreen, static under reduced motion). Use Motion only. No GSAP or Lenis (smooth-scroll hijack hurts tables and accessibility).

**Elevation:** shadows are nearly invisible on near-black, so use borders plus `bg` steps instead. One shadow token for overlays: `0 16px 48px -12px rgb(0 0 0 / 0.6)`.

---

## 11.8 AI slop risks and guardrails

| Risk in the PRD's own language | Guardrail (testable) |
|---|---|
| "Glow" spreads to every card and border | Glow budget: landing only, 2 glow sources per viewport at most (hero core, primary CTA hover), blur 24px or less, opacity 0.35 or less. Dashboards: **zero** decorative glow. Allowed: the focus ring (2px solid `--accent`, 2px offset) and a static status dot. Enforced by a lint rule banning `shadow-[0_0_` / `drop-shadow` utilities outside `src/components/visual/**`. |
| "Glass" over dense data | Per F15. Never more than one glass layer stacked. |
| "Particle globe / AI core" as generic sci-fi | Procedural Fibonacci-sphere points with a few arcs that trace the real pipeline stages (Maps, Sheets, Meta flowing into the core). No earth texture asset (avoids image licensing), no lens flares, no bloom post-processing. |
| Cyan plus violet gradient on everything | Cyan = action, violet = AI provenance. Gradients: one on the landing hero background. No gradient text in panels. At most one gradient text span on landing (hero keyword) or none. |
| Bento with filler icons and vague copy | Every bento tile names a concrete capability and links to the doc that proves it ("Prices come from your versioned matrix. AI cannot set them."). No "Revolutionize", no emojis. |
| Count-up numbers, fake live tickers, "trusted by" logos, testimonials | Banned (F11, F12). |
| Spotlight, meteors, beams, sparkles on every section | At most one ambient effect on landing (the globe). None in panels. |
| Oversized type | Capped scale above. Panel titles 24px max. |
| Unreadable transparency | Text never placed on alpha below 0.72. Axe contrast checks run on every route at every viewport. |

---

## 11.9 Responsive intention

| Width | Landing | Panels | Tables | Special |
|---|---|---|---|---|
| 390 | Hero stacked: copy, CTA, static poster (WebGL off by default below 768). Pipeline as a vertical list. Bento one column. | Bottom tab bar (4-5 primary sections), "More" drawer for the rest. Detail views full-screen sheets. 16px gutters. | Internal horizontal scroll, sticky first column (name), 44px min touch targets. | Kanban: horizontal scroll-snap columns plus "Move to" menu. React Flow read-only. Composer pinned to the bottom with safe-area inset. |
| 768 | Two columns where useful. WebGL allowed if capable, half the particle cap. | Collapsible icon rail nav. | Same, more columns visible. | Inbox: list or thread toggle (not split). |
| 1440 | Full hero, globe at 1.5 DPR cap. | Sidebar 240px. Content max 1280px for forms, fluid for tables. | Full columns. | Inbox three-pane: threads, conversation, lead context. Optional 3D tile in the command center. |
| 1920 | Content max 1280px centered. Hero visual does not scale beyond 720px. | Tables fluid to 1680px. Forms and docs stay at a 720px measure. | Density toggle not added (scope). | No stretched line lengths over 80ch. |

No horizontal page scroll at any width (a Playwright assertion: `document.documentElement.scrollWidth <= innerWidth`).

---

## 11.10 WebGL fallback and reduced motion

Module layout: `src/components/visual/{HeroGlobe.tsx (client, dynamic import ssr:false), GlobePoster.tsx, useVisualBudget.ts}`.

1. SSR renders `GlobePoster` (a pre-rendered WebP plus inline SVG, sized, `alt=""`, aria-hidden). It is the LCP element.
2. `useVisualBudget` returns `off` if any of these hold: `prefers-reduced-motion: reduce`, no WebGL2 (`canvas.getContext('webgl2')` null), `navigator.connection?.saveData`, `hardwareConcurrency <= 4`, or width below 768. Otherwise it returns `low` or `high`.
3. Mount only after `requestIdleCallback` and IntersectionObserver visibility. `frameloop="demand"` when idle. Pause on `visibilitychange` hidden and when offscreen.
4. Caps: DPR `[1, 1.5]`. Particles: high 6,000, low 2,000. Respect `webglcontextlost` and swap back to the poster.
5. Command center 3D tile: same hook, `aria-hidden`, carries no data, at 1440px and above only, otherwise a static gradient tile.
6. Reduced motion globally: Motion's `MotionConfig reducedMotion="user"`. The landing pipeline animation becomes a static annotated diagram. Chart entry animations are disabled. Toasts still appear, with no slide.
7. Tests: Playwright projects with `reducedMotion: 'reduce'` and a Chromium launch arg `--disable-webgl` assert the poster is present and no `<canvas>` exists. Performance budget: landing JS for the hero chunk loads after LCP (checked in the build report).

---

## 11.11 Accessibility basics (targets)

- Contrast: body text 4.5:1 minimum (target 7:1 for `--text-1`). UI component boundaries and focus indicators 3:1. Verified by `@axe-core/playwright` on every route at 390 and 1440.
- Keyboard: skip link to main. Visible focus everywhere (no `outline:none` without a replacement). cmdk palette. All Radix dialogs trap and return focus. Escape closes. Kanban, React Flow and bulk selection have non-pointer paths (F13). Shift+click range select in tables, plus a "Select all on page" checkbox.
- Labels: every input has a visible label. Errors are linked via `aria-describedby`. Form summary at the top on submit.
- Live regions: Sonner toasts are polite. Delivery status changes in an open thread are announced politely. Destructive results are announced assertively.
- Tables: real `<table>` semantics from TanStack Table, `aria-sort`, caption.
- Charts (Recharts): every chart has a "View as table" toggle and a text summary.
- Time: display in workspace timezone with an "IST" suffix. A tooltip shows the absolute UTC. Relative time is never the only representation.
- Language: `lang="en-IN"`. Currency via `formatINR` only.
- Touch targets: 44x44px minimum below 1024px.

---

## 11.12 Licensing caveats (Aceternity / Magic UI and related)

| Source | Caveat | Requirement |
|---|---|---|
| Magic UI (free, open source) | MIT for the free components. Magic UI Pro templates are paid and not redistributable. | Use free components only. Copy into `src/components/vendor/magicui/` with the license header. List in `THIRD_PARTY_NOTICES.md`. |
| Aceternity UI | Free components are copy-paste from the site. Aceternity UI Pro is a paid license with redistribution limits. The free tier terms are not a standard OSI file per component. | Default: **re-implement the pattern** (spotlight, bento, beam) from scratch with Motion and Tailwind, with "pattern inspired by Aceternity UI" in `docs/decisions.md`. Copy code only after verifying the current license page and recording the URL and date in `docs/decisions.md`. Never use Pro assets. Flag as unverified until checked. |
| shadcn/ui, Radix, Lucide, cmdk, Sonner | MIT / ISC. | Notices file. |
| React Flow (xyflow) | MIT. The attribution badge can be hidden with `proOptions`, but the maintainers ask non-subscribers to keep it. | Keep the attribution visible. |
| three.js, R3F, drei | MIT. | Notices. No third-party textures or HDRIs (procedural only). |
| Fonts (Inter, Manrope, JetBrains Mono) | SIL OFL 1.1, which permits embedding in PDFs. | Notices. Bundle the Inter TTF for the PDF renderer with its OFL text. |

---

## 11.13 Tests this section requires (append to the requirement-to-test checklist)

1. `money.test.ts`: `formatINR(2124000)` returns "₹21,240.00". Indian grouping at 1,23,456. Glyph U+20B9 present in the embedded PDF font.
2. `quote-parity.spec.ts`: HTML total equals PDF-extracted total and version for seeded quotes. Demo watermark is present only in demo.
3. `public-quote-states.spec.ts`: valid / expired / revoked / invalid / superseded / cancelled / already-accepted render their designated pages. Revoked and invalid are indistinguishable.
4. `gated-actions.spec.ts`: every gated control at 390 and 1440 is focusable and exposes a visible reason.
5. `status-badges.test.tsx`: every `IntegrationStatus` and `DeliveryStatus`, including UNKNOWN and simulated, renders an icon, a label and the mode chip.
6. `composer-window.spec.ts` (injected clock): the eligibility line updates. Crossing the boundary converts the action to template or review, with no "Sent".
7. `bulk-preflight.spec.ts`: Maps leads without opt-in show skipped with a reason. The result drawer persists after reload.
8. `responsive.spec.ts`: no horizontal page scroll at 390/768/1440/1920. Tables scroll internally. Kanban and React Flow have their non-drag paths.
9. `a11y.spec.ts`: axe has zero serious or critical violations on all routes at 390 and 1440. Keyboard-only walkthrough of approve-and-send.
10. `visual-budget.spec.ts`: reduced motion and disabled WebGL show the poster and no canvas. The hero chunk is not in the initial JS.
11. `admin-drilldown.spec.ts`: the audited banner renders and an AuditEvent row is created on drilldown.
12. Lint: no glow or drop-shadow utilities outside `src/components/visual/**`, and no `--ai` token usage outside AI components.

**Material decisions for the user:** none. Every item above is an assumption (a) that can be recorded in `docs/decisions.md`. F7 (who may enable auto-send) is the only permission-adjacent one. It is recorded with the owner-plus-capability default because it follows directly from the PRD's role definitions.
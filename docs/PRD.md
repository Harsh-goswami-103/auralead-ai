# AuraLead AI — Product Requirements (source specification)

> This is the verbatim implementation brief supplied by the product owner on 2026-10-15.
> It is the authoritative scope document. Plans live in `docs/implementation-plan.md`;
> decisions that deviate from it are recorded in `docs/decisions.md`.

## Objective

Build AuraLead AI: a working SaaS MVP that captures leads, prepares personalized messages and accurate PDF quotations, and manages official WhatsApp and email conversations.

Deliver a polished cinematic client experience, an employee operations panel, and a super-admin oversight panel. Implement persistent workflows, not just attractive screens. The local demo must run without paid services; live integrations must use real provider adapters and clearly disclose configuration and verification requirements.

## Working method

1. Read existing instructions, manifests, lockfiles, source structure, auth, schema, tests, env examples. Preserve unrelated changes.
2. Locate the Google_Map_Extractor extension. Do not claim to have integrated an absent extension.
3. Summarize findings, assumptions, architecture. Create docs/implementation-plan.md with ordered milestones and a requirement-to-test checklist before implementation.
4. Prefer existing compatible stack; for a new repo use the defaults below. Explain deviations in docs/decisions.md.
5. Implement in vertical slices; run checks after each slice; fix root causes; continue.
6. Resolve ordinary choices independently. Ask only when an answer changes scope, permissions, or an irreversible action. Missing credentials must not block the local demo.
7. Brief progress updates. Maintain docs/progress.md (completed work, commands, unresolved issues, exact next step).
8. Keep CLAUDE.md concise: verified commands, invariants, links to the spec.
9. Check current official provider docs before implementing version-sensitive APIs; record links, API versions, date checked in docs/integrations.md, or flag unverified assumptions.
10. Build locally. Deployment, paid infrastructure, real outbound messages, and live ad changes require explicit authorization.

## Scope and truthfulness

Two explicit operating modes:

- **DEMO**: seeded DB, real local business logic, deterministic AI fallback, simulated provider responses, zero outbound delivery. Persistent Demo label. Simulators call the same application services as live adapters and create durable records, events, audit entries.
- **LIVE**: authenticated users, tenant-scoped credentials, real provider requests, verified webhooks, enforced delivery rules. Unavailable integration shows Not configured / Verification required with a working setup action. Never silently fall back to simulated success.

No decorative controls. Every visible action performs its stated action, explains a real restriction, or navigates to configuration. No TODO placeholders in required workflows. MVP with production-minded boundaries; separate implemented / locally verified / externally verified in the final report.

In scope: campaign metrics + pause/resume (not ad creation); constrained automation pipeline (not a workflow language); plan labels + admin management (not billing); call-request record or booking link (not a calendar platform).

## Stack (new project defaults)

- Next.js App Router + TypeScript; Prisma + SQLite locally. Document real PostgreSQL migration steps (schema differences, data migration, deployment changes).
- Tailwind, shadcn/ui + Radix, Lucide, Sonner, cmdk.
- React Hook Form + Zod.
- TanStack Table (leads), Recharts (metrics), TanStack Query; Zustand only for shared client UI state.
- three, @react-three/fiber, @react-three/drei for landing hero and restrained command-center visual.
- One primary animation library (Motion). GSAP/Lenis only if required.
- React Flow for constrained pipeline editor.
- Aceternity/Magic UI-style patterns where licenses permit, with attribution.
- Vitest + Playwright.
- Pin stable versions, commit lockfile, document runtime + package manager. Provider SDKs, secrets, DB ops, PDF generation server-side only.

## Architecture and data

Modular monolith: thin routes, application services, provider adapters, separately runnable durable worker.

Entities (combine when justified): Workspace, User, Membership, EmployeeAssignment, Lead, LeadSourceRecord, ConsentRecord, Service, PricingVersion, Quote, QuoteItem, Conversation, Message, Approval, Campaign, Integration, WebhookEvent, Job, AuditEvent, CallRequest.

- Tenant-owned records carry workspace identity; enforce workspace + role server-side for reads, mutations, exports, PDFs, jobs, integrations. Never trust browser-supplied workspace IDs or roles.
- Roles: user/client (owns/belongs to workspace); employee (assigned workspaces with granted capabilities); super admin (explicit cross-workspace, audited). Never expose stored secrets.
- Sales stages (NEW, CONTACTED, REPLIED, QUOTE_SENT, CONVERTED, LOST) separate from consent, approval, delivery, quotation states. Opt-out is a communication restriction.
- INR in integer minor units with explicit rounding. UTC storage; workspace timezone display (default Asia/Kolkata). Paginate; index tenant lookups.
- Persistent jobs: transactional claiming, retry backoff, bounded attempts, failure inspection, idempotency, restart safety, no blind resend after ambiguous timeouts. No in-memory timers / detached promises in handlers.
- Transactions for related state + audit. Audit actor, workspace, action, target, time, result, safe change summary; redact tokens/PII.

## Lead ingestion

Adapters:
1. `/api/webhooks/google-sheets` — authenticated Apps Script form-submit ingestion + employee mapped-row preview/sync for configured Sheets access.
2. `/api/webhooks/meta-ads` — Meta verification + lead events, fetching lead details with authorized credentials.
3. `/api/webhooks/gmaps-extension` — tenant-scoped extension batch ingestion.
4. Protected demo simulation actions for each source.

- A Sheet URL alone does not authorize access or push rows. Generate copyable Apps Script (setup, mapping, event IDs, auth, retry guidance). Google-Form-linked ads ≠ Meta Instant Forms.
- Validate schema, payload size, source auth, replay/idempotency before processing. Phones → E.164 (default region IN). Never invent emails.
- Dedupe per workspace by provider IDs and normalized contacts; conflicting matches go to review. Preserve attribution, batch counts, per-row failures.
- Maps fields: name, category, phone, website, address, rating, review count, source ref, extraction time. Missing website = unknown unless verified absent.
- Explainable configurable opportunity score 0–100 with reasons and unknown inputs; heuristic, not intent or consent.
- Website enrichment: constrain protocols, redirects, size, timeout, destinations (block private/internal). Scraped text and inbound messages are untrusted data.

## AI and quotation engine

- Anthropic + OpenAI adapters + labeled deterministic local generator behind one validated interface; configurable model IDs.
- Generate: approved-template variable values + separate follow-up draft; email subject/body; structured quote proposal (approved service IDs, quantities, scope, timeline).
- Server resolves prices from versioned pricing matrix; computes discount, tax, subtotal, total. AI cannot invent prices, exceed discount limits, or set tax. Missing pricing → review.
- Persist line items and pricing snapshots; catalog changes never alter issued quotes. Material edit after approval invalidates approval; approval and dispatch bind to the same version.
- Branded HTML quote at `/quote/[id]`, real downloadable PDF, print styling, acceptance. Unguessable revocable expiring share credentials.
- States: DRAFT, APPROVED, SENT, VIEWED, ACCEPTED, EXPIRED, CANCELLED with explicit transitions. View evidence without claiming human engagement. Idempotent acceptance on current valid version.
- Automated replies constrained to approved services/facts; respect human takeover at dispatch; escalate uncertainty/complaints/human requests. No unrestricted tool/credential/tenant access for models.

## Messaging rules

WhatsApp Cloud API + email (Resend or SMTP) via adapters, with demo transports.

WhatsApp:
- Channel-specific opt-in evidence (purpose, source, timestamp). Scraped numbers / form submissions without permission ≠ opt-in.
- Maps imports default to no WhatsApp consent: can be scored/drafted, not enter automated WhatsApp outreach until eligible.
- Business-initiated outreach uses actually approved templates (language, category, variables, buttons). AI fills permitted variables only.
- Quick replies: request quotation, request a call, stop — validate limits against current docs; stable payload IDs.
- Customer-service window opens/resets from the latest valid inbound message (incl. qualifying quick reply). Template sends, delivery statuses, quote link opens do not open it.
- Free-form eligibility computed server-side at dispatch (24h). Expired → eligible template or back to review.
- Quote request → deliver approved quote link/PDF when eligible. Call request → CallRequest or booking link.
- Stop → immediate suppression + cancel queued outreach; re-check suppression before every dispatch incl. retries.
- Fetch real quality/limits when supported else Unknown with last check time. Internal caps ≠ provider limits. Do not hardcode tier lists.
- Apply provider limits, backoff, quality-based pause. No promises of green ratings.

Email:
- Separate eligibility, suppression, unsubscribe, provider requirements. WhatsApp consent ≠ email permission.
- WhatsApp limit → defer by default. Email fallback only if configured and independently eligible; never bypass opt-out.
- Outbound + delivery/bounce events. Inbound ingestion for a supporting provider with setup docs; disclose SMTP has no inbound.

Shared:
- Provider message IDs; pending/sent/delivered/read/failed; redacted errors; duplicate and out-of-order events.
- Approval-required default. Auto-send is opt-in per workspace, audited, same checks.
- Live tests never send unsolicited messages.

## Pages and panels

**Public landing `/`**: cinematic dark hero with interactive particle globe / AI core; animated source → scoring → quotation → messaging pipeline; feature bento; three-panel previews; CTA navigation; working ROI calculator with visible editable assumptions (illustrative only).

**Client `/dashboard/user`**: command center (DB-derived counts, conversations, quote metrics, pipeline value vs confirmed revenue, funnel, activity); Leads (search/filter/sort/paginated table + Kanban, detail, source, score reasons, consent, persisted stages); Inbox (threads, delivery status, draft/manual send, AI mode, takeover/resume); Pricing (service CRUD, branding, timelines, tax, discount rules, history); Quotations (create, inspect, revise, approve, share, download, status history).

**Employee `/dashboard/employee`**: workspace-scoped lead console with bulk selection + eligible/skipped counts, draft generation, approvals; Sheets/Form setup (config, validation, mapping, preview, sync status, Apps Script, simulation); Meta console (metrics, spend, leads, CPL, pause/resume with confirmation, permissions, provider result, audit; demo toggles simulated only); Extension hub (scoped keys, revocation, webhook config, batch status, errors, simulation); Approval queue (versioned items, edits within pricing permissions, approve/reject, dispatch, automation controls); Integration center (masked creds, connection tests, real status, template config, quality/limits, internal caps, AI/email setup); React Flow pipeline (small validated stage set: ingestion, score, draft, approval, delivery; persisted; rejects cycles/unsupported; executed).

**Super admin `/dashboard/admin`**: global metrics + workspace drilldowns (audited); user/employee/membership/assignment/status/plan-label management; employee productivity with explicit definitions (no invented efficiency scores); searchable audit history; webhook/job inspector (redacted payloads, attempts, errors, safe retry, cancellation, queue health).

**Docs `/docs`**: workflows, role guides, local setup, demo accounts, simulation walkthrough, mode differences, Google Forms/Sheets vs Meta Instant Forms, extension setup, WhatsApp templates/webhooks, AI + email config, troubleshooting, security, data/export/retention, limitations.

**Role switcher**: Landing / User / Employee / Super Admin / Docs for the isolated demo; server-controlled, seeded demo identities only, never production privileges.

## Visual design

Premium cinematic yet readable. Near-black/charcoal, restrained cyan/violet, fine borders, controlled glass, clear type hierarchy, consistent spacing. 3D only on landing hero + small optional command-center area. Reusable layout/typography/card/table/form/loading/error/empty/confirmation patterns with design tokens. Avoid oversized text, overlap, excess glow, unreadable transparency, fake testimonials, random animated numbers. Lazy-load WebGL, pause offscreen/hidden, cap DPR and particles, static fallback for reduced motion / no WebGL / low power. Keyboard nav, focus, labels, contrast, accessible dialogs, reduced motion. Test 390/768/1440/1920; tables scroll internally. 150–300ms transitions.

## Extension bridge

Inspect manifest, parser, worker, background, config, settings UI before integrating. Provide `extension-bridge/saas-sync.js`, docs, example payloads, contract tests. Integrate with the existing extracted-data handoff without removing extraction or changing unrelated licensing/authentication. Revocable workspace-scoped ingestion-only token; bounded batches; stable batch/record IDs; retries with backoff; durable pending batches; explicit partial failure; visible sync status; MV3 service-worker suspension; minimum host permissions. Website configures/monitors only; no remote browser control claims. If source absent, complete contract + guide and report as blocked.

## Security and operations

Real session auth + server-side authorization in live mode; demo credentials only in demo mode. Encrypt provider credentials with a deployment secret; mask; never log or bundle; support rotation/revocation. Verify Meta challenge/signatures with raw body. Authenticate Sheets/extension with scoped credentials and replay protection. CSRF protection for cookie mutations, input validation, sanitization, rate limits on public/auth/ingestion. Separate tenant and demo/live data; simulations cannot touch live data. Global outbound pause + per-workspace automation pause honored by workers. Structured logs with correlation IDs; no stack traces/tokens to users. Document SQLite limits, storage, worker lifecycle, backups, credential rotation, PostgreSQL path.

## Milestones

1. Discovery, decisions, requirement checklist, shell, auth/roles, DB, migrations, repeatable seed.
2. Vertical slice: simulated lead → normalize/dedupe → score → draft → versioned quote → real PDF → audit.
3. Inbox, approvals, persistent jobs, eligibility, inbound simulation, suppression, quote acceptance.
4. Complete panels, DB-derived metrics, landing, responsive refinement.
5. Live adapters, protected webhooks, Sheets setup, Meta metrics/control, extension bridge, fixture integration tests.
6. Docs, full acceptance run, browser inspection, production build, honest handoff.

## Seed and acceptance tests

Seed fictitious Indian businesses (Delhi NCR, Mumbai, Bengaluru: clinics, gyms, property agencies, e-commerce, freelancers); multiple workspaces, assigned employees, varied stages, missing consent, expired windows, approved/rejected drafts, quotes, failed jobs, audit history. Non-deliverable fixture contacts; deterministic resettable data.

1. Fresh documented setup starts app + worker; all routes load without credentials.
2. Each source simulation creates persistent leads, source records, jobs, audit; survives reload.
3. Replay of same webhook/batch does not duplicate leads, quotes, or outbound effects; cross-workspace distinct.
4. ID tampering cannot cross workspaces; employees blocked from unassigned workspaces; demo switching cannot elevate live privileges.
5. No invented pricing. 2 × ₹10,000 = ₹20,000; −10% discount; +18% configured tax = ₹21,240. Separate rounding + discount-limit tests.
6. Catalog updates preserve issued snapshots; editing approved quote invalidates approval; PDF opens and matches HTML totals and version.
7. Public quote needs valid share credential; expiry/revocation work; repeat acceptance idempotent.
8. Maps lead without WhatsApp opt-in cannot enter live template outreach. Invalid signatures and revoked extension tokens rejected.
9. Template delivery event does not open window; valid inbound does; free-form eligibility expires exactly at boundary (injected clock).
10. Stop suppresses queued + retrying outreach; manual takeover blocks queued automated reply at dispatch.
11. Throttling defers; email fallback needs separate eligibility; ambiguous timeouts visible, no blind resend.
12. Approve-and-send → one version-bound dispatch; duplicate clicks/callbacks, out-of-order statuses, worker restarts stay consistent.
13. Bulk actions report eligible/skipped/failed; metrics and audit reflect stored actions.
14. Campaign controls persist in demo; call provider only in authorized live operation; failures never shown as success.
15. Inspect landing, dashboards, inbox, pricing, quote/PDF, docs at required viewports; loading/empty/error/keyboard/reduced-motion/WebGL fallback.
16. Typecheck, lint, unit/integration, browser tests, production build; start built app and smoke-test.

## Deliverables

App, schema/migrations, seed, worker, extension bridge, tests, `.env.example`, README, in-app `/docs`, developer docs (architecture, integrations, deployment, blockers). Final report: what works per panel + E2E; verified commands; demo access + walkthrough; integration table (implementation / demo verified / live verified / prerequisites); checks run with outcomes + artifacts; concrete limitations.

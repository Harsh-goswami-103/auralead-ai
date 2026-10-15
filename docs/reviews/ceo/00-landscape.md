## Landscape check (Step 0 + Section: Market and Platform Reality)

Checked 2026-10-15. The repo is greenfield and contains only `docs/PRD.md`. Every vendor-blog claim below is marked secondary. Implementation must confirm version-sensitive facts against Meta's docs and record them in `docs/integrations.md`, as PRD Working method #9 requires.

### 0A. Premise challenge

| Question | Answer |
|---|---|
| Real problem | Indian SMB sellers and agencies (clinics, gyms, property, e-com, freelancers) lose leads in the gap between capture and a priced, credible reply. Leads land in Sheets, Meta forms and Maps scrapes. Quotes get typed by hand in WhatsApp with inconsistent prices, and follow-up depends on someone remembering. |
| Target outcome | Lead to accurate, branded, version-bound quote to compliant first touch in minutes, with an audit trail. An employee can run this for several client workspaces. |
| Do-nothing cost | Slow first response, price errors and unauthorised discounts in hand-typed quotes, WhatsApp number quality damage from cold blasts, and no record of who promised what. |
| Does the plan hit the pain directly? | Mostly yes. The quotation engine (server-resolved prices, snapshots, approval bound to version) is the most direct fix and the clearest market gap (see Layer 2). The weak link is Maps-sourced leads. The PRD correctly blocks them from WhatsApp outreach without opt-in, so for that source the "messaging" half of the value depends on email eligibility, which the PRD leaves undefined. That is finding L-1, the only MATERIAL item. |
| Premise verdict | Sound inside HOLD SCOPE. Two premises need to be stated explicitly. (1) AI is ancillary to a business service, not a general assistant. Meta's 2026 terms require this. (2) Templates are the only cold-touch path on WhatsApp, and Meta prices and caps them per message. |

### 0C. Dream-state diagram

```
CURRENT (customer reality)          THIS PLAN (MVP, HOLD SCOPE)                 12-MONTH IDEAL
---------------------------         -------------------------------------       ------------------------------
Sheets / Meta form / Maps CSV  -->  3 ingestion adapters + sim, dedupe,    -->  Same adapters + Meta lead polling
copied by hand                      E.164, score 0-100 w/ reasons               backstop, CTWA referral capture
                                                                                 (opt-in at source)
Quote typed in WhatsApp/Excel  -->  Versioned pricing matrix, AI proposes  -->  Quote acceptance -> payment link /
prices drift, no history            IDs+qty only, server prices, PDF,           invoice handoff (out of scope now)
                                    share tokens, acceptance
Owner phone = WhatsApp app     -->  Cloud API adapter, approved templates, -->  Embedded Signup onboarding,
blasts, no consent trail            ConsentRecord, 24h window engine,           coexistence w/ WA Business app,
                                    suppression, approval-first                 per-portfolio limit + cost forecast
No oversight                   -->  Employee console, approval queue,      -->  Productivity defs tied to SLA,
                                    super-admin audit + job inspector           DPDP consent-notice versioning
                                                                                 (Rules 3+ effective ~May 2027)
Static AI, none                -->  Anthropic/OpenAI/deterministic adapter, -->  Eval set per workspace, grounded
                                    constrained replies + escalation            reply accuracy metric
```

### Search findings (Layer 2 inputs)

**S1. Competitive landscape (India, 2026).** Interakt, WATI, AiSensy and Gallabox are commodity WhatsApp BSP layers: broadcasts, click-to-WhatsApp (CTWA) ads, shared inbox, basic bots. Gallabox is the most CRM-like (pipelines, lead scoring). None of the comparison results showed native quotation or proposal generation, so a quote today means a CRM or invoicing add-on. LeadSquared and Zoho cover CRM and lead management but not cinematic client portals or price-safe AI quotes. Sources are mostly vendor-authored, so treat the rankings as marketing.
- https://hyperleap.ai/comparison/best-interakt-alternatives-2026
- https://hyperleap.ai/comparison/best-wati-alternatives-2026
- https://www.wati.io/blog/aisensy-alternatives
- https://articles.chakrahq.com/article/10-best-wati-alternatives-in-2026/
- https://www.groweon.com/blog/?p=934

**S2. Pricing model.** Per-message pricing has applied since 1 Jul 2025. Each delivered template is charged by category (marketing, utility, authentication). Free-form service replies inside the customer service window (CSW) are free. Utility templates sent inside an open CSW are free. Marketing and authentication templates are charged even inside the CSW. Meta revised some country rates on 1 Oct 2025. India figures from a vendor (Marketing about ₹0.86, Utility and Auth about ₹0.13) are secondary and unverified.
- https://docs.gallabox.com/pricing-and-billing-modules/new-per-message-pricing-effective-july-1-2025
- https://help.sleekflow.io/en_US/whatsapp/pricing
- https://support.wati.io/en/articles/11561662-introducing-message-based-pricing
- https://support.myoperator.com/portal/en/kb/articles/whatsapp-has-shifted-to-per-message-pricing-effective-july-1-2025-based-on-message-categories-and-your-recipient-s-country-in-india-there-are-three-paid-categories

**S3. Messaging limits.** Limits are now set at the business portfolio level and shared by every phone number in the portfolio. Levels are 250, 2K, 10K, 100K and unlimited unique users per rolling 24h. Messages inside the CSW do not count. Business verification (or 2,000 delivered high-quality messages in 30 days) unlocks 2K. Above that, the limit scales automatically within 6h when quality is high and at least 50% of the current limit was used in the last 7 days. Read the limit from the `whatsapp_business_manager_messaging_limit` field (for example `TIER_250`). `messaging_limit_tier` is deprecated. One secondary source says a quality drop no longer automatically lowers the tier.
- https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits (official)
- https://m.aisensy.com/blog/whatsapp-message-limits-guide/

**S4. Template buttons and categories.** Up to 10 buttons per template. Quick-reply buttons must be grouped and cannot be interleaved with call-to-action (CTA) buttons. Labels max 25 chars. Only 2 or 3 buttons render before "See all options". The utility guidelines tightened on 1 Jul 2025 (no promotional wording), and Meta can recategorise a template from utility to marketing, which raises its price. All of this is secondary; confirm against Meta's template docs.
- https://docs.bird.com/api/touchpoints-api/supported-projects/whatsapp-approved-message-templates/creating-whatsapp-message-templates/text-template-blocks
- https://guides.clickatell.com/release-notes/release-notes-archive/2024-release-notes/q1-2024/self-service-chatbot/support-for-whatsapp-buttons-and-template-enhancements
- https://www.ycloud.com/blog/whatsapp-api-message-template-category-guidelines-update
- https://developer.exotel.com/docs/whatsapp-support/template-categories

**S5. India marketing frequency cap.** Meta caps how many marketing templates one user receives across all businesses. The send is accepted and then fails later with an error code. Vendors cite 131026 and 131049; confirm the code against Meta's error reference. Utility templates are reportedly not paced.
- https://crmsupport.freshworks.com/support/solutions/articles/50000009847-everything-you-need-to-know-about-meta-s-frequency-capping-for-whatsapp-business
- https://techcrunch.com/2025/10/17/whatsapp-will-curb-the-number-of-messages-people-and-businesses-can-send-without-a-response

**S6. Meta Lead Ads and Graph version.**
- Current Graph and Marketing API version is v26.0 (29 Jul 2026). v25.0 was released 18 Feb 2026. v24.0 reached end of support on 6 Oct 2026, which has already passed. Sources: https://developers.facebook.com/blog/post/2026/07/29/introducing-graph-api-v26-and-marketing-api-v26/ and https://developers.facebook.com/docs/graph-api/changelog/versions
- Leadgen: subscribe the Page to the `leadgen` field via `POST /{page-id}/subscribed_apps`. The webhook carries only `leadgen_id`, and you fetch the lead with `GET /{leadgen_id}`. Required permissions are `leads_retrieval`, `pages_manage_metadata`, `pages_show_list`, `pages_read_engagement` and `ads_management`. The token holder needs the ADVERTISE task on the Page, and Leads Access Manager can block access. The read rate limit is about 200 × 24 × (leads in the last 90 days) per Page, and leads expire after 90 days. Sources: https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/quickstart/webhooks-integration.md, https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/retrieving and https://leadsync.me/blog/meta-lead-gen-api-guide/
- Campaign control: `POST /{campaign-id}` with `status=PAUSED|ACTIVE`. Source: https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/manage-campaigns
- Marketing API access tier renamed and auto-approval threshold lowered on 4 May 2026. Source: https://developers.facebook.com/docs/marketing-api/marketing-api-changelog

**S7. Meta AI chatbot policy.** WhatsApp Business Solution terms bar "AI Providers" from distributing general-purpose assistants. This applied to new users from 15 Oct 2025 and to everyone from 15 Jan 2026. AI that is "ancillary to a legitimate business service" (support, lead capture, bookings, FAQs) is permitted. Vendors recommend clear human handoff. Sources are press and vendor summaries; read Meta's binding terms text before LIVE launch.
- https://respond.io/blog/whatsapp-ai-chatbot-policy
- https://respond.io/blog/whatsapp-general-purpose-chatbots-ban
- https://www.business-standard.com/technology/tech-news/meta-bans-ai-chatbots-from-whatsapp-business-api-chatgpt-to-shut-down-jan-2026-125102200335_1.html

**S8. India DPDP Rules 2025.** Notified 13 or 14 Nov 2025. The consent-manager rule applies from about Nov 2026. The consent notice (Rule 3) and most other duties apply from about 14 May 2027. The notice must itemise data and purposes, link to withdrawal, and make withdrawal about as easy as giving consent.
- https://www.mondaq.com/india/data-protection/1708164/digital-personal-data-protection-rules-2025-notified
- https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf

### Three-layer synthesis

**Layer 1: tried and true (keep as the PRD has it)**
- Approval-first, auto-send opt-in. Every serious BSP defaults this way for new numbers because WhatsApp quality is the delivery budget.
- Templates for cold touch, free-form only inside the 24h CSW, and the window keyed to inbound only. The PRD gets this exactly right (Messaging rules, window and eligibility bullets).
- Leadgen webhook plus fetch by `leadgen_id`. Standard pattern.
- Server-side pricing, with the LLM proposing IDs only. Standard "LLM proposes, deterministic code disposes."

**Layer 2: what the search changes or sharpens**
- Limits are per portfolio, not per number. The `Integration` model and the Integration center must show the portfolio-level limit, and internal caps must be computed across all numbers in a workspace's portfolio.
- Cost is per delivered template, by category. A template's category is a live attribute Meta can change. That affects margin and therefore the client's ROI story.
- Marketing templates to Indian users can be silently capped by Meta across all senders. A "sent" status is not delivery, and a cap failure must not trigger a retry storm.
- Graph v24 already reached end of support. Hardcoding any version is a near-term outage risk, so the version must be config.
- The AI auto-reply is allowed only because the PRD already scopes it to approved services and facts with escalation. That scoping is now a compliance requirement, not a nicety.
- Market: messaging is commoditised. The quote engine is the wedge. No major India BSP offers price-safe, versioned, AI-drafted quotes.

**Layer 3: first principles (where conventional wisdom may be wrong)**
- Conventional wisdom says "AI chatbot on WhatsApp = engagement." For AuraLead the safer and more valuable framing is that AI drafts and humans or rules dispatch. The money moment is the quote, not the chat. Optimise reply accuracy and time to approved quote, not bot conversation length. This keeps the product inside Meta policy by construction.
- Conventional wisdom says "scrape Maps, then WhatsApp blast." That is the fastest route to number bans, and the PRD forbids it. The honest consequence is that Maps leads are a prospect list, not a messaging audience. The first touch for that source must be manual (call or email) or a channel the lead opts in through. The product should say so plainly rather than imply automation.
- "Quick reply = engagement" is incomplete. A quick reply opens the CSW (PRD, window bullet). That makes a well-designed utility template with "Request quotation" the cheapest path to a free-form quote delivery. The template design is therefore a cost lever, not just UX.

### Findings

| ID | Sev | PRD clause | Finding | Remedy | Type |
|---|---|---|---|---|---|
| L-1 | WARNING | Messaging/Email: "Separate eligibility... WhatsApp consent ≠ email permission"; Lead ingestion: Maps fields; WhatsApp: "Maps imports default to no WhatsApp consent" | The PRD defines WhatsApp eligibility but not what makes a lead email-eligible. For Maps leads (no opt-in, email only from website enrichment) this decides whether that source can be touched at all by the product. A strict rule (opt-in only) makes Maps leads score-and-call only. A loose rule (B2B lawful basis) enables cold email. | Recorded default: `EmailEligibility` requires either an email `ConsentRecord` or an employee-attested `lawful_basis=B2B_LEGITIMATE_INTEREST` record per lead (actor, time, note). Attested leads are manual-send only, never auto-send, and always carry an unsubscribe link and suppression check. Auto-send email requires an opt-in `ConsentRecord`. | (b) MATERIAL, non-blocking. It decides whether one of the three ingestion sources yields automated outreach at all, which changes what the client is sold. Build with the conservative default and ask the user only whether to permit attested B2B cold email. |
| L-2 | WARNING | AI engine: "Automated replies constrained to approved services/facts... escalate" | Meta's 2026 terms forbid general-purpose assistants. An off-topic answer from the auto-reply ("write me a poem") is now a policy breach, not just a quality bug. | Add a `ReplyPolicy` guard in `services/ai/replyGuard.ts`: classify intent into {quote_request, call_request, service_faq, stop, complaint, human_request, out_of_scope}. `out_of_scope` gets a fixed deflection plus a human handoff option, and never a free LLM answer. Log the guard decision to `AuditEvent`. Test: an out-of-scope inbound never yields model free text. Record the policy link and check date in `docs/integrations.md`. | (a) Assumption. The PRD already scopes this; the remedy enforces it. Not MATERIAL. |
| L-3 | WARNING | WhatsApp: "Fetch real quality/limits... Do not hardcode tier lists" | Limits are now per business portfolio, and the old `messaging_limit_tier` field is deprecated. | `Integration` stores `waba_id`, `business_portfolio_id`, `phone_number_id`. `adapters/whatsapp/limits.ts` reads `whatsapp_business_manager_messaging_limit` and stores the raw string plus `checked_at`. If unavailable, show "Unknown, last checked X". Internal caps count unique recipients across all numbers in the portfolio over a rolling 24h, excluding in-CSW sends. | (a) |
| L-4 | WARNING | Shared: "pending/sent/delivered/read/failed"; acceptance #11 | India marketing frequency cap: a send is accepted and then fails asynchronously with a cap error. A naive retry worsens quality. | Map cap error codes (from the verified Meta error reference) to `failure_class=RECIPIENT_FREQUENCY_CAP`, which is non-retryable for the same template within the cap window and goes to review. Fixture test: a cap failure webhook leads to no retry job and a visible reason. | (a) |
| L-5 | WARNING | WhatsApp: "approved templates (language, category, variables, buttons)" | Meta can recategorise templates (utility to marketing), which changes cost and frequency-cap exposure. AI-filled variables with promotional wording can trigger it. | Subscribe to `message_template_status_update` and `template_category_update` webhooks and persist them to `WhatsAppTemplate.category_history`. The AI variable filler rejects promotional tokens for utility templates (discount and urgency word list plus a length cap). The Integration center shows the current category and the date it last changed. | (a) |
| L-6 | OK | WhatsApp: "Quick replies: request quotation, request a call, stop; validate limits" | 3 quick replies fit within the 10-button and 25-char limits. Only 2 or 3 render inline. | Order the buttons Request quotation, Request a call, Stop. Payload IDs `AL_QR_QUOTE_V1`, `AL_QR_CALL_V1`, `AL_QR_STOP_V1` (versioned, at most 200 chars). Do not mix CTA URL buttons between the quick replies. Treat any inbound text matching STOP/UNSUBSCRIBE (and Hindi equivalents) as stop too. | (a) |
| L-7 | WARNING | Working method #9; Lead ingestion `/api/webhooks/meta-ads` | Graph v24 reached end of support on 6 Oct 2026; v26.0 is current. | `META_GRAPH_VERSION=v26.0` in env, read by one `adapters/meta/client.ts`. Startup warns if the version is older than the last verified version. Record it in `docs/integrations.md` with the check date. | (a) |
| L-8 | WARNING | Lead ingestion: Meta adapter "fetching lead details with authorized credentials" | Webhooks drop silently (token expiry, unsubscribed app), and leads expire after 90 days. Leads Access Manager can block a valid admin token. Rate limit scales with lead volume. | Add a `meta_leads_poll` job that pages `GET /{form-id}/leads?since=` per subscribed form as a backstop, deduped by `leadgen_id`. The Integration center checks `GET /{page-id}/subscribed_apps` and shows the result. Distinguish `PERMISSION_DENIED` (Leads Access Manager) from `TOKEN_EXPIRED`. In LIVE without App Review approval of `leads_retrieval`, status = "Verification required". | (a) |
| L-9 | OK | Scope: "campaign metrics + pause/resume" | Pause/resume is `POST /{campaign-id} status`. Delivery reflects `effective_status`, which can differ from `status` (for example ad set paused, account disabled). | Persist both `configured_status` and `effective_status` on `Campaign`. After a write, re-read and show both. Never show "Paused" from the request alone (acceptance #14). | (a) |
| L-10 | WARNING | WhatsApp: "Free-form eligibility computed server-side"; Pages: ROI calculator | Cost per message depends on category and CSW state. The PRD has no cost visibility, yet the ROI calculator and bulk actions imply spend. | Do not hardcode INR rates. In the bulk send preview, show the category and whether each send is inside the CSW (free) or a paid template. The `MessageCostEstimate` uses an editable workspace rate table labelled "configure from Meta's pricing page, last updated X". The ROI calculator keeps rates as visible editable assumptions, as the PRD says. | (a) |
| L-11 | WARNING | ConsentRecord; Messaging: "opt-in evidence (purpose, source, timestamp)" | DPDP Rule 3 consent notice duties start about May 2027. The schema should not need a migration then. | Add `notice_version`, `notice_text_hash`, `channel`, `purpose`, `withdrawn_at`, `withdrawal_method` to `ConsentRecord` now. Withdrawal through Stop is as easy as opt-in. Docs `/docs/data-retention` notes the DPDP timeline as "not legal advice". | (a) |
| L-12 | WARNING | LIVE mode: "tenant-scoped credentials" | Tenant onboarding through Meta Embedded Signup requires Tech Provider status, which a local MVP cannot assume. | LIVE WhatsApp setup = manual entry of system-user token, WABA ID and phone number ID, encrypted, with a connection test. Embedded Signup is listed in limitations and the 12-month ideal. Scope is unchanged. | (a) |
| L-13 | OK | Shared: "Approval-required default. Auto-send opt-in" | Matches market practice and protects quality rating. | No change. Add a test that enabling auto-send writes an `AuditEvent` and that a quality status of RED/FLAGGED auto-pauses the workspace automation (quality-based pause, PRD Messaging rules). | (a) |
| L-14 | OK | Market position | Quotation engine is the uncontested wedge versus Interakt, WATI, AiSensy and Gallabox. | No scope change. Landing and `/docs` copy should lead with "accurate quotes", not "WhatsApp bot", with no competitor names or claims. | (a) |

### Implementation requirements derived (no scope change)
- Modules: `adapters/whatsapp/{client,limits,templates,webhook}.ts`, `adapters/meta/{client,leads,campaigns,webhook}.ts`, `services/ai/replyGuard.ts`, `services/messaging/eligibility.ts`, `services/messaging/costEstimate.ts`, `jobs/metaLeadsPoll.ts`.
- Tables or columns: `WhatsAppTemplate(category, category_history, status, buttons_json, language)`, `Integration(business_portfolio_id, graph_version, limit_raw, limit_checked_at, quality_raw)`, `Message(failure_class)`, `Campaign(configured_status, effective_status, status_checked_at)`, `ConsentRecord(notice_version, notice_text_hash, withdrawn_at, withdrawal_method)`, `EmailEligibility` or `LawfulBasisRecord`.
- Tests to add to the requirement checklist:
  - out-of-scope inbound yields deflection plus handoff, with no model free text
  - frequency-cap failure creates no retry
  - template recategorisation webhook updates the category and cost preview
  - Graph version comes from config
  - campaign pause re-reads `effective_status`
  - leadgen poll and webhook for the same `leadgen_id` yield one lead
  - a Maps lead with no email consent and no attestation is skipped in bulk email with the reason shown

### MATERIAL decisions for the user
1. **L-1: email eligibility for Maps-sourced leads.** Default as built: opt-in or employee-attested B2B basis, manual send only for attested leads, auto-send only with opt-in. Question for the user: may attested B2B leads receive cold email, or must Maps leads stay call/manual-only until they opt in?

No Meta policy found forbids the planned AI auto-reply as the PRD scopes it (L-2). The 2026 restriction targets general-purpose assistants. AuraLead stays compliant as long as the reply guard is enforced.
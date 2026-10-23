# Lead-gen suite, slice F5 (lead actions: handoff and reach-out): handoff

Branch `lg/f5`, worktree `C:\Users\Asus\auralead-wt\f5`, built on the foundation baseline (`0ece53b`).
Spec: plan §5 "F5", ADR-124, ADR-125; the readings F5 settled are ADR-132 (appended to
`docs/decisions.md`). Route-manifest owner T44.

## What was built (P0, all of it)

### Handoff (ADR-124, ADR-132)
- `src/server/services/leads/handoff.ts`
  - `handOverLead(ctx, { leadId, note?, expectedStageVersion, requestKey }, aiDeps)` (`leads.handoff`), one
    `withTx`: stage CAS on `stageVersion` (NEW..QUOTE_SENT -> CONVERTED, CONVERTED stays; LOST 422
    `LEAD_LOST`, merged 422 `LEAD_MERGED`, stale 409 `STAGE_VERSION_CONFLICT`) that also sets
    `Lead.handedOverAt`; every open conversation `aiMode OFF` + `humanTakeover` under a `modeVersion`
    CAS (409 `MODE_VERSION_CONFLICT`), audited `conversation.handoff` per conversation; PENDING
    `OUTBOUND_MESSAGE` approvals of the lead INVALIDATED (`LEAD_HANDED_OVER`) and their DRAFT messages
    NOT_SENT; the operator side's queued, not-yet-sent sends (initiator an EMPLOYEE or `system:*`)
    cancelled (attempt CANCELLED `LEAD_HANDED_OVER`, job CANCELLED or asked to stop, message NOT_SENT;
    the client's own queued sends and quotation sends stay; the count is `cancelledSends` in the audit); the open pipeline execution stopped (first unfinished stage FAILED, reason `HANDED_OVER`);
    the `LeadHandoff` row (`summaryStatus` PENDING, or NOT_CONFIGURED in LIVE without AI, decided
    before the tx by `selectWorkspaceAi`); `handoff.summary` enqueued for PENDING; PII-free
    `lead.handoff` audit (stages, ids, counts, summary status, `hasNote`, `requestKey`; never the note).
    A second handoff is 409 `ALREADY_HANDED_OVER`; the same person replaying the same request key
    gets the first result (`created: false`, matched through the audit row).
  - `acknowledgeHandoff(ctx, { handoffId })` (USER, `leads.read`): HANDED_OVER -> ACKNOWLEDGED once,
    audited `lead.handoff.acknowledge`.
  - `listClientHandoffs(ctx, { status: 'open' | 'all' })` (USER), `loadLeadHandoff(ctx, leadId, aiDeps?)`
    for both lead pages (`aiDeps` only on the operator page: says whether a summary would be written).
- `src/server/services/ai/handoff-summary.ts`: `generateHandoffSummary` (outside any tx:
  `selectWorkspaceAi` + `runStructuredTask`, task `handoff_summary`, strict `{asked, promised, nextStep}`,
  last 30 sent/received messages as untrusted data, quote numbers and statuses only, output policy:
  a violation stores FAILED `OUTPUT_POLICY`), `persistHandoffSummary` (only while PENDING; audit
  `lead.handoff.summary` with codes and labels only).
- `src/server/adapters/ai/local/handoff-summary.ts`: the DEMO generator (`local-deterministic`, labelled
  "Local template"); topics from catalog names and keyword families, never the customer's text.
- `src/server/jobs/handlers/handoff-summary.ts`: `handoff.summary`, kind `ai`, payload v1 `{ handoffId }`,
  idempotency key `handoff.summary:<handoffId>`; no-op for a gone or non-PENDING handoff.
- Routes: `POST /api/app/leads/[leadId]/handoff` (USER + EMPLOYEE, `workspaceSlug`, rate limit `handoff`
  keyed `handoff:<userId>`), `GET /api/app/handoffs?status=open|all` (USER), `POST
  /api/app/handoffs/[handoffId]/acknowledge` (USER).
- Client surfaces: command-center "Needs you" line `handedOverLeads` ("Handed over to you", first in
  `NEEDS_YOU_ORDER`, href `/dashboard/user/leads?handedOver=1`, query `OPEN_HANDOFF_WHERE`; the
  command center is now 13 statements); `handedOver` in `LeadFilters` (`?handedOver=1`,
  `HANDED_OVER_PARAM`), `leadFilterWhere`, `leadPageSearch`, `hasLeadFilters`; the toolbar "Handoff"
  select; the client lead page block "Handed over to you" (note, summary with `AiProvenance`, summary
  status, Acknowledge, polling while PENDING).
- Operator surfaces: the operator lead page block "Hand over to the client" (dialog listing what will
  happen, optional note, one request key per opened dialog; GatedAction for permission, merged, lost),
  after the handoff the card with the read-only wording, and a "Handed over" chip in the header.

### Reach-out (ADR-125, ADR-132)
- `grantManualConsent` (services/messaging/consent.ts): a WHATSAPP MARKETING grant needs
  `evidence.method` (422 `EVIDENCE_METHOD_REQUIRED`) and the notice (422 `NOTICE_REQUIRED`) naming the
  workspace (422 `NOTICE_MISSING_BUSINESS_NAME`; case, width and spacing folded). Evidence keeps
  `method` and the verbatim `noticeText` (plus `noticeTextHash`); the first recorded WhatsApp opt-in sets
  `Lead.contactConfirmedAt/Via` = RECORDED_OPT_IN. Audit gains `method` and the field names. The rules
  are in the service (after the capability check), so the schema stays shape-only and the T18 matrix
  entry is unchanged. `ManualConsentBody.evidence.method` (`OPT_IN_METHODS`, labels in
  `src/lib/schemas/consent.ts`).
- `src/server/services/leads/reach-out.ts`: `loadReachOut` (notice prefill: the workspace's own or
  `defaultOptInNotice(name, privacyContact)`; click-to-chat from the WHATSAPP_CLOUD config
  `displayPhoneNumber`, integration not NOT_CONFIGURED/REVOKED, SIMULATED labelled), `updateReachOutSettings`
  (`automation.manage`; notice must name the business; audit `workspace.reach_out` with field names),
  `buildClickToChat` (422 `PREFILL_IS_KEYWORD` when the prefill folds to a START/STOP keyword, folded with
  `foldKeyword` like inbound messages; 422 `CLICK_TO_CHAT_NOT_CONFIGURED`).
- Routes: `POST /api/app/settings/reach-out`, `POST /api/app/settings/reach-out/click-to-chat` (USER +
  EMPLOYEE, `workspaceSlug`).
- `src/components/reach-out/**`: the panel (WhatsApp state icon + label + what it allows; "Record
  WhatsApp opt-in" form; click-to-chat link with Copy and "Update link"; the workspace notice form in a
  disclosure for `automation.manage`; read-only after the handoff), wired into the operator lead page.

## Shared-file insertions (own anchor blocks only)
- `src/server/routes.manifest.ts` F5 block: 5 entries, owner T44 (handoff, handoffs list, acknowledge,
  settings/reach-out, settings/reach-out/click-to-chat). Expectations: the B-slug calls answer
  401/404/404/403/404 (click-to-chat: 422 for `employeeNoCapability`, a STOP prefill, since `leads.read`
  is enough); slug-less calls `signedIn(404)` or `ownerA: 422` (refusals that write nothing); list
  `ownerA: 200`.
- `src/server/jobs/registry.ts` F5 blocks: `import { handoffSummaryJob }` and `handoffSummaryJob`.
- `src/components/metrics/activity-vocabulary.ts` F5 block: `lead.handoff`, `lead.handoff.summary`,
  `lead.handoff.acknowledge`, `conversation.handoff`, `workspace.reach_out`.
- `tests/support/routes.ts` F5 block: fixture `handoffs.unknownId` = `handoffmatrixprobe0000000`.
- `src/server/adapters/ai/local-deterministic.ts`: `handoff_summary: generateLocalHandoffSummary` under the
  F5 `LOCAL_TASKS` anchor, and its import line right after the `./local/draft` import (there is no import
  anchor; F3 and F4 add theirs at the same spot, so expect a trivial merge there).

## Owned files edited (plan §5 F5)
`services/metrics/definitions.ts`, `services/metrics/command-center.ts`, `src/lib/schemas/leads.ts`
(filter lines only), `services/leads/list.ts`, `components/leads/LeadsToolbar.tsx`,
`services/messaging/consent.ts` (`grantManualConsent` only) and `src/lib/schemas/consent.ts`, both lead
pages (`dashboard/employee/[ws]/leads/[leadId]/page.tsx`, `dashboard/user/leads/[leadId]/page.tsx`).
New: `src/lib/schemas/handoff.ts`, `src/lib/schemas/reach-out.ts`, `services/leads/{handoff,reach-out}.ts`,
`services/ai/handoff-summary.ts`, `adapters/ai/local/handoff-summary.ts`, `jobs/handlers/handoff-summary.ts`,
`components/handoff/**`, `components/reach-out/**`, the five route files.

Tests outside `tests/**/handoff/**` changed because of F5's behaviour change:
`tests/integration/metrics/metrics-match-db.test.ts` (exact "Needs you" map gains `handedOverLeads`),
`tests/integration/consent/{reoptin-ordering,email-eligibility}.test.ts` (their WhatsApp MARKETING
grants now carry a notice and a method).

## Job types, rate limits, labels, codes
- Job type: `handoff.summary` (LEAD_GEN_JOB_TYPES.handoffSummary), kind `ai`, payload v1.
- Rate limit: `handoff` (30/min per person).
- Audit actions: `lead.handoff`, `lead.handoff.summary`, `lead.handoff.acknowledge`,
  `conversation.handoff`, `workspace.reach_out`; `consent.grant` gains `method`.
- Error codes: `ALREADY_HANDED_OVER`, `LEAD_LOST`, `LEAD_MERGED` (handoff), `STAGE_VERSION_CONFLICT`,
  `MODE_VERSION_CONFLICT`, `EVIDENCE_METHOD_REQUIRED`, `NOTICE_REQUIRED`, `NOTICE_MISSING_BUSINESS_NAME`,
  `PREFILL_IS_KEYWORD`, `CLICK_TO_CHAT_NOT_CONFIGURED`, `SETTINGS_MISSING`.
- `Approval.invalidationReason` `LEAD_HANDED_OVER`; `PipelineStageRun.reasonCode` `HANDED_OVER`.

## Requests for the integrator and other slices (files F5 does not own)
1. **F3 inbox:** add `'conversation.handoff': () => 'Handed over to the client. AI replies are off.'` to
   `MODE_EVENT_LABELS` in `services/messaging/inbox.ts` (the handoff audits every conversation it
   changes); the inbox badge/filter can read `Lead.handedOverAt` or the `LeadHandoff` row.
2. `src/components/leads/lead-vocabulary.ts` `RUN_REASONS`: `HANDED_OVER: 'Stopped: the lead was handed
   over to the client.'` (the pipeline rail shows the generic sentence until then).
3. `src/components/metrics/NeedsYouList.tsx` `ICONS`: `handedOverLeads: Handshake` (falls back to
   CircleAlert now).
4. `src/components/metrics/ActivityFeed.tsx` `targetHref`: link `Lead` targets to
   `/dashboard/user/leads/<id>` (the handoff audits target the Lead).
5. **F2 export:** `LeadsWorkspace.tsx` passes explicit export filters to `LeadExportPanel`; add
   `handedOver: params.handedOver` there, and `handedOver` to the filter summary in
   `services/leads/export.ts` (the export query already honours it through `leadFilterWhere`).
6. **F6 seed:** give the seeded operator `leads.handoff` for codecraft-web; the handed-over lead needs a
   `LeadHandoff` row (status HANDED_OVER, `summaryStatus` READY, `summary` = JSON `{asked, promised,
   nextStep}`, `summaryGeneratorLabel` `local-deterministic`), `Lead.handedOverAt`, and its conversations
   `aiMode OFF` + `humanTakeover`; `WorkspaceSettings.whatsappOptInNotice` naming "Codecraft Web Studio"
   and a `privacyContact`; WHATSAPP_CLOUD `config.displayPhoneNumber` (E.164) for the click-to-chat link.
   `content/docs`: the rate-limit table (`handoff`), the "Needs you" line, the opt-in notice rule and the
   retention of handoff notes and summaries (erased with the lead, B1).
7. `src/components/admin/people-vocabulary.ts` `ADMIN_ACTION_LABELS`, if the admin audit search should
   name the five new actions.

## Open questions
- After a handoff the operator panel hides "Record WhatsApp opt-in", but the consent route itself does
  not refuse an operator (the guard covers sends and conversation modes only). Refuse it too?
- Should the client's first reply in a handed-over thread acknowledge the handoff automatically?
- F3 may add its own "Needs you" line for `escalatedAt`; `NEEDS_YOU_ORDER` puts `handedOverLeads` first.

## Deferred
Nothing from P0. `leads/[leadId]/confirm-contact` is left to F1 (its P1 "Confirm details").

## Gate (Windows 11, Node 22.23.2)
- `npm run typecheck`: exit 0.
- `npx eslint` on every F5 path and edited shared file: 0 problems.
- `npx vitest run --maxWorkers=2 tests/unit/arch tests/unit/lib/domain-enums.test.ts tests/unit/integrations
  tests/unit/docs tests/integration/authz/tenant-matrix.test.ts tests/integration/handoff tests/unit/handoff
  tests/components/handoff tests/components/reach-out tests/integration/metrics tests/integration/consent
  tests/integration/leads tests/components/leads tests/unit/ai tests/unit/lib/lead-gen.test.ts tests/integration/ai`:
  60 files, 1021 tests passed, 0 failed, 0 skipped. Also `tests/integration/inbox tests/components/inbox
  tests/components/metrics tests/integration/shell tests/integration/bulk tests/integration/ops/lead-erase.test.ts`:
  12 files, 65 passed.

Final run after the queued-sends cancellation and the DEMO tripwire test were added: `npm run typecheck`
exit 0; eslint on every F5 and edited shared file, 0 problems; the same vitest set plus
`tests/integration/dispatch tests/integration/messaging`: 92 files, 1173 tests passed, 0 failed, 0 skipped.

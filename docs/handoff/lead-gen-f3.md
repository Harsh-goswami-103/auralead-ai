# Lead-gen F3: chat and AI replies (handoff)

Branch `lg/f3`, worktree `C:\Users\Asus\auralead-wt\f3`, from the foundation baseline `0ece53b`.
Spec: plan §5 F3, ADR-121, ADR-122; the points the slice settled are ADR-130 (appended to
`docs/decisions.md`).

## What was built

P0 and P1 are complete.

**AI replies (ADR-122, ADR-130).**
- `src/server/services/ai/conversation-reply.ts`: the `conversation_reply` task. Prompt builder
  (catalog facts only: name, description, typical timeline days; the last 12 messages as untrusted
  data through `sanitizeUntrusted`; strict JSON `{reply, intent, escalate}`), `generateConversationReply`
  (`selectWorkspaceAi` + `runStructuredTask` with one repair; a test seam `selectAi`), and the pure
  `decideFromModel` (model text only for service_faq, no escalation, output policy clean; otherwise
  `FIXED_REPLIES.handoff` with MODEL_ESCALATED, OUTPUT_POLICY or AI_FAILED, labelled `reply-guard`).
- `src/server/adapters/ai/local/conversation-reply.ts`: the DEMO generator, keyword-aware over the
  catalog (named services, timeline questions, what is included, a catalog list for general
  questions; price and call questions reported as non-FAQ with escalation). One line in `LOCAL_TASKS`.
- `src/server/services/messaging/conversations.ts`: `reply.auto` split into `prepareAutoReply`
  (outside any transaction: state checks, guard, model) and `commitAutoReply` (fenced final
  transaction: re-checks newest inbound, mode, takeover, `Lead.handedOverAt`, window, then
  eligibility for consent etc.; audit; escalation with `escalatedAt`; cap of 4; disclosure on the
  first automated reply of the window; queue AUTOMATED with the generator's label, or draft).
  `afterInboundMessage` enqueues kind `ai` and skips handed-over leads. `getWorkspaceAutoSend` added.
  Mode change and Resume AI clear `escalatedAt`.
- `src/server/jobs/handlers/reply-auto.ts`: kind `ai`, two steps, `finalAttempt` passed through.
- `src/server/services/ai/reply-guard.ts`: ADR-122 header (supersedes "never asks a model"),
  `automatedReplyDisclosure`, `EscalationReason` += MODEL_ESCALATED, AI_FAILED, REPLY_CAP, and
  web-development words in the FAQ vocabulary (build/design websites, included, features, hosting,
  landing page, e-commerce, maintenance, portfolio).

**Operator inbox and chat UI (ADR-121, ADR-124).**
- Pages: `src/app/dashboard/employee/[ws]/inbox/page.tsx` and `[conversationId]/page.tsx`
  (`workspacePage(ws)`, `readOrNull` -> NotInAssignment, unknown conversation 404). The client pages
  under `src/app/dashboard/user/inbox/**` now use the same `ConversationView`.
- Routes widened to USER + EMPLOYEE with optional `workspaceSlug` (consoleContext), capability checks
  in the services: `/api/app/messages`, `/api/app/messages/drafts`,
  `/api/app/conversations/[conversationId]/{mode,takeover,resume}`. New
  `POST /api/app/settings/auto-send` (`{ enabled, workspaceSlug? }`, `automation.manage` in the service).
- `src/lib/schemas/inbox.ts`: `workspaceSlug` on every body, `AutoSendBody`.
- `src/server/services/messaging/inbox.ts`: rows gain `escalated`, `handedOverAt`; filters
  `all | needs_you | handed_over` with counts; the thread gains `handoff` (LeadHandoff + operator
  name), a `HANDOFF` event "Handed over to <client> by <operator>.", `readOnly` for EMPLOYEE actors on
  a handed-over lead, `conversation.escalated`, `permissions.canManageAutomation`, template message
  previews (header text or document name, body with values, footer, buttons), and composer
  templates with per-lead fields from `resolveLeadTemplateVariables`. `sendComposerMessage` checks
  the handoff before eligibility, resolves template values on the server
  (422 TEMPLATE_VARIABLES_MISSING / TEMPLATE_NOT_SENDABLE) and clears `escalatedAt`.
- Components (`src/components/inbox/**`): `ThreadList` (`basePath`, ticks with words in previews,
  window badge in the chat accent, Needs you, Escalated, Handed over), `ThreadTimeline` (wallpaper,
  bubbles with tails, `DeliveryTick` with its label, day separators, template bubbles, AiProvenance
  on automated replies, handoff pill), `Composer` (`workspaceSlug`, `readOnly`, template fields and
  preview bubble, server reasons shown), `ModeControls` (`workspaceSlug`, `readOnly`),
  `InboxFilter` (`basePath`, Handed over), new `AutoSendToggle`, `CustomerPhone` ("Customer's phone
  (Simulated)", DEMO only), `ConversationView`, `DeliveryTick`, `filters.ts`; `DemoSimulator` takes
  `workspaceSlug`.

**DEMO ticks (P1).** `src/server/jobs/handlers/wa-demo-status.ts` (`wa.demoStatus`): queued by the
one-line hook after `settleSent` in `dispatch-run.ts` (DEMO, WhatsApp, simulated send only),
delivered after 2 s and read 4 s later through `receiveWhatsAppWebhook` + `status.apply`, flagged
simulated; refuses a LIVE process or workspace (dead `DEMO_ONLY`); no provider call.

## Shared-file insertions

| File | Where | What |
|---|---|---|
| `src/server/routes.manifest.ts` | F3 block | `/dashboard/employee/[ws]/inbox`, `/dashboard/employee/[ws]/inbox/[conversationId]`, `/api/app/settings/auto-send` (owner T42) |
| `src/server/routes.manifest.ts` | T22 entries (in place, owner kept T22) | messages, messages/drafts, conversations/[id]/{takeover,resume,mode}: roles USER+EMPLOYEE, a second call with `workspaceSlug` of B (employeeNoCapability 403) |
| `src/server/jobs/registry.ts` | F3 import block, F3 `JOB_DEFINITIONS` block | `waDemoStatusJob` |
| `src/components/integrations/sections.ts` | F3 icon import block, F3 list block | `{ segment: 'inbox', label: 'Inbox', icon: MessageCircle }` |
| `src/server/adapters/ai/local-deterministic.ts` | `LOCAL_TASKS` F3 line, plus one import line after the `./port` import | `conversation_reply: generateLocalConversationReply` |
| `src/server/jobs/handlers/dispatch-run.ts` | the `sent` case (the hook line) and one import | `.then(() => queueDemoStatus(...))` |

Not touched: `activity-vocabulary.ts`, `adapters/registry.ts`, `tests/support/routes.ts` (the
existing `inbox.unknownConversationId` probe serves every new entry), `registry-live.test.ts`.

## Job types, rate limits, labels, fixtures

- Job types: `wa.demoStatus` (new, kind default, payload v1 `{messageId, providerMessageId, status}`);
  `reply.auto` is now kind `ai` (3 attempts; jobs enqueued before the merge keep their stored kind).
- Rate-limit policies: none added or used.
- Activity labels: none. New audit actions: none (escalations reuse `conversation.escalated` with new
  `reason` values REPLY_CAP, MODEL_ESCALATED, AI_FAILED; `reply.not_generated` gains reasons
  HANDED_OVER and WINDOW_CLOSED; `reply.guard` gains `generatorLabel`, `modelId`, `modelIntent`,
  `modelCalled`).
- Fixture keys: none added.
- New error codes (422): `TEMPLATE_VARIABLES_MISSING`, `TEMPLATE_NOT_SENDABLE`.

## Edits outside the owned paths (for the integrator)

- `tests/components/integrations/source-actions.test.tsx`: the section-nav test now compares with
  `WORKSPACE_SECTIONS` (any slice adding a section would otherwise edit the same literal list).
- `tests/integration/messaging/inbound-support.ts`: `createInboundHarness(label, { replyDeps?, extraDefs? })`.
- `tests/integration/ai/conversation-reply.test.ts` runs due jobs until the customer's message is
  recorded (`processUntilRecorded`) instead of assuming one `tick()` is `webhook.process`: a DEMO
  send in an earlier test leaves a due `wa.demoStatus` job, which a single tick would run first.
  Other suites that tick once after a DEMO WhatsApp send can hit the same ordering.
- Updated existing tests for ADR-122 behaviour: `tests/integration/ai/auto-reply-guard.test.ts`
  (disclosure, `local-deterministic` label in DEMO), `tests/integration/inbox/inbox.test.ts`
  (draft label), `tests/unit/ai/reply-guard.test.ts` (vocabulary), `tests/components/inbox/*`.

## Open questions and deferred

- **Lead page "Open chat" link** (operator lead page -> `/dashboard/employee/<ws>/inbox/<id>`): not
  added; the lead pages are the integrator's to wire. `ConversationView` already links back to
  `/dashboard/employee/<ws>/leads/<leadId>`.
- **Clearing `escalatedAt` on the approval queue's send**: `approveAndSendMessage` (dispatch.ts) does
  not clear the column; the inbox read model treats a MANUAL_SINGLE send queued after the escalation
  as settling it. The integrator may add a one-line clear there if the column itself should be null.
- **F6 docs**: `content/docs` does not describe AI replies, the disclosure, the cap, Automatic
  sending's wording or the operator inbox yet; the route table in `roles-and-panels.ts` lists only
  `/dashboard/user/inbox`. `messaging-rules.ts` still says "workspace auto-send" (true, but the UI now
  says "Automatic sending").
- **F6 seed**: for the story, seed codecraft-web with `autoSendEnabled: true`, its open-window thread
  in `aiMode AUTO`, a web-development catalog (the local generator and the guard vocabulary key on
  service names) and `REBASE_COLUMNS` for Conversation/Message times; the handed-over lead needs a
  `LeadHandoff` row for the timeline event's operator name.
- **E2E**: `tests/e2e/inbox/*` should still pass (labels kept: "Customer text", "Simulate customer
  message", "Free-form until", "You are handling", `[data-status-label]` only on sent messages), but
  were not run (no dev servers in a slice).
- `reply.auto` jobs already queued with kind `default` before the merge run under the new handler
  unchanged (kind only sets max attempts at enqueue).

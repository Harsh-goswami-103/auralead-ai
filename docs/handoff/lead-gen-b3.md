# Lead-gen Foundation-B3 (shared) handoff

Branch `lg/b3`, from Foundation-A (61b4352). Plan §4 "B3 shared". Tests first; no schema,
migration or package changes.

## What was built

### Per-lead template variables (`src/lib/domain/whatsapp-templates.ts`, ADR-123)
- `TEMPLATE_VARIABLE_SOURCES` gains `lead.firstName` ("Customer first name"), `lead.city`
  ("Customer city") and `lead.category` ("Customer business category"); `lead.displayName` and
  `workspace.name` already existed. `parseTemplateMapping`, the mapping form's select and
  `TemplateMappingBody` pick them up from that one map.
- `LEAD_TEMPLATE_VARIABLE_SOURCES` (the five sources a lead and its workspace resolve, no contact
  data) and `isLeadTemplateVariableSource`.
- `leadFirstName(displayName)`: the first word after a title (Mr, Mrs, Ms, Miss, Dr, Prof, Shri,
  Sri, Smt, Kumari), letters and combining marks plus `'` and `-`; `null` for a business-style
  name starting with "The" or a digit. Callers map `lead.displayName` for those.
- `resolveLeadTemplateVariables({positions, sources, literals?}, lead, workspace)`, pure:
  - `positions` is `templateShape(...).bodyVariables`, `sources` is `parseTemplateMapping(...).body`;
    an unmapped position counts as `manual`.
  - Lead and workspace sources come from the rows and ignore literals (per-lead stays per lead);
    `manual` positions keep the caller's literal; `quote.*` and `ai.firstTouch` take a literal the
    caller computed.
  - Values are folded to one line (newlines, tabs and space runs to one space; Meta rejects them in
    a parameter) and never cut: longer than `TEMPLATE_VARIABLE_MAX_LENGTH` (200, the bulk form's
    limit) is reported.
  - Returns `{ok, values, missing}`; `missing` lists `{position, source, reason}` with reason
    `NO_VALUE`, `NOT_PROVIDED`, `NEEDS_CONTEXT` or `TOO_LONG`. Nothing is ever invented.
  - Placed above `templateShape`, as plan §5 F4 asks; F4 owns the DOCUMENT-with-asset rule below it.

### Shared constants (`src/lib/domain/lead-gen.ts`)
- `LEAD_GEN_SLICES` F1..F6, `LEAD_GEN_SLICE_NAMES`, `LEAD_GEN_MANIFEST_OWNERS` (F1 T40 .. F6 T45),
  `leadGenAnchor(slice)` (the exact anchor comment text).
- `LEAD_GEN_JOB_TYPES` and `LEAD_GEN_JOB_OWNERS` (job type to slice), `LEAD_GEN_AI_TASKS`
  (`conversation_reply`, `template_copy`, `handoff_summary`).
- `FINDER_EMAIL_STATUSES` NOT_REQUESTED, PENDING, FOUND, NONE_FOUND, NO_WEBSITE, BLOCKED (robots.txt
  disallows), FAILED, with `FINDER_EMAIL_STATUS_LABELS`; `FINDER_EMAIL_KINDS` ROLE, PERSONAL,
  FREEMAIL.
- `CONTACT_CONFIRMED_VIA` INBOUND_WHATSAPP, RECORDED_OPT_IN, WEBSITE_EMAIL, OPERATOR with labels
  (ADR-118 (d); not in the plan's B3 list, added because F1, F3 and F5 all write
  `Lead.contactConfirmedVia`).
- `HANDOFF_SUMMARY_STATUSES` READY, PENDING, NOT_CONFIGURED, FAILED with labels.
- `TEMPLATE_DRAFT_STATUS` `DRAFT`, `TEMPLATE_SUBMITTING_STATUS` `SUBMITTING`,
  `LOCAL_TEMPLATE_STATUSES`, `isLocalTemplateStatus(status)` (trimmed, upper-cased; for the sync's
  "never missing" rule).

### Chat tokens (ADR-121)
`src/styles/tokens.css` `:root` and `src/app/globals.css` `@theme inline` (utilities
`bg-chat-wallpaper`, `bg-chat-bubble-in`, `bg-chat-bubble-out`, `bg-chat-accent` / `text-chat-accent`,
`text-chat-tick-read`, `text-chat-meta`):

| Token | Value | Use |
|---|---|---|
| `--chat-wallpaper` | `#0b141a` | conversation background |
| `--chat-bubble-in` | `#202c33` | the customer's messages |
| `--chat-bubble-out` | `#144d37` | the business's messages |
| `--chat-accent` | `#00a884` | unread count, window-open chip, header hairline; ink (`text-cyan-fg`) on its fills |
| `--chat-tick-read` | `#53bdeb` | read tick (may color its "Read" label) |
| `--chat-meta` | `#aebac1` | times, tick labels |

Proven in `tests/unit/design/contrast.test.ts` (all text >= 4.5:1): text-1 and text-2 on both bubbles
(text-3 is not for bubbles: 3.5:1 on the outgoing one), meta on both bubbles, wallpaper, bg-1, bg-2;
tick-read on the outgoing bubble (4.59), wallpaper, bg-1, bg-2; aura links on both bubbles; text-1 and
text-2 on the wallpaper; ink on the accent fill; the accent as text on wallpaper, incoming bubble, bg-1,
bg-2. `tests/unit/design/tokens.test.ts` pins hex values, the theme mapping, no reuse of a reserved
hue (status, demo, AI, aura, azure, zest, the Sheets chart series) and no chat token in a gradient.
Buttons and links stay aura.

### Rate limits (`src/server/security/rate-limit.ts`)
`finderRun` 10 per hour (per workspace, paid Places calls), `leadImport` 10 per minute (uploads up to
about 7 MB), `templateSubmit` 20 per hour (per workspace), `handoff` 30 per minute (per person). The
exact-policy test is updated; keys are composed by the slices' routes.

### Anchor blocks
Six blocks (F1..F6) in each area; spellings and usage in
[`lead-gen-worktrees.md`](lead-gen-worktrees.md):

| File | Areas |
|---|---|
| `src/server/routes.manifest.ts` | end of `ROUTES` |
| `src/server/jobs/registry.ts` | handler imports; end of `JOB_DEFINITIONS` |
| `src/components/metrics/activity-vocabulary.ts` | end of `ACTIVITY_LABELS` |
| `src/server/adapters/registry.ts` | adapter imports; end of file |
| `src/components/integrations/sections.ts` | icon imports; end of `WORKSPACE_SECTIONS` |
| `tests/support/routes.ts` | end of `MATRIX_FIXTURES` |
| `tests/unit/arch/registry-live.test.ts` | imports; `DEMO_MODULES`; `LIVE_MODULES`; `LIVE_FUNCTIONS`; end of file |

Beyond the task's list: import areas in the adapter registry, sections and registry-live (a slice
must import its adapter, icon or resolver without touching a shared import line), and
`LIVE_FUNCTIONS` in registry-live: the static test compared an inline list of `live*` function names,
which F1's `livePlaces*` (and any F4 template-admin LIVE branch) would otherwise have to edit outside
a block. The list moved into a constant with anchors; the assertion is unchanged.

New guard `tests/unit/arch/lead-gen-anchors.test.ts`: every area holds F1..F6 in order, nothing
misspelled, nested or unclosed; a manifest entry inside a block has that block's owner; no T40..T45
entry sits outside its block.

### Worktree protocol
`docs/handoff/lead-gen-worktrees.md` (plan §6 and §7, plus the anchor table and merge order).

## Shared-file insertions by B3
Only the empty anchor blocks above, each preceded by a one-line comment (and a section comment in the
manifest and the adapter registry). No job types, activity labels, manifest entries or fixture keys
were added.

## Tests
- `tests/unit/lib/whatsapp-templates.test.ts` (new, 29): sources, mapping parse and schema,
  `leadFirstName`, resolver (literals, precedence, missing reasons, folding, length, ordering, end to
  end with `templateShape`).
- `tests/unit/lib/lead-gen.test.ts` (new, 11): slices, owners, anchors, job types (exact, owners,
  valid registry names, no collision with the 27 pre-suite types), AI tasks, statuses.
- `tests/unit/arch/lead-gen-anchors.test.ts` (new, 8).
- `tests/unit/design/tokens.test.ts` (+4), `tests/unit/design/contrast.test.ts` (+5),
  `tests/unit/security/rate-limit.test.ts` (exact policies + one lead-gen case).

## Open questions and notes for the integrator
- The security docs page (`content/docs/**`, F6 after the merge) lists rate limits; the four new
  policies are not in its table yet. The docs test only checks that listed rows match.
- ADR-121's "Covered by" could name `tests/unit/design/tokens.test.ts` and `contrast.test.ts` for the
  `--chat-*` tokens (decisions.md is outside B3's paths).
- `WORKSPACE_SECTIONS` blocks sit at the end of the list; F1's brief asks for "Lead finder" first if
  the tests allow. Reordering is a one-line move for the integrator after the slices merge.
- `BulkTemplateVariables` (src/lib/schemas/bulk.ts) keeps its literal 200; it could reuse
  `TEMPLATE_VARIABLE_MAX_LENGTH` (F4 owns bulk).
- `activity-vocabulary.ts` `FAMILIES` (row icons) has no anchor; lead-gen actions get a family icon
  only when their prefix matches an existing family (`lead.`, `conversation.`, ...), otherwise the
  History icon.

## Deferred
Nothing in B3's list.

# Lead-gen Foundation-B2: AI plumbing (handoff)

Branch `lg/b2`, from Foundation-A (61b4352). Plan section 4 "B2 AI". No schema, migration,
package or shared-file edits outside the B2 paths.

## What was built

### `src/server/services/ai/run-task.ts`

- `selectWorkspaceAi(ctx, deps, { forceLocal? })` returns `WorkspaceAiSelection`:
  - DEMO: the labelled local generator (`local-deterministic`). Integration rows are never read.
  - LIVE: the workspace's own AI integration with its key decrypted. Anthropic is tried first,
    then OpenAI (OpenAI needs a model id).
  - LIVE with nothing usable returns `{ ok: false, code: 'AI_NOT_CONFIGURED', errorCode, label:
    'none', modelId: null }`. `errorCode` is `CREDENTIAL_DECRYPT_FAILED` when a stored key would
    not decrypt. It never falls back to the local generator silently (ADR-18).
  - `forceLocal` (an explicit local action) gets the local generator in LIVE.
  - A workspace whose stored mode differs from the process mode returns `MODE_MISMATCH`.
- `runStructuredTask({ port, task, system, user, jsonSchema, zod | evaluate, maxTokens, finalAttempt, signal? })`
  returns `{ ok: true, value, response, repaired } | { ok: false, error: AppError }`:
  - Malformed, empty or truncated output gets exactly one repair call. The repair carries the
    issues and the previous output, and a truncation raises max tokens by half. A second invalid
    output returns `AI_MALFORMED_OUTPUT`.
  - A retryable provider failure is rethrown while job attempts remain. On the final attempt it
    is a failed result. Auth failures, rejections and refusals fail at once, with no repair.
    Errors that are not AppErrors are rethrown.
  - `task` must equal the `task` field of `user`, or the call throws before reaching the port.
    Build `user` with `taskUserMessage(task, data)`, which returns `{ task, data }` as JSON.
  - `zod` validates the parsed JSON. `evaluate(raw)` is the alternative for custom validation:
    lead drafts use it to keep strip-and-flag (`evaluateDraftOutput`).
- Also exported: `taskUserMessage`, `loadAiIntegrations`, `callPort`, `defaultAiDeps()` (key ring
  from `getConfig()`, resolved lazily), `AiDeps`, `NOT_JSON_ISSUES`, `EMPTY_OR_CUT_OFF_ISSUES`.
- `drafts.ts` is moved onto these functions. `DraftDeps` is now an alias of `AiDeps`, and
  `deps.ts` is unchanged. The behaviour is the same, and every existing test in
  `tests/integration/ai`, `tests/unit/ai` and `tests/integration/pipeline` passes unchanged.

### `src/server/adapters/ai/local-deterministic.ts`, now a dispatcher

- `generate` reads the `task` field of the JSON user message and calls
  `LOCAL_TASKS[task]({ message, seed })`. `message` is the parsed user message. `seed` is the
  first 4 bytes of the sha256 of `user`, as before. The result is serialized with
  `JSON.stringify`.
- It throws a `TypeError` with a clear message in each of these cases: the task is unknown
  (inherited keys such as `toString` included), the message has no string `task`, or `user` is not
  JSON.
- The `lead_draft` branch moved to `src/server/adapters/ai/local/draft.ts`
  (`generateLocalDraft`). Its output is byte-identical: golden sha256 values recorded before the
  move are checked in `tests/unit/ai/local-dispatch.test.ts`.
- `LocalTaskInput` and `LocalTaskGenerator` types are exported for the slices' modules.

### `src/components/ai/`

- `AiProvenance.tsx` (server-safe): `<AiProvenance generatorLabel modelId? className? />`.
  - Kind `ai` (anthropic, openai) renders a violet "AI prepared" chip with a sparkle icon. Its
    title names the provider, plus the model when one is given.
  - Every other kind renders the existing neutral `GeneratorChip`: "Local template",
    "Automatic reply", "System text", or an unknown label as itself.
  - `human`, `none` and empty labels render nothing.
- `AiActionButton.tsx` (`'use client'`): `<AiActionButton onAction label? pendingLabel? pending? local? gate? size? className? />`.
  - Default label "Generate with AI", in violet outline with a sparkle icon.
  - While busy (its own promise, or the caller's `pending`, e.g. a queued job) it shows
    `aria-busy`, a spinner and the pending label ("Generating..." by default), and ignores repeat
    clicks. It never uses the `disabled` attribute.
  - `local` gives "Generate with local template" in a neutral style with a wand icon (truthful UI).
  - `gate` renders the shared `GatedAction`: inert, with the reason and fix link, never violet.
  - Exports `AI_ACTION_LABEL` and `LOCAL_ACTION_LABEL`.
- No lint rule changed (the AI_TOKEN rule already allows `src/components/ai/**`), so no lint-rule
  test case was needed.

## How the slices use it (F3 conversation_reply, F4 template_copy, F5 handoff_summary)

```ts
const selection = await selectWorkspaceAi(ctx, deps); // deps: defaultAiDeps() in production
if (!selection.ok) { /* F3: keep reply-guard fixed text; F4: configuration gate; F5: summaryStatus NOT_CONFIGURED */ }
const result = await runStructuredTask({
  port: selection.port,
  task: 'handoff_summary',
  system,
  user: taskUserMessage('handoff_summary', data),
  jsonSchema,
  zod: schema,
  maxTokens,
  finalAttempt: job.job.attempts >= job.job.maxAttempts, // true for a request-time call
});
// generatorLabel = selection.port.label, modelId = selection.port.modelId; apply the task's output policy to result.value.
```

To add the local (DEMO) branch of a task:

1. Write `src/server/adapters/ai/local/<task>.ts` exporting a `LocalTaskGenerator`. It parses
   `input.message` with zod (the data is in `.data`) and keys its choices by `input.seed`.
2. Add one line under your anchor in `LOCAL_TASKS`:
   - `// ---- lead-gen F3 conversation_reply ----`
   - `// ---- lead-gen F4 template_copy ----`
   - `// ---- lead-gen F5 handoff_summary ----`

For UI, show provenance with `<AiProvenance generatorLabel=... />`. Use `<AiActionButton />` for
"Generate with AI": pass `local` when the local generator runs, and a `gate` for a missing AI
integration in LIVE.

## Shared-file insertions, jobs, limits, labels, manifest, fixtures

- Shared files: the three `LOCAL_TASKS` anchors were created in
  `src/server/adapters/ai/local-deterministic.ts`, which B2 owns. No other shared files were
  edited.
- Job types, rate-limit names, activity labels, route manifest entries and fixture keys: none.

## Tests

- `tests/unit/ai/run-task.test.ts` (17): repair loop, retry and final-attempt rules, task check,
  custom evaluator.
- `tests/unit/ai/local-dispatch.test.ts` (11): golden byte-identity, the `local/draft.ts` direct
  call, `LOCAL_TASKS` contents and anchors, dispatch errors.
- `tests/integration/ai/run-task.test.ts` (14): `selectWorkspaceAi` in LIVE and DEMO (preference
  order, revoked integrations, missing key ring, decrypt failure, tenant scoping, forceLocal,
  MODE_MISMATCH), and `runStructuredTask` end to end through the Anthropic adapter (MockAgent).
- `tests/components/ai/ai-provenance.test.tsx` (13) and `ai-action-button.test.tsx` (6).

## Open questions for the integrator

- **AI task names.** B3 defines them in `src/lib/domain/lead-gen.ts`. On this branch the `task`
  argument is a plain `string`, and `LOCAL_TASKS` is `Record<string, ...>`, so nothing depends on
  B3. After the merge you could either type `task` against B3's constant, or change the
  hard-coded list in the "only names known AI tasks" test (`local-dispatch.test.ts`) to that
  constant.
- **Duplicate defaults.** `defaultAiDeps()` (run-task) duplicates `defaultDraftDeps()` (deps.ts).
  The second was kept so that existing importers do not change.

## Deferred

Nothing in B2's scope was deferred.

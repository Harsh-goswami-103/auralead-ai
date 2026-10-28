# Lead-gen suite: worktree protocol

How the lead-gen slices are built in parallel without stepping on each other. This expands §6
(shared files) and §7 (worktree protocol and slice gate) of
[`lead-gen-suite-plan.md`](lead-gen-suite-plan.md); the plan and ADR-117 .. ADR-126 in
[`../decisions.md`](../decisions.md) stay the spec.

## 1. Layout

| What | Where |
|---|---|
| Integration checkout | `C:\Users\Asus\OneDrive\Documents\projects\mini project\.claude\worktrees\pensive-jackson-e99711`, branch `claude/lead-gen-suite`. Only the integrator works here. |
| Slice worktree | `C:\Users\Asus\auralead-wt\<name>` (outside OneDrive, no space in the path), branch `lg/<name>`: `b1`, `b2`, `b3` for Foundation-B, `f1` .. `f6` for the slices. |
| `node_modules` | A directory junction to the integration checkout's `node_modules`. Shared by every worktree. |
| `.env` | Copied from the integration checkout, with `AURALEAD_DATA_DIR=C:/Users/Asus/auralead-wt/_data/<name>`, so each worktree has its own SQLite files, storage, backups and journal. |
| Prisma client | `src/generated/prisma` (git-ignored) inside each worktree; never shared. |

A worktree is created from the integration checkout with `git worktree add -b lg/<name>
C:\Users\Asus\auralead-wt\<name> <base>`, then the junction, the `.env` and a client generate.
It is removed junction first (so the shared `node_modules` is untouched), then `git worktree
remove`; the `lg/<name>` branch is kept for the merge.

## 2. Rules inside a worktree

- Work only in your own worktree. Never edit the integration checkout or another worktree.
- Quote every path. Start each shell command with `cd "C:/Users/Asus/auralead-wt/<name>" && ...`.
- **Never** run `npm install`, `npm ci` or `npm update`: `node_modules` is the integration
  checkout's. A package the slice needs is a request in your handoff note.
- After creating, branching, merging or checking out: `node node_modules/prisma/build/index.js generate`.
- Never edit `prisma/schema.prisma`, `prisma/migrations/**`, `package.json` or `package-lock.json`.
  A schema change is a request in your handoff note.
- No dev servers (`npm run dev`, `start`, `worker`) in a slice. At most three slices run tests at
  the same time.
- Commit on `lg/<name>` with a conventional message and no `Co-Authored-By` or other Claude
  attribution (the owner's standing rule). Do not push.

## 3. Owned paths and shared files

A slice edits only the paths its plan section (§4 or §5) names, plus their tests. Everything else is
described in the slice's handoff note for the integrator.

The shared files below carry **anchor blocks**: one per slice, in every anchor area, in the order
F1 .. F6. Append only between your own two lines:

```ts
// ---- lead-gen F1 finder ----
  (your lines here: replace the blank line or add below it)
// ---- end F1 ----
```

The exact spellings (from `leadGenAnchor` in `src/lib/domain/lead-gen.ts`):

| Slice | Begin line | End line | Manifest owner |
|---|---|---|---|
| F1 Lead Finder | `// ---- lead-gen F1 finder ----` | `// ---- end F1 ----` | T40 |
| F2 Import/Export | `// ---- lead-gen F2 import ----` | `// ---- end F2 ----` | T41 |
| F3 Chat + AI replies | `// ---- lead-gen F3 chat ----` | `// ---- end F3 ----` | T42 |
| F4 Template studio | `// ---- lead-gen F4 templates ----` | `// ---- end F4 ----` | T43 |
| F5 Handoff + reach-out | `// ---- lead-gen F5 handoff ----` | `// ---- end F5 ----` | T44 |
| F6 Presentation | `// ---- lead-gen F6 presentation ----` | `// ---- end F6 ----` | T45 |

Anchor areas (each holds all six blocks):

| File | Areas |
|---|---|
| `src/server/routes.manifest.ts` | end of `ROUTES` |
| `src/server/jobs/registry.ts` | handler imports; end of `JOB_DEFINITIONS` |
| `src/components/metrics/activity-vocabulary.ts` | end of `ACTIVITY_LABELS` |
| `src/server/adapters/registry.ts` | adapter imports; resolvers at the end of the file |
| `src/components/integrations/sections.ts` | icon imports; end of `WORKSPACE_SECTIONS` |
| `tests/support/routes.ts` | end of `MATRIX_FIXTURES` |
| `tests/unit/arch/registry-live.test.ts` | imports; `DEMO_MODULES`; `LIVE_MODULES`; `LIVE_FUNCTIONS`; runtime cases at the end of the file |

Plus `src/server/adapters/ai/local-deterministic.ts` `LOCAL_TASKS` (one line per AI slice, anchors
added by Foundation-B2).

How to use them:

- **Routes manifest.** Every new `page.tsx` or `route.ts` gets a `RouteEntry` inside your block with
  your owner (table above) and expectations for all five matrix actors. Widening an existing entry
  (F3's T22 inbox routes) edits that entry in place and keeps its owner.
- **Fixture keys.** Matrix fixtures are well-formed unknown-id probes (for example
  `'finder.unknownRunId': 'finderrunmatrixprobe00000'`), never seeded rows, added inside your block
  of `MATRIX_FIXTURES`.
- **Jobs.** Import the handler inside your import block and list it inside your `JOB_DEFINITIONS`
  block. Use the names in `LEAD_GEN_JOB_TYPES` (`src/lib/domain/lead-gen.ts`).
- **Imports from a module another block also imports** (for example `lucide-react` icons) go on
  their own import line inside your block; ESLint accepts the repeated module.
- **Adapters.** A LIVE resolver branch is a `live*` function that never references a demo module;
  list it in `LIVE_FUNCTIONS` and its module in `LIVE_MODULES` (demo modules in `DEMO_MODULES`), and
  cover every integration status x credential state at the end of `registry-live.test.ts`.
- **Workspace sections.** Add your section in the same change as its page (the nav-target test
  needs the page). The integrator may reorder the list for the story (Lead finder first).
- `tests/unit/arch/lead-gen-anchors.test.ts` fails when a block is missing, misspelled, out of
  order or not closed, when a manifest entry inside a block has another slice's owner, and when an
  entry with a lead-gen owner (T40 .. T45) sits outside its block.

## 4. Slice gate

Run before every commit, nothing heavier:

```sh
npm run typecheck
npx eslint <your paths> <shared files you edited>
npx vitest run --maxWorkers=2 tests/unit/arch tests/unit/lib/domain-enums.test.ts tests/unit/integrations tests/unit/docs tests/integration/authz/tenant-matrix.test.ts <your test files or dirs>
```

No full `npm run test` in a slice. `tests/unit/arch/lint-rules.test.ts` can time out under load:
re-run it alone before calling it a failure.

## 5. Handoff note

Each worktree commits `docs/handoff/lead-gen-<name>.md`: what was built, every shared-file
insertion, job types, rate-limit policy names, activity labels, manifest entries, fixture keys, open
questions and anything deferred.

## 6. Merge order

Foundation-B merges `lg/b1`, `lg/b2`, `lg/b3` into the integration checkout (`git merge --no-ff`),
then the integrator runs the full suite once alone as the baseline (recorded in
`docs/progress.md`). The slices branch from that result and merge in the order F5, F2, F1, F4, F3,
F6; after each merge: generate, typecheck, lint, the arch and matrix tests and the merged slices'
tests. The integrator then writes the cross-slice tests, wires the lead-page components, runs the
full suite alone and walks the DEMO story on a fresh data directory (plan §8).

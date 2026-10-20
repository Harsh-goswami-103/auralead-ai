'use client';

/**
 * The pipeline editor (T28; PRD "React Flow pipeline (small validated stage set; persisted; rejects
 * cycles/unsupported; executed)"; 06-design F13 and §11.3 "Pipeline editor").
 *
 * - At 768 px and up: the React Flow canvas (loaded on demand) beside a keyboard panel that does
 *   everything the canvas does: pick a stage, add or remove an optional stage (the chain is
 *   reconnected around it), connect or disconnect stages, and choose the approval mode.
 * - Below 768 px, or without `pipeline.manage`: the read-only list of stages in run order with the
 *   "edit on a larger screen" note.
 * - Every change is checked by the server's validator (dry run, nothing written); its issues are
 *   drawn on the offending connection or stage and listed in the validation panel. A stage to
 *   itself or a repeated connection is refused before it is drawn.
 * - Save creates version N+1 through the same validator with a check on the version this editor
 *   started from ("Saved v2, active"); a stale editor is told to reload, an invalid graph shows the
 *   issues, and leads already running keep the version they started with (O5).
 */
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CircleAlert, CircleCheck, Link2, Loader2, Minus, Plus, Save, Unlink } from 'lucide-react';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GateReason, GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { NativeSelect } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import type { PipelineApprovalMode, PipelineStage } from '@/lib/domain/enums';
import { postPipeline, issuesOf } from './api';
import { PipelineListView, type StageReadiness } from './PipelineListView';
import {
  addStage,
  APPROVAL_MODE_LABELS,
  connect,
  disconnect,
  draftKey,
  edgeIssues,
  edgeKey,
  issueText,
  labelOf,
  loopEdges,
  orderedStages,
  removeStage,
  sameGraph,
  stageAfterRemoval,
  STAGE_INFO,
  STAGE_ORDER,
  toPayloadGraph,
  type EditorEdge,
  type EditorGraph,
  type EditorIssue,
} from './pipeline-model';

const PipelineCanvas = dynamic(() => import('./PipelineCanvas').then((m) => m.PipelineCanvas), {
  ssr: false,
  loading: () => <Skeleton className="h-80 w-full rounded-lg" />,
});

const WIDE_QUERY = '(min-width: 768px)';

function subscribeWide(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** True at 768 px and up; false on the server and where matchMedia is missing (the list view). */
function useWideScreen(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => typeof window.matchMedia === 'function' && window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
}

/** A server verdict, tied to the draft it was computed for (`draftKey`, ADR-84). */
type Verdict = { key: string; state: 'done'; ok: boolean; issues: EditorIssue[] } | { key: string; state: 'error'; message: string };

/** What the validation panel says: the saved version, "checking" for a draft without its own verdict, or that verdict. */
type Shown = { state: 'saved' } | { state: 'checking' } | Verdict;

type SaveState = { kind: 'saved'; version: number } | { kind: 'error'; message: string; reference: string | null } | null;

export type PipelineEditorProps = {
  workspaceSlug: string;
  canEdit: boolean;
  autoSendEnabled: boolean;
  /** The active version the editor starts from (0 when the workspace has none). */
  baseVersion: number;
  initialGraph: EditorGraph;
  initialApprovalMode: PipelineApprovalMode;
  readiness: Partial<Record<PipelineStage, StageReadiness | null>>;
};

export function PipelineEditor(props: PipelineEditorProps) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const wide = useWideScreen();
  const ids = { from: useId(), to: useId(), stage: useId(), policy: useId(), status: useId(), saveNote: useId() };

  const [base, setBase] = useState({ version: props.baseVersion, graph: props.initialGraph, approvalMode: props.initialApprovalMode });
  const [graph, setGraph] = useState<EditorGraph>(props.initialGraph);
  const [approvalMode, setApprovalMode] = useState<PipelineApprovalMode>(props.initialApprovalMode);
  const [selectedId, setSelectedId] = useState<string | null>(props.initialGraph.stages[0]?.id ?? null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>(null);
  const [saving, setSaving] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const requestNo = useRef(0);
  const savingRef = useRef(false);

  const dirty = !sameGraph(graph, base.graph) || approvalMode !== base.approvalMode;
  const currentKey = useMemo(() => draftKey(graph, approvalMode), [graph, approvalMode]);
  const hasVerdict = verdict !== null && verdict.key === currentKey;
  // An unchanged pipeline is the saved one, which the server validated when it was saved. Any other
  // draft shows a verdict only if it was computed for exactly this draft; until then it is checking,
  // from the moment of the edit (no stale "Valid", no "not valid" during the debounce).
  const shown: Shown = useMemo(() => (!dirty ? { state: 'saved' } : hasVerdict ? verdict! : { state: 'checking' }), [dirty, hasVerdict, verdict]);
  const issues = useMemo(() => (shown.state === 'done' ? shown.issues : []), [shown]);
  const loops = useMemo(() => loopEdges(graph), [graph]);
  const saveReady = shown.state === 'done' && shown.ok;

  const validate = useCallback(
    async (g: EditorGraph, mode: PipelineApprovalMode, key: string) => {
      const no = ++requestNo.current;
      const res = await postPipeline<{ ok: boolean; issues: unknown }>('/api/app/pipeline/validate', { workspaceSlug: props.workspaceSlug, graph: toPayloadGraph(g), approvalMode: mode }, csrf);
      if (no !== requestNo.current) return;
      if (!res.ok) setVerdict({ key, state: 'error', message: res.message });
      else setVerdict({ key, state: 'done', ok: res.data.ok, issues: issuesOf({ issues: res.data.issues }) });
    },
    [csrf, props.workspaceSlug],
  );

  // Every draft without its own verdict is checked by the server (debounced); a newer request
  // supersedes an answer still in flight.
  useEffect(() => {
    if (!props.canEdit || !dirty || hasVerdict) return;
    const id = window.setTimeout(() => void validate(graph, approvalMode, currentKey), 250);
    return () => window.clearTimeout(id);
  }, [graph, approvalMode, currentKey, dirty, hasVerdict, props.canEdit, validate]);

  /**
   * Applies an edit. The stage picker always stays on a stage that exists (`select` when given,
   * else the current one, else the first), and From/To are cleared when they named a stage that is
   * gone (ADR-84).
   */
  function change(next: EditorGraph, select?: string | null) {
    setRefusal(null);
    setSaveState(null);
    setGraph(next);
    const present = new Set(next.stages.map((s) => s.id));
    const keep = select ?? selectedId;
    setSelectedId(keep !== null && present.has(keep) ? keep : (orderedStages(next)[0]?.id ?? null));
    if (from !== '' && !present.has(from)) setFrom('');
    if (to !== '' && !present.has(to)) setTo('');
  }

  function chooseMode(mode: PipelineApprovalMode) {
    setRefusal(null);
    setSaveState(null);
    setApprovalMode(mode);
  }

  function tryConnect(a: string, b: string) {
    const result = connect(graph, a, b);
    if (!result.ok) {
      setRefusal(result.reason);
      return;
    }
    change(result.graph);
  }

  async function save() {
    // Save waits for the server's verdict on exactly this draft (the server re-validates anyway).
    if (!saveReady || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveState(null);
    const key = currentKey;
    const res = await postPipeline<{ version: number }>('/api/app/pipeline/versions', { workspaceSlug: props.workspaceSlug, graph: toPayloadGraph(graph), approvalMode, expectedVersion: base.version }, csrf);
    savingRef.current = false;
    setSaving(false);
    if (!res.ok) {
      if (res.issues.length > 0) setVerdict({ key, state: 'done', ok: false, issues: res.issues });
      setSaveState({ kind: 'error', message: res.message, reference: res.reference });
      return;
    }
    setBase({ version: res.data.version, graph, approvalMode });
    setSaveState({ kind: 'saved', version: res.data.version });
    router.refresh();
  }

  const selected = graph.stages.find((s) => s.id === selectedId) ?? null;
  const ordered = orderedStages(graph);
  const policyGate: Gate | null = props.autoSendEnabled
    ? null
    : { category: 'configuration', reason: 'Policy approval needs workspace auto-send to be on. Until then a person approves every first message.' };

  const listView = (
    <PipelineListView
      graph={graph}
      approvalMode={approvalMode}
      readiness={props.readiness}
      note={props.canEdit ? 'Viewing only: the pipeline can be edited on a screen at least 768 px wide.' : 'Viewing only: your assignment here does not include “Manage the pipeline”.'}
    />
  );

  if (!props.canEdit) return listView;

  return (
    <div className="flex flex-col gap-4">
      <div className="md:hidden">{listView}</div>
      <div data-pipeline-editor className="hidden flex-col gap-4 md:flex">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-2">
            {wide ? (
              <PipelineCanvas
                graph={graph}
                issues={issues}
                readiness={props.readiness}
                selectedId={selectedId}
                editable
                onConnect={tryConnect}
                onDisconnect={(e) => change(disconnect(graph, e))}
                onSelect={setSelectedId}
              />
            ) : (
              <Skeleton className="h-80 w-full rounded-lg" />
            )}
            <p className="text-xs text-fg-2">Drag from a stage’s right handle to another stage to connect them; select a connection and press Delete to remove it. The panel does the same with the keyboard.</p>
          </div>

          <aside aria-label="Edit the pipeline with the keyboard" className="flex min-w-0 flex-col gap-4 rounded-xl border border-border-subtle bg-bg-1/80 p-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.stage} className="text-xs font-medium text-fg-2">
                Stage
              </label>
              <NativeSelect id={ids.stage} value={selectedId ?? ''} onChange={(e) => setSelectedId(e.target.value)}>
                {ordered.map((s) => (
                  <option key={s.id} value={s.id}>
                    {STAGE_INFO[s.kind].label}
                  </option>
                ))}
              </NativeSelect>
              {selected ? <p className="text-xs text-fg-2">{STAGE_INFO[selected.kind].description}</p> : null}
              {selected && !STAGE_INFO[selected.kind].required ? (
                <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => change(removeStage(graph, selected.id), stageAfterRemoval(graph, selected.id))}>
                  <Minus aria-hidden="true" />
                  Remove {STAGE_INFO[selected.kind].label}
                </Button>
              ) : selected ? (
                <p className="text-xs text-fg-2">{STAGE_INFO[selected.kind].label} is required in every pipeline.</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {STAGE_ORDER.filter((k) => !graph.stages.some((s) => s.kind === k)).map((k) => (
                  <Button
                    key={k}
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const next = addStage(graph, k);
                      change(next, next.stages.find((s) => s.kind === k)?.id ?? null);
                    }}
                  >
                    <Plus aria-hidden="true" />
                    Add {STAGE_INFO[k].label}
                  </Button>
                ))}
              </div>
            </div>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-xs font-medium text-fg-2">Connections</legend>
              <ul className="flex flex-col gap-1.5">
                {graph.edges.map((e: EditorEdge) => {
                  const problems = edgeIssues(graph, issues, e, loops);
                  const name = `${labelOf(graph, e.from)} to ${labelOf(graph, e.to)}`;
                  return (
                    <li key={edgeKey(e)} data-edge={edgeKey(e)} data-edge-error={problems.length > 0 ? 'true' : undefined} className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-bg-2/50 px-2.5 py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm text-fg-1">
                          {labelOf(graph, e.from)} → {labelOf(graph, e.to)}
                        </span>
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove connection ${name}`} onClick={() => change(disconnect(graph, e))}>
                          <Unlink aria-hidden="true" />
                        </Button>
                      </div>
                      {problems.map((p) => (
                        <span key={p} className="flex items-start gap-1 text-xs text-danger">
                          <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                          {p}
                        </span>
                      ))}
                    </li>
                  );
                })}
              </ul>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <label htmlFor={ids.from} className="text-xs text-fg-2">
                    From
                  </label>
                  <NativeSelect id={ids.from} value={from} onChange={(e) => setFrom(e.target.value)}>
                    <option value="">Choose</option>
                    {ordered.map((s) => (
                      <option key={s.id} value={s.id}>
                        {STAGE_INFO[s.kind].label}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor={ids.to} className="text-xs text-fg-2">
                    To
                  </label>
                  <NativeSelect id={ids.to} value={to} onChange={(e) => setTo(e.target.value)}>
                    <option value="">Choose</option>
                    {ordered.map((s) => (
                      <option key={s.id} value={s.id}>
                        {STAGE_INFO[s.kind].label}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="w-fit"
                onClick={() => {
                  if (!from || !to) {
                    setRefusal('Choose the stage the connection starts from and the stage it leads to.');
                    return;
                  }
                  tryConnect(from, to);
                }}
              >
                <Link2 aria-hidden="true" />
                Add connection
              </Button>
              {refusal ? (
                <p role="alert" className="text-xs text-danger">
                  {refusal}
                </p>
              ) : null}
            </fieldset>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-xs font-medium text-fg-2">Approval</legend>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant={approvalMode === 'HUMAN' ? 'secondary' : 'ghost'} size="sm" aria-pressed={approvalMode === 'HUMAN'} onClick={() => chooseMode('HUMAN')}>
                  {APPROVAL_MODE_LABELS.HUMAN}
                </Button>
                {policyGate ? (
                  <GatedAction label={APPROVAL_MODE_LABELS.POLICY_AUTO} gate={policyGate} reasonId={ids.policy} size="sm" />
                ) : (
                  <Button type="button" variant={approvalMode === 'POLICY_AUTO' ? 'secondary' : 'ghost'} size="sm" aria-pressed={approvalMode === 'POLICY_AUTO'} onClick={() => chooseMode('POLICY_AUTO')}>
                    {APPROVAL_MODE_LABELS.POLICY_AUTO}
                  </Button>
                )}
              </div>
              {policyGate ? <GateReason id={ids.policy} gate={policyGate} /> : null}
            </fieldset>
          </aside>
        </div>

        <section aria-labelledby={`${ids.stage}-validation`} className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-bg-1/80 p-4">
          <h3 id={`${ids.stage}-validation`} className="font-display text-md font-semibold text-fg-1">
            Validation
          </h3>
          <div id={ids.status} role="status" aria-live="polite" data-validation={shown.state === 'done' ? (shown.ok ? 'valid' : 'invalid') : shown.state} className="flex flex-col gap-1.5 text-sm">
            {shown.state === 'checking' ? (
              <span className="flex items-center gap-2 text-fg-2">
                <Loader2 aria-hidden="true" className="size-4 motion-safe:animate-spin" />
                Checking the pipeline...
              </span>
            ) : shown.state === 'error' ? (
              <span className="flex flex-wrap items-center gap-2 text-danger">
                <CircleAlert aria-hidden="true" className="size-4" />
                {shown.message}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setVerdict(null);
                    void validate(graph, approvalMode, currentKey);
                  }}
                >
                  Check again
                </Button>
              </span>
            ) : shown.state === 'saved' ? (
              <span className="flex items-center gap-2 text-fg-1">
                <CircleCheck aria-hidden="true" className="size-4 text-success" />
                {`Valid. This is the active version${base.version > 0 ? ` (v${base.version})` : ''}.`}
              </span>
            ) : shown.ok ? (
              <span className="flex items-center gap-2 text-fg-1">
                <CircleCheck aria-hidden="true" className="size-4 text-success" />
                Valid. Save to make it the active version.
              </span>
            ) : (
              <ul className="flex flex-col gap-1">
                {issues.map((i, n) => (
                  <li key={`${i.code}-${n}`} className="flex items-start gap-2 text-fg-1">
                    <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
                    <span>
                      {issueText(graph, i)}
                      {i.edge ? <span className="text-fg-2"> ({labelOf(graph, i.edge.from)} to {labelOf(graph, i.edge.to)})</span> : null}
                    </span>
                  </li>
                ))}
                {issues.length === 0 ? <li className="text-fg-2">The pipeline is not valid.</li> : null}
              </ul>
            )}
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          {dirty ? (
            <>
              <Button
                type="button"
                onClick={() => void save()}
                aria-busy={saving || undefined}
                aria-disabled={!saveReady || undefined}
                aria-describedby={saveReady ? undefined : `${ids.status} ${ids.saveNote}`}
                className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:hover:brightness-100"
              >
                <Save aria-hidden="true" />
                {saving ? 'Saving...' : 'Save as new version'}
              </Button>
              {saveReady ? null : (
                <span id={ids.saveNote} className="text-xs text-fg-2">
                  {shown.state === 'checking' ? 'Save is available once the check above finishes.' : 'Save is available once the check above passes.'}
                </span>
              )}
            </>
          ) : saveState === null ? (
            <span className="text-sm text-fg-2">No unsaved changes.</span>
          ) : null}
          {saveState?.kind === 'saved' ? (
            <p role="status" data-saved-version={saveState.version} className="flex items-center gap-2 text-sm font-medium text-fg-1">
              <CircleCheck aria-hidden="true" className="size-4 text-success" />
              Saved v{saveState.version}, active. Leads already running keep the version they started with.
            </p>
          ) : null}
          {saveState?.kind === 'error' ? (
            <p role="alert" className={cn('flex items-center gap-2 text-sm text-danger')}>
              <CircleAlert aria-hidden="true" className="size-4" />
              {saveState.message}
              {saveState.reference ? <span className="text-xs text-fg-2">Reference {saveState.reference}</span> : null}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

'use client';

/**
 * The scoring configuration editor of the operator console (T26, P9, R14). The operator edits the
 * seven weights (whole points that must add up to 100), the target categories, the website
 * preference, the review target and a note; "Preview on 20 leads" scores the 20 newest leads with
 * the draft next to their current scores (nothing is saved); "Activate as version N" saves it as
 * the new active version after a confirmation, and the worker rescores every lead. The server
 * validates with the same Zod schema and answers with the issues; a version activated by someone
 * else meanwhile answers 409 and the page reloads. An earlier version can be loaded into the form
 * and activated again as a new version (stored versions are never edited).
 */
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { CircleAlert, CircleCheck, Eye, Rocket, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { postAction } from '@/components/inbox/api';
import { ConfirmDialog, type ConfirmOutcome } from '@/components/patterns/ConfirmDialog';
import { useCsrfToken } from '@/components/patterns/csrf';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/components/ui/cn';
import type { ScoringActivateDto, ScoringPreviewDto } from '@/lib/schemas/leads';
import { DEFAULT_REVIEW_COUNT_TARGET, SCORE_INPUTS, type ScoreInputName, type ScoringConfig } from '@/lib/schemas/scoring';
import { ToneChip } from './ToneChip';
import type { ScoringVersionDto } from './ScoringConfigView';
import { SCORE_INPUT_LABELS, WEBSITE_PREFERENCE_LABELS } from './scoring-vocabulary';

type Draft = {
  weights: Record<ScoreInputName, string>;
  targetCategories: string;
  websitePreference: 'PRESENT' | 'ABSENT';
  reviewCountTarget: string;
  notes: string;
};

function draftOf(config: ScoringConfig | null): Draft {
  return {
    weights: Object.fromEntries(SCORE_INPUTS.map((k) => [k, String(config?.weights[k] ?? 0)])) as Record<ScoreInputName, string>,
    targetCategories: (config?.targetCategories ?? []).join('\n'),
    websitePreference: config?.websitePreference ?? 'PRESENT',
    reviewCountTarget: String(config?.reviewCountTarget ?? DEFAULT_REVIEW_COUNT_TARGET),
    notes: config?.notes ?? '',
  };
}

/** The draft as the config the server validates (numbers as typed: the schema rejects fractions). */
export function configOf(draft: Draft): unknown {
  const categories = draft.targetCategories
    .split(/[\n,]/)
    .map((c) => c.trim())
    .filter(Boolean);
  return {
    schemaVersion: 1,
    weights: Object.fromEntries(SCORE_INPUTS.map((k) => [k, draft.weights[k].trim() === '' ? Number.NaN : Number(draft.weights[k])])),
    ...(categories.length > 0 ? { targetCategories: categories } : {}),
    websitePreference: draft.websitePreference,
    reviewCountTarget: Number(draft.reviewCountTarget),
    ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
  };
}

type Issues = Array<{ path: string; message: string }>;

export function ScoringEditor(props: { workspaceSlug: string; workspaceName: string; active: ScoringVersionDto | null; history: ScoringVersionDto[] }) {
  const router = useRouter();
  const csrfToken = useCsrfToken();
  const baseId = useId();
  const activeVersion = props.active?.version ?? 0;
  const nextVersion = Math.max(0, ...props.history.map((v) => v.version)) + 1;
  const [draft, setDraft] = useState<Draft>(() => draftOf(props.active?.config ?? null));
  const [preview, setPreview] = useState<ScoringPreviewDto | null>(null);
  const [issues, setIssues] = useState<Issues>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const numbers = SCORE_INPUTS.map((k) => Number(draft.weights[k]));
  const sum = numbers.reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0);
  const wholeNumbers = numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 100);
  const ready = sum === 100 && wholeNumbers;

  function setWeight(k: ScoreInputName, value: string) {
    setDraft((d) => ({ ...d, weights: { ...d.weights, [k]: value } }));
    setPreview(null);
  }

  function readIssues(details: unknown): Issues {
    const list = (details as { issues?: unknown } | null)?.issues;
    return Array.isArray(list) ? list.filter((i): i is { path: string; message: string } => typeof i?.path === 'string' && typeof i?.message === 'string') : [];
  }

  async function runPreview() {
    setPreviewing(true);
    setFailure(null);
    setIssues([]);
    const res = await postAction<{ preview: ScoringPreviewDto }>('/api/app/scoring/preview', { workspaceSlug: props.workspaceSlug, config: configOf(draft) }, csrfToken);
    setPreviewing(false);
    if (res.ok) {
      setPreview(res.data.preview);
      return;
    }
    setFailure(res.message);
    setIssues(readIssues(res.details));
  }

  async function activate(): Promise<ConfirmOutcome> {
    if (!ready) return { ok: false, message: 'The weights must be whole numbers that add up to 100 before you activate them.' };
    setIssues([]);
    const res = await postAction<{ activated: ScoringActivateDto }>(
      '/api/app/scoring/versions',
      { workspaceSlug: props.workspaceSlug, expectedActiveVersion: activeVersion, config: configOf(draft) },
      csrfToken,
    );
    if (res.ok) {
      toast.success(`Scoring version ${res.data.activated.version} is active.`, { description: 'The worker is rescoring every lead of this workspace.' });
      setPreview(null);
      router.refresh();
      return { ok: true };
    }
    if (res.status === 409) router.refresh();
    setIssues(readIssues(res.details));
    return { ok: false, message: res.message, reference: res.reference };
  }

  const fieldId = (k: string) => `${baseId}-${k}`;

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-medium text-fg-1">Weights (points out of 100)</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {SCORE_INPUTS.map((k) => (
            <div key={k} className="flex flex-col gap-1">
              <label htmlFor={fieldId(k)} className="text-sm text-fg-1">
                {SCORE_INPUT_LABELS[k].label}
              </label>
              <Input id={fieldId(k)} name={k} type="number" inputMode="numeric" min={0} max={100} step={1} value={draft.weights[k]} onChange={(e) => setWeight(k, e.target.value)} className="w-28" aria-describedby={`${fieldId(k)}-help`} />
              <span id={`${fieldId(k)}-help`} className="text-xs text-fg-2">
                {SCORE_INPUT_LABELS[k].help}
              </span>
            </div>
          ))}
        </div>
        <p role="status" aria-live="polite" data-weight-sum={sum}>
          {ready ? (
            <ToneChip tone="success" icon={CircleCheck} label="The weights add up to 100" />
          ) : (
            <ToneChip tone="warning" icon={CircleAlert} label={wholeNumbers ? `The weights add up to ${sum}; they must add up to 100` : 'Use whole numbers from 0 to 100'} />
          )}
        </p>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label htmlFor={fieldId('targets')} className="text-sm text-fg-1">
            Target categories
          </label>
          <Textarea
            id={fieldId('targets')}
            value={draft.targetCategories}
            onChange={(e) => {
              setDraft((d) => ({ ...d, targetCategories: e.target.value }));
              setPreview(null);
            }}
            placeholder={'One per line, for example:\nDental clinic\nOrthodontist'}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId('website')} className="text-sm text-fg-1">
            Website
          </label>
          <NativeSelect
            id={fieldId('website')}
            value={draft.websitePreference}
            onChange={(e) => {
              setDraft((d) => ({ ...d, websitePreference: e.target.value === 'ABSENT' ? 'ABSENT' : 'PRESENT' }));
              setPreview(null);
            }}
          >
            <option value="PRESENT">{WEBSITE_PREFERENCE_LABELS.PRESENT}</option>
            <option value="ABSENT">{WEBSITE_PREFERENCE_LABELS.ABSENT}</option>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId('reviews')} className="text-sm text-fg-1">
            Reviews for full points
          </label>
          <Input
            id={fieldId('reviews')}
            type="number"
            inputMode="numeric"
            min={1}
            max={100000}
            step={1}
            value={draft.reviewCountTarget}
            onChange={(e) => {
              setDraft((d) => ({ ...d, reviewCountTarget: e.target.value }));
              setPreview(null);
            }}
            className="w-32"
          />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label htmlFor={fieldId('notes')} className="text-sm text-fg-1">
            Note for this version
          </label>
          <Textarea id={fieldId('notes')} maxLength={500} value={draft.notes} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} />
        </div>
      </div>

      {failure || issues.length > 0 ? (
        <div role="alert" className="flex flex-col gap-1 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-fg-1">
          {failure ? <p>{failure}</p> : null}
          {issues.length > 0 ? (
            <ul className="list-disc pl-5 text-fg-2">
              {issues.map((i) => (
                <li key={`${i.path}:${i.message}`}>
                  {i.path ? `${i.path}: ` : ''}
                  {i.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" aria-busy={previewing || undefined} onClick={() => void runPreview()}>
          <Eye aria-hidden="true" />
          {previewing ? 'Scoring the sample...' : 'Preview on 20 leads'}
        </Button>
        <ConfirmDialog
          trigger={
            <Button type="button">
              <Rocket aria-hidden="true" />
              Activate as version {nextVersion}
            </Button>
          }
          title={`Activate scoring version ${nextVersion}?`}
          description={`Version ${nextVersion} becomes the only active scoring configuration${activeVersion ? ` (replacing version ${activeVersion})` : ''}, and the worker rescores every lead of the workspace with it. Earlier versions stay in the history.`}
          confirmLabel={`Activate version ${nextVersion}`}
          pendingLabel="Activating..."
          workspaceName={props.workspaceName}
          onConfirm={activate}
        />
      </div>

      {preview ? (
        <section aria-label="Preview" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-fg-1">Preview on the {preview.sampleSize} newest leads</h3>
          <p className="text-sm text-fg-2">
            {preview.changed} of {preview.sampleSize} would change.
            {preview.averageCurrent !== null && preview.averageProposed !== null ? ` Average score ${preview.averageCurrent} now, ${preview.averageProposed} with this draft.` : ''} Nothing is saved until you activate.
          </p>
          {preview.rows.length === 0 ? (
            <p className="text-sm text-fg-2">This workspace has no leads to preview yet.</p>
          ) : (
            <div className="relative overflow-x-auto rounded-lg border border-border-subtle">
              <table className="w-full min-w-[30rem] text-left text-sm">
                <caption className="sr-only">Current and proposed scores of the sample leads</caption>
                <thead className="bg-bg-2/60 text-xs text-fg-2">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">Lead</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Now</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">With this draft</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Change</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {preview.rows.map((r) => (
                    <tr key={r.leadId} data-preview-lead={r.leadId}>
                      <td className="px-3 py-2 text-fg-1">{r.displayName}</td>
                      <td className="tabular px-3 py-2 text-right text-fg-2">{r.currentScore === null ? 'Not scored' : r.currentScore}</td>
                      <td className="tabular px-3 py-2 text-right text-fg-1">{r.proposedScore}</td>
                      <td className={cn('tabular px-3 py-2 text-right', r.delta === null || r.delta === 0 ? 'text-fg-2' : 'text-fg-1')}>
                        {r.delta === null ? 'New' : r.delta > 0 ? `+${r.delta}` : String(r.delta)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {props.history.length > 1 ? (
        <section aria-label="Load an earlier version" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-fg-1">Start from an earlier version</h3>
          <ul className="flex flex-wrap gap-2">
            {props.history
              .filter((v) => !v.active && v.config !== null)
              .map((v) => (
                <li key={v.id}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDraft(draftOf(v.config));
                      setPreview(null);
                      setIssues([]);
                    }}
                  >
                    <RotateCcw aria-hidden="true" />
                    Load version {v.version}
                  </Button>
                </li>
              ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

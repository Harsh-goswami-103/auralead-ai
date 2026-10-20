/**
 * The scoring configuration, read-only (T26, P9): what the active version weighs and how, and the
 * version history. The workspace owner sees this (P9: owner read-only), and so does an operator
 * without scoring.manage. Weights are points out of 100; each bar is the weight's share. Server-safe.
 */
import { CircleCheck, History } from 'lucide-react';
import { SCORE_INPUTS, SCORE_CAPTION, DEFAULT_REVIEW_COUNT_TARGET, type ScoringConfig } from '@/lib/schemas/scoring';
import { formatDateTime } from '@/lib/format/date';
import { ToneChip } from './ToneChip';
import { SCORE_INPUT_LABELS, WEBSITE_PREFERENCE_LABELS } from './scoring-vocabulary';

export type ScoringVersionDto = { id: string; version: number; active: boolean; createdAt: string; createdByName: string | null; config: ScoringConfig | null };

export function ScoringWeights({ config }: { config: ScoringConfig }) {
  return (
    <div className="flex flex-col gap-4">
      <ul aria-label="Weights" className="flex flex-col gap-2.5 text-sm">
        {SCORE_INPUTS.map((input) => {
          const weight = config.weights[input];
          return (
            <li key={input} data-weight={input} className="flex flex-col gap-1">
              <span className="flex justify-between gap-3">
                <span className="text-fg-1">{SCORE_INPUT_LABELS[input].label}</span>
                <span className="tabular shrink-0 text-fg-1">{weight} points</span>
              </span>
              <span aria-hidden="true" className="block h-1.5 overflow-hidden rounded-full bg-bg-3">
                <span className="block h-full rounded-full bg-aura" style={{ width: `${weight}%` }} />
              </span>
            </li>
          );
        })}
      </ul>
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-fg-2">Target categories</dt>
          <dd className="text-fg-1">{config.targetCategories && config.targetCategories.length > 0 ? config.targetCategories.join(', ') : 'None (category match stays unknown)'}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-fg-2">Website</dt>
          <dd className="text-fg-1">{WEBSITE_PREFERENCE_LABELS[config.websitePreference ?? 'PRESENT']}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-fg-2">Review target</dt>
          <dd className="tabular text-fg-1">{(config.reviewCountTarget ?? DEFAULT_REVIEW_COUNT_TARGET).toLocaleString('en-IN')} reviews for full points</dd>
        </div>
        {config.notes ? (
          <div className="flex flex-col gap-0.5 sm:col-span-2">
            <dt className="text-xs text-fg-2">Notes</dt>
            <dd className="text-fg-1">{config.notes}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

export function ScoringHistory(props: { history: readonly ScoringVersionDto[]; timeZone: string }) {
  return (
    <ol aria-label="Scoring versions" className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle">
      {props.history.map((v) => (
        <li key={v.id} data-scoring-version={v.version} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-fg-1">Version {v.version}</span>
            {v.active ? <ToneChip tone="success" icon={CircleCheck} label="Active" /> : <ToneChip tone="neutral" icon={History} label="Earlier" />}
            {v.config === null ? <span className="text-xs text-warning">Stored weights do not match the current schema</span> : null}
          </span>
          <span className="text-xs text-fg-2">
            {formatDateTime(new Date(v.createdAt), props.timeZone)}
            {v.createdByName ? ` by ${v.createdByName}` : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ScoringCaption() {
  return <p className="text-xs text-fg-2">{SCORE_CAPTION} Unknown inputs score 0 and are listed on each lead; they never count against it.</p>;
}

/**
 * ScoreBreakdown (plan §3 patterns, 06-design F17, R14; built by T26 as ADR-53 handed over): the
 * stored score explained. The score text "NN / 100" with its fit meter, one row per known input
 * with its points out of its weight (the reasons sum exactly to the score), the inputs that were
 * not known and scored 0, the configuration version it was computed with, and the fixed caption:
 * a heuristic fit score, not purchase intent or consent. Server-safe.
 */
import { CircleHelp } from 'lucide-react';
import { SCORE_CAPTION } from '@/lib/schemas/scoring';
import { ScoreMeter } from './ScoreMeter';

export type ScoreBreakdownProps = {
  score: number | null;
  configVersion: number | null;
  reasons: ReadonlyArray<{ input: string; label: string; points: number; maxPoints: number }>;
  unknownInputs: ReadonlyArray<{ input: string; label: string }>;
};

export function ScoreBreakdown(props: ScoreBreakdownProps) {
  return (
    <div data-score-breakdown="" className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span data-field="score" className="tabular font-display text-xl font-semibold text-fg-1">
          {props.score === null ? 'Not scored' : `${props.score} / 100`}
        </span>
        <ScoreMeter value={props.score} size="md" className="max-w-40" />
      </div>
      {props.reasons.length > 0 ? (
        <ul aria-label="Score reasons" className="flex flex-col gap-2 text-sm">
          {props.reasons.map((r) => (
            <li key={r.input} className="flex flex-col gap-1">
              <span className="flex justify-between gap-2">
                <span className="text-fg-1">{r.label}</span>
                <span className="tabular shrink-0 text-fg-2">
                  {r.points} / {r.maxPoints}
                </span>
              </span>
              <ScoreMeter value={r.maxPoints > 0 ? (r.points / r.maxPoints) * 100 : 0} size="md" className="h-1" animate={false} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-2">No scoring reasons recorded yet.</p>
      )}
      {props.unknownInputs.length > 0 ? (
        <div className="flex flex-col gap-1.5 border-t border-border-subtle pt-3">
          <h4 className="text-xs font-medium text-fg-2">Not known, scored 0</h4>
          <ul aria-label="Unknown inputs" className="flex flex-col gap-1 text-sm text-fg-2">
            {props.unknownInputs.map((u) => (
              <li key={u.input} className="flex items-start gap-2">
                <CircleHelp aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-fg-3" />
                {u.label}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-xs text-fg-2">
        {SCORE_CAPTION}
        {props.configVersion === null ? '' : ` Scoring configuration v${props.configVersion}.`}
      </p>
    </div>
  );
}

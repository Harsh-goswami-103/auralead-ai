/**
 * ScoreMeter (design spec §6 "Scores render as a gradient meter, value text always visible"): the
 * bar beside a score's text, never instead of it. The fill is a fit ramp (volt-hi to aura to zest,
 * no status hues: the score is fit, not good or bad) laid across the whole track, so a 30 and a 90
 * end on different colors. It slides in once from the left on first paint in chart time (450ms,
 * like ScoreRing; CSS, so it also works in server components and never replays on refresh) and
 * rests full under reduced motion. `animate={false}` for table rows (spec: tables get one
 * container fade, no per-row motion).
 * Decorative: aria-hidden, the caller renders the "NN / 100" text. Server-safe.
 */
import type { CSSProperties } from 'react';
import { cn } from '@/components/ui/cn';

/** The fit ramp shared by the meter and the score ring (sRGB stops, no violet on the way). */
export const SCORE_RAMP = ['var(--volt-hi)', 'var(--aura)', 'var(--zest)'] as const;

export function clampScore(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function ScoreMeter(props: { value: number | null; className?: string; size?: 'sm' | 'md'; animate?: boolean }) {
  const pct = clampScore(props.value);
  const fill: CSSProperties = {
    width: `${pct}%`,
    backgroundImage: `linear-gradient(90deg, ${SCORE_RAMP[0]}, ${SCORE_RAMP[1]} 55%, ${SCORE_RAMP[2]})`,
    // The ramp spans the full track, so the fill shows only its own share of it.
    backgroundSize: pct > 0 ? `${(100 / pct) * 100}% 100%` : undefined,
  };
  return (
    <span
      aria-hidden="true"
      data-score-meter=""
      className={cn('relative block shrink-0 overflow-hidden rounded-full bg-bg-3', props.size === 'md' ? 'h-2 w-full' : 'h-1.5 w-14', props.className)}
    >
      {pct > 0 ? (
        <span
          style={fill}
          className={cn(
            'absolute inset-y-0 left-0 rounded-full',
            (props.animate ?? true) && 'ease-emphasized motion-safe:animate-in motion-safe:duration-chart motion-safe:slide-in-from-left',
          )}
        />
      ) : null}
    </span>
  );
}

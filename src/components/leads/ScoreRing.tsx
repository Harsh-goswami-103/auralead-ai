'use client';

/**
 * ScoreRing: the lead detail's score gauge (shots report "score gauge"). A conic ring in the same
 * fit ramp as ScoreMeter (volt-hi at 0, aura in the middle, zest at 100, so a ring and a bar of the
 * same score end on the same color); the share above the score is covered by the track. The cover
 * opens to the score once on mount (motion value, chart timing 450ms, no replay on refresh); the
 * number in the middle is the caller's static text from the first frame (no count-up). Under
 * reduced motion the ring is set at once. Decorative layers are aria-hidden.
 */
import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { animate, motion, useMotionTemplate, useMotionValue, useReducedMotion } from 'motion/react';
import { duration, ease } from '@/components/motion/presets';
import { cn } from '@/components/ui/cn';
import { clampScore, SCORE_RAMP } from './ScoreMeter';

const RING_MASK = 'radial-gradient(farthest-side, transparent calc(100% - 11px), #000 calc(100% - 10.5px))';
const masked: CSSProperties = { mask: RING_MASK, WebkitMask: RING_MASK };

export function ScoreRing(props: { value: number | null; children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  const target = clampScore(props.value);
  const progress = useMotionValue(0);

  useEffect(() => {
    if (reduced) {
      progress.set(target);
      return undefined;
    }
    const controls = animate(progress, target, { duration: duration.chart, ease: ease.emphasized, delay: 0.15 });
    return () => controls.stop();
  }, [target, reduced, progress]);

  const cover = useMotionTemplate`conic-gradient(transparent 0 ${progress}%, var(--bg-3) ${progress}% 100%)`;

  return (
    <div data-score-ring="" className={cn('relative grid size-[132px] shrink-0 place-items-center', props.className)}>
      <span
        aria-hidden="true"
        className="absolute inset-0 rounded-full"
        style={{ ...masked, background: `conic-gradient(${SCORE_RAMP[0]}, ${SCORE_RAMP[1]} 55%, ${SCORE_RAMP[2]})` }}
      />
      <motion.span aria-hidden="true" className="absolute inset-0 rounded-full" style={{ ...masked, background: cover }} />
      <span aria-hidden="true" className="absolute inset-[17px] rounded-full border border-border-subtle bg-bg-1/60" />
      <div className="relative flex flex-col items-center gap-0.5 text-center">{props.children}</div>
    </div>
  );
}

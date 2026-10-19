'use client';

/**
 * BorderBeam (design spec §3): a short streak of light that travels around its parent's border.
 * Technique after Magic UI's border-beam (MIT, see THIRD_PARTY_NOTICES.md), re-implemented in CSS:
 * the light rides `offset-path: rect()` and an exclude mask keeps only the border band, so the
 * loop is one offset-distance animation (visual.css) instead of a JS motion loop. Place it inside
 * a `relative` element with a radius; it inherits that radius. aria-hidden, paused offscreen, and
 * a still streak at the top-left corner under reduced motion.
 */
import { useRef, type CSSProperties } from 'react';
import { cn } from '@/components/ui/cn';
import { useInViewPause } from './use-in-view-pause';
import { usePrefersReducedMotion } from './use-prefers-reduced-motion';

export function BorderBeam(props: {
  className?: string;
  /** Seconds per lap (default 8, the comet loop). */
  duration?: number;
  /** Seconds to offset the start, so two beams on one card do not overlap. */
  delay?: number;
  /** Leading color of the streak (default the panel hue). */
  colorFrom?: string;
  /** Trailing color before it fades out (default the second panel hue). */
  colorTo?: string;
  /** Streak length in px (default 96). */
  size?: number;
  /** Border width in px (default 1). */
  borderWidth?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  useInViewPause(ref);
  const style = {
    '--beam-width': `${props.borderWidth ?? 1}px`,
    '--beam-size': `${props.size ?? 96}px`,
    '--beam-duration': `${props.duration ?? 8}s`,
    '--beam-delay': `${-(props.delay ?? 0)}s`,
    '--beam-from': props.colorFrom ?? 'var(--panel-hue)',
    '--beam-to': props.colorTo ?? 'var(--panel-hue-2)',
  } as CSSProperties;
  return (
    <div ref={ref} aria-hidden="true" data-visual-motion="beam" style={style} className={cn('visual-beam', props.className)}>
      <div className="visual-beam__light" data-motion={reduced ? 'static' : undefined} />
    </div>
  );
}

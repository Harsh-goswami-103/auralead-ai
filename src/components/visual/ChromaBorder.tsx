'use client';

/**
 * ChromaBorder (design spec §3, color report "chromatic comet border"): a 1px conic comet that
 * circles the wrapped card; a blurred copy of the ring behind the card is its halo. The angle is
 * the registered `--chroma-angle` property (visual.css), interpolated in oklab so the ice-to-flare
 * segment never passes through AI violet. One per view at most. Paused offscreen; under reduced
 * motion it rests as a static ring with the comet at the top right. Give the child the same radius.
 */
import { useRef, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/components/ui/cn';
import { useInViewPause } from './use-in-view-pause';
import { usePrefersReducedMotion } from './use-prefers-reduced-motion';

export function ChromaBorder(props: { children: ReactNode; className?: string; radius?: number | string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  useInViewPause(ref);
  const style: CSSProperties | undefined =
    props.radius === undefined ? undefined : { borderRadius: typeof props.radius === 'number' ? `${props.radius}px` : props.radius };
  return (
    <div
      ref={ref}
      data-visual-motion="chroma"
      data-motion={reduced ? 'static' : undefined}
      style={style}
      className={cn('visual-chroma rounded-xl', props.className)}
    >
      <span aria-hidden="true" className="visual-chroma__halo" />
      {props.children}
    </div>
  );
}

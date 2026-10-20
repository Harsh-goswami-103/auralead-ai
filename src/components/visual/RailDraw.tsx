'use client';

/**
 * A decorative rail that draws itself once from its start edge (a clip reveal at an even pace, so
 * steps placed along it can arrive exactly as it reaches them), for stepper rails such as the
 * pipeline. One-shot, never on refresh (the node is kept across server re-renders). With `inView`
 * it waits until the rail scrolls into view, so a rail below the fold is not drawn offscreen.
 * Under reduced motion it rests at full length at once (zero-length transition, no in-view wait).
 * aria-hidden: the steps carry the meaning.
 */
import { motion } from 'motion/react';
import { duration } from '@/components/motion/presets';
import { cn } from '@/components/ui/cn';
import { usePrefersReducedMotion } from './use-prefers-reduced-motion';

export function RailDraw(props: { className?: string; delay?: number; seconds?: number; inView?: boolean }) {
  const reduced = usePrefersReducedMotion();
  // A clip reveal (not scaleX), so the gradient stays in place while the line grows.
  const target = { clipPath: 'inset(0 0% 0 0)' };
  const trigger = props.inView && !reduced ? { whileInView: target, viewport: { once: true, margin: '0px 0px -40px 0px' } } : { animate: target };
  return (
    <motion.span
      aria-hidden="true"
      initial={{ clipPath: 'inset(0 100% 0 0)' }}
      {...trigger}
      transition={reduced ? { duration: 0 } : { duration: props.seconds ?? duration.enter, ease: 'linear', delay: props.delay ?? 0.1 }}
      className={cn('block size-full rounded-full', props.className)}
    />
  );
}

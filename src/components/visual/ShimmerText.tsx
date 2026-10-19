/**
 * ShimmerText (design spec §3): a light band sweeping across text-2 text, ONLY for states that
 * are genuinely in progress ("Sending...", "Syncing sheet..."), always next to a spinner icon and
 * the label. Never on numbers. The text stays real text for assistive tech; the resting color is
 * text-2 (AA), which is all that shows under reduced motion or forced colors. Server-safe, CSS.
 */
import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export function ShimmerText(props: { children: ReactNode; className?: string }) {
  return (
    <span data-visual-motion="shimmer" className={cn('visual-shimmer-text', props.className)}>
      {props.children}
    </span>
  );
}

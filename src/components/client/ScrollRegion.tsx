/**
 * A horizontal scroller for a wide table (design spec §6 "relative overflow-x-auto wrappers"):
 * `relative` so sr-only text inside the table cannot widen the page, and a labelled, focusable
 * region so keyboard users can scroll it when it overflows (axe scrollable-region-focusable).
 * Server-safe.
 */
import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export function ScrollRegion(props: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="region" aria-label={props.label} tabIndex={0} className={cn('relative overflow-x-auto rounded-md focus-visible:outline-offset-2', props.className)}>
      {props.children}
    </div>
  );
}
